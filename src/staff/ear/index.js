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

const DEFAULTS = {
  TICK_MS: 2 * 60 * 1000,
  SAMPLE_BYTES: 8 * 1024,
  CONFIRM_TICKS: 2,
  // MP3-encoded audio carries enough variance that even the quiet
  // sections will exceed this. True dead air sits near 0.
  SILENCE_VARIANCE_THRESHOLD: 50,
};

function readEnvMs(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

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

function bootEar(deps) {
  const STREAM_URL = deps.streamUrl;
  const ALERTS_FILE = deps.alertsFile;
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "ear-state.json");

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
    }
  } catch (err) { console.warn(`[ear] state load: ${err.message}`); }

  function persist() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ silentAlerted: e.silentAlerted }, null, 2)); }
    catch (err) { console.warn(`[ear] state save: ${err.message}`); }
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
    if (!r.ok || !r.buf) {
      // No bytes — leave the Watcher to handle that case; Ear only
      // cares about silence within otherwise-flowing audio.
      e.lastStats = { ok: false, error: r.error || `HTTP ${r.status}` };
      return;
    }
    const stats = bufferStats(r.buf);
    e.lastStats = { ok: true, bytes: r.buf.length, ...stats };
    const isSilent = stats.allZero || stats.variance < cfg.silenceThreshold;
    if (isSilent) {
      e.silentStreak += 1;
      if (e.silentStreak >= cfg.confirmTicks && !e.silentAlerted) {
        logAlert("EAR_STREAM_SILENT", `${e.silentStreak} consecutive silent samples (variance=${stats.variance.toFixed(1)}) — dead air`);
        e.silentAlerted = true;
      }
    } else {
      if (e.silentAlerted) {
        logAlert("EAR_STREAM_RECOVERED", `audio back (variance=${stats.variance.toFixed(1)})`);
      }
      e.silentStreak = 0;
      e.silentAlerted = false;
    }
    persist();
  }

  setTimeout(() => { tick().catch((err) => console.warn(`[ear] first tick: ${err.message}`)); }, 75_000);
  setInterval(() => { tick().catch((err) => console.warn(`[ear] tick: ${err.message}`)); }, cfg.tickMs);

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

module.exports = { bootEar };
