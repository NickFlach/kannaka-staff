/**
 * Ear — Phase 4 (ADR-001 § 5), silence-detector MVP.
 *
 * The full Ear role calls kannaka-hear on /stream slices and routes
 * perception features into HRM + the Floor. That's substantial. For
 * tonight we ship the catch-the-bad-day half: dead-air detection.
 *
 * Tick (default 2 min):
 *   - GET /stream, sample first 8 KB after the icy headers.
 *   - Run a cheap silence heuristic on the sample (variance below a
 *     threshold = silence; all-zero buffer = definite silence).
 *   - Edge-trigger EAR_STREAM_SILENT after N consecutive silent ticks
 *     (default 2 — that's ~4 min of confirmed silence, which is well
 *     past any oration pause).
 *   - EAR_STREAM_RECOVERED when a tick comes back with normal audio.
 *
 * The 8 KB cap keeps the probe cheap (we kill the connection after
 * the first chunk; Icecast is fine with that). The variance heuristic
 * is intentionally crude — we're not transcribing, just smelling for
 * dead air the Watcher's HTTP-200 check can't catch.
 *
 * Routes:
 *   GET /api/ear
 */
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const url = require("url");

const { readEnvMs } = require("../util");

const DEFAULTS = {
  TICK_MS: 2 * 60 * 1000,
  SAMPLE_BYTES: 8 * 1024,
  CONFIRM_TICKS: 2,
  // MP3-encoded audio carries enough variance that even the quiet
  // sections will exceed this. True dead air sits near 0.
  SILENCE_VARIANCE_THRESHOLD: 50,
};

function sampleStream(target, sampleBytes, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const u = url.parse(target);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: { "User-Agent": "kannaka-staff-ear/0.1" },
      timeout: timeoutMs,
    }, (res) => {
      let collected = 0;
      const chunks = [];
      res.on("data", (c) => {
        chunks.push(c);
        collected += c.length;
        if (collected >= sampleBytes) {
          req.destroy();
        }
      });
      res.on("end", () => resolve({ ok: res.statusCode < 400, status: res.statusCode, buf: Buffer.concat(chunks).slice(0, sampleBytes) }));
      res.on("close", () => resolve({ ok: res.statusCode < 400, status: res.statusCode, buf: Buffer.concat(chunks).slice(0, sampleBytes) }));
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function bufferStats(buf) {
  if (buf.length === 0) return { allZero: true, variance: 0, mean: 0 };
  let allZero = true;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) allZero = false;
    sum += buf[i];
  }
  const mean = sum / buf.length;
  let variance = 0;
  for (let i = 0; i < buf.length; i++) {
    const d = buf[i] - mean;
    variance += d * d;
  }
  variance /= buf.length;
  return { allZero, variance, mean };
}

/**
 * Advance the dead-air streak by one observation (exported for tests).
 *
 * `sampleOk: false` means the fetch failed — that is the ABSENCE of an
 * observation, not a silent one, so it breaks the streak. Carrying the
 * count across such a gap let a silent tick, a transport failure, and
 * another silent tick add up to "N consecutive silent samples" on two
 * observations minutes apart, firing the auto-recover radio restart.
 */
function nextSilentState({ silentStreak, silentAlerted, sampleOk, isSilent, confirmTicks }) {
  if (!sampleOk) {
    return { silentStreak: 0, silentAlerted, alert: null };
  }
  if (isSilent) {
    const streak = silentStreak + 1;
    if (streak >= confirmTicks && !silentAlerted) {
      return { silentStreak: streak, silentAlerted: true, alert: "EAR_STREAM_SILENT" };
    }
    return { silentStreak: streak, silentAlerted, alert: null };
  }
  return {
    silentStreak: 0,
    silentAlerted: false,
    alert: silentAlerted ? "EAR_STREAM_RECOVERED" : null,
  };
}

function bootEar(deps) {
  const STREAM_URL = deps.streamUrl;
  const ALERTS_FILE = deps.alertsFile;
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "ear-state.json");
  const bus = deps.staffBus || null;

  function publish(subject, payload) {
    if (!bus) return;
    bus.emit(subject, { ts: Date.now(), source: "ear", subject, payload });
  }

  const cfg = {
    tickMs: readEnvMs("EAR_TICK_MS", DEFAULTS.TICK_MS),
    sampleBytes: parseInt(process.env.EAR_SAMPLE_BYTES || "", 10) || DEFAULTS.SAMPLE_BYTES,
    confirmTicks: parseInt(process.env.EAR_CONFIRM_TICKS || "", 10) || DEFAULTS.CONFIRM_TICKS,
    silenceThreshold: parseFloat(process.env.EAR_SILENCE_VARIANCE || "") || DEFAULTS.SILENCE_VARIANCE_THRESHOLD,
    enabled: process.env.EAR_ENABLED !== "false",
  };

  const e = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    silentStreak: 0,
    silentAlerted: false,
    lastStats: null,
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (typeof persisted.silentAlerted === "boolean") e.silentAlerted = persisted.silentAlerted;
      // An in-progress streak is real evidence and should survive a
      // restart — otherwise a restart mid-outage resets the count and the
      // dead-air alert is pushed another confirmTicks into the future.
      // Only carry it if it is recent: a streak from a staff process that
      // died days ago says nothing about the stream right now.
      if (typeof persisted.silentStreak === "number" && persisted.silentStreak > 0) {
        const age = Date.now() - (persisted.silentStreakAt || 0);
        if (age >= 0 && age < cfg.tickMs * 5) e.silentStreak = persisted.silentStreak;
      }
    }
  } catch (err) { console.warn(`[ear] state load: ${err.message}`); }

  function persist() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        silentAlerted: e.silentAlerted,
        silentStreak: e.silentStreak,
        silentStreakAt: Date.now(),
      }, null, 2));
    } catch (err) { console.warn(`[ear] state save: ${err.message}`); }
  }
  function logAlert(transition, message) {
    const entry = { ts: new Date().toISOString(), probe: "ear", transition, message };
    try { fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n"); }
    catch (err) { console.warn(`[ear] alert write: ${err.message}`); }
    console.log(`[ear] ${transition}: ${message}`);
  }

  async function tick() {
    if (!cfg.enabled) return;
    const r = await sampleStream(STREAM_URL, cfg.sampleBytes);
    e.lastTick = Date.now();
    const sampleOk = !!(r.ok && r.buf);
    const stats = sampleOk ? bufferStats(r.buf) : null;
    const isSilent = sampleOk && (stats.allZero || stats.variance < cfg.silenceThreshold);
    e.lastStats = sampleOk
      ? { ok: true, bytes: r.buf.length, ...stats }
      // No bytes — leave the Watcher to handle that case; Ear only
      // cares about silence within otherwise-flowing audio.
      : { ok: false, error: r.error || `HTTP ${r.status}` };

    const prevStreak = e.silentStreak;
    const s = nextSilentState({
      silentStreak: e.silentStreak,
      silentAlerted: e.silentAlerted,
      sampleOk,
      isSilent,
      confirmTicks: cfg.confirmTicks,
    });
    e.silentStreak = s.silentStreak;
    e.silentAlerted = s.silentAlerted;

    if (!sampleOk && prevStreak > 0) {
      console.log(`[ear] sample failed (${e.lastStats.error}) — resetting silent streak of ${prevStreak}`);
    }
    if (s.alert === "EAR_STREAM_SILENT") {
      logAlert("EAR_STREAM_SILENT", `${s.silentStreak} consecutive silent samples (variance=${stats.variance.toFixed(1)}) — dead air`);
      // Notify other staff roles (per ADR-003). Watcher subscribes
      // to this subject for the stuck-stream auto-recover loop.
      publish("KANNAKA.staff.stream.silent", {
        silentStreak: s.silentStreak,
        variance: stats.variance,
        mean: stats.mean,
        sampleBytes: r.buf.length,
      });
    } else if (s.alert === "EAR_STREAM_RECOVERED") {
      logAlert("EAR_STREAM_RECOVERED", `audio back (variance=${stats.variance.toFixed(1)})`);
      publish("KANNAKA.staff.stream.recovered", { variance: stats.variance });
    }
    persist();
  }

  // unref'd so these never hold the event loop open on their own — the
  // HTTP listener does that in production, and a bootEar() in a test
  // must not keep the runner alive or reach a live /stream fetch.
  setTimeout(() => { tick().catch((err) => console.warn(`[ear] first tick: ${err.message}`)); }, 75_000).unref();
  setInterval(() => { tick().catch((err) => console.warn(`[ear] tick: ${err.message}`)); }, cfg.tickMs).unref();

  return {
    getState() {
      return {
        cfg,
        bootedAt: e.bootedAt,
        lastTick: e.lastTick,
        silentStreak: e.silentStreak,
        silentAlerted: e.silentAlerted,
        lastStats: e.lastStats,
      };
    },
    tick,
  };
}

module.exports = { bootEar, nextSilentState };
