#!/usr/bin/env node
/**
 * kannaka-staff — Phase 1: Watcher + Growth
 *
 * Single Node.js service hosting the staff crew. Each role lives in
 * src/staff/<role>/ and boots from this entry. Two crew members live:
 *
 *   - Watcher (this file)  — 60s tick, 18+ probes, alert log + dashboard
 *   - Growth (src/staff/growth) — 15min tick, schedules dream
 *     consolidation, watches HRM size, persists last-dream state
 *
 * Probes (the health checks):
 *
 * Probes (the health checks):
 *   - radio_service       — kannaka-radio.service is active (systemctl)
 *   - radio_now_playing   — /api/now-playing returns 200 + non-empty title
 *   - radio_track_advancing — track has changed in the last 12 minutes
 *                             (catches stuck-track / dead-stream-but-active-service)
 *   - stream_responsive   — /stream returns audio bytes (HEAD 200)
 *   - observatory_service — kannaka-observatory.service is active
 *   - observatory_serving — observatory http responds with consciousness shape
 *   - swarm_serve_service — kannaka-swarm-serve.service is active
 *   - hrm_size            — kannaka.hrm < HRM_SIZE_ALERT_MB
 *   - nats_reachable      — TCP connect to swarm NATS
 *
 * State changes (ok→fail, fail→ok) are logged to alerts.jsonl and
 * surfaced on the dashboard. The dashboard polls /api/state every 10s.
 *
 * Growth emits its own transitions (GROWTH_DREAM_START, _DONE,
 * _FAILED, GROWTH_HRM_BLOATED, GROWTH_HRM_RECOVERED) into the same
 * alerts.jsonl, so the operator only watches one stream.
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec, execFile } = require("child_process");
const net = require("net");
const url = require("url");
const crypto = require("crypto");
const { EventEmitter } = require("events");

// staffBus — per ADR-003, the in-process notification bus that lets
// roles react to each other in real time without going through NATS.
// Subjects use the same KANNAKA.staff.<verb>.<resource> namespace so
// the wiring transposes cleanly if we ever extract roles to separate
// processes. Every event has shape {ts, source, subject, payload}.
const staffBus = new EventEmitter();
staffBus.setMaxListeners(64);

// busRing — ring buffer of the last N events for dashboard
// observability (ADR-003 § Open Questions). Without this, closed
// loops fire silently and you can't tell whether a handler chose
// not to act (cooldown, no starving albums, etc) — only that an
// auto-action either fired or didn't. The ring buffer captures
// every publication so the operator can see the predicate evaluation.
const BUS_RING_MAX = 100;
const busRing = [];
// Intercept emits on the bus by wrapping emit. The original emit
// is preserved for handlers to receive normally.
const _busEmit = staffBus.emit.bind(staffBus);
staffBus.emit = function (subject, event) {
  // Only ring our own KANNAKA.* subjects — EventEmitter has internal
  // events (newListener, removeListener, error) we shouldn't log.
  if (typeof subject === "string" && subject.startsWith("KANNAKA.")) {
    busRing.push({
      ts: (event && event.ts) || Date.now(),
      source: (event && event.source) || "?",
      subject,
      // Stringify payload defensively — small payloads only.
      summary: (() => {
        try {
          const s = JSON.stringify((event && event.payload) || {});
          return s.length > 200 ? s.slice(0, 200) + "…" : s;
        } catch { return "(unserializable)"; }
      })(),
    });
    if (busRing.length > BUS_RING_MAX) busRing.shift();
  }
  return _busEmit(subject, event);
};

const { bootGrowth } = require("./staff/growth");
const { bootCurator } = require("./staff/curator");
const { bootDistributor } = require("./staff/distributor");
const { bootCreator } = require("./staff/creator");
const { bootMarketer } = require("./staff/marketer");
const { bootVoice } = require("./staff/voice");
const { bootEar } = require("./staff/ear");
const { bootStoryteller } = require("./staff/storyteller");

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || (process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "8889"), 10) || 8889;
const TICK_MS = 60_000;
const ALERTS_FILE = process.env.STAFF_ALERTS_FILE || path.join(__dirname, "..", "alerts.jsonl");
const HRM_PATH = process.env.STAFF_HRM_PATH || path.join(process.env.HOME || "/home/opc", ".kannaka", "kannaka.hrm");
const HRM_SIZE_ALERT_MB = 80; // current is 60 MB; alert when it crosses 80 MB
const RADIO_BASE = process.env.STAFF_RADIO_BASE || "http://localhost:8888";
const STREAM_URL = process.env.STAFF_STREAM_URL || "https://radio.ninja-portal.com/stream";
const OBSERVATORY_BASE = process.env.STAFF_OBSERVATORY_BASE || "http://localhost:3334";
const NATS_HOST = process.env.STAFF_NATS_HOST || "swarm.ninja-portal.com";
const NATS_PORT = parseInt(process.env.STAFF_NATS_PORT || "4222", 10);
const TRACK_STALL_MS = 12 * 60_000; // 12 min — covers longest tracks + voice-pause overhead

// ── State ───────────────────────────────────────────────────
const state = {
  startedAt: Date.now(),
  lastTick: null,
  probes: {}, // {name: {ok, message, ts, lastChangeAt, history: [latest 5]}}
  trackTracker: { lastTitle: null, lastChangeTs: Date.now() },
};

// ── Probes ──────────────────────────────────────────────────
function probeSystemd(unitName) {
  return new Promise((resolve) => {
    exec(`systemctl is-active ${unitName}`, { timeout: 5000 }, (err, stdout) => {
      const status = (stdout || "").trim();
      resolve({
        ok: status === "active",
        message: status || (err ? err.message : "no output"),
      });
    });
  });
}

function probeHttp(target, opts = {}) {
  return new Promise((resolve) => {
    const u = url.parse(target);
    const lib = u.protocol === "https:" ? https : http;
    // Probes default to a small body cap (2KB) — enough for status lines.
    // Curator-style fetches that need full JSON bodies override via
    // opts.maxBody. Default cap kept at 2000 chars for the small probes.
    const maxBody = opts.maxBody != null ? opts.maxBody : 2000;
    const req = lib.request({
      method: opts.method || "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      timeout: opts.timeout || 5000,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (c) => {
        bytes += c.length;
        chunks.push(c);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, maxBody);
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        resolve({ ok, status: res.statusCode, body, bytes });
      });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.end();
  });
}

// Stream-specific probe: GET, sample first 4KB, then kill the connection.
// Icecast returns 400 on HEAD, so we have to confirm liveness by actually
// pulling audio bytes — a couple KB is plenty to know it's serving.
function probeStreamHead(target, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const u = url.parse(target);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: { "User-Agent": "kannaka-staff-watcher/0.1", "Icy-MetaData": "1" },
      timeout: timeoutMs,
    }, (res) => {
      let bytes = 0;
      const status = res.statusCode;
      const ok = status >= 200 && status < 300;
      if (!ok) {
        res.resume();
        resolve({ ok: false, status, bytes: 0 });
        return;
      }
      res.on("data", (c) => {
        bytes += c.length;
        if (bytes >= 4096) {
          res.destroy();
          resolve({ ok: true, status, bytes });
        }
      });
      res.on("end", () => resolve({ ok: bytes > 0, status, bytes }));
      res.on("close", () => { /* settle handled above */ });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function probeTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const finish = (ok, msg) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ ok, message: msg });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, `connected ${host}:${port}`));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (e) => finish(false, e.message));
    socket.connect(port, host);
  });
}

// ADR-003 Probe 1 — count kannaka-radio processes. The 2026-05-05 PH
// launch incident had two competing radio nodes (PM2 + systemd); the
// existing radio_service probe returned green because one was systemd-
// managed. This probe asks the right question: how many.
//
// systemd hardening hides /proc/<pid>/cwd from other processes, so we
// match on the exact cmdline. The cmdline `node server/index.js --port
// 8888` is unique to the radio (staff is on 8889, observatory on 3334).
function probeRadioSingleton() {
  return new Promise((resolve) => {
    exec("pgrep -f 'node server/index.js --port 8888'", { timeout: 5000 }, (_err, stdout) => {
      const pids = (stdout || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      if (pids.length === 0) {
        resolve({ ok: false, message: "no radio process matched cmdline" });
      } else if (pids.length === 1) {
        resolve({ ok: true, message: `1 process (pid=${pids[0]})` });
      } else {
        resolve({ ok: false, message: `DUPLICATE: ${pids.length} processes — pids ${pids.join(", ")}` });
      }
    });
  });
}

// ADR-003 Probe 2 — radio_port_alive. systemd reports active when the
// node process is alive even if the HTTP server died inside the node.
// Composite check: service active AND TCP port bound. Catches the
// silent HTTP-server death pattern that caused the SPA's recently-
// played panel to go stale on launch day.
async function probeRadioPortAlive() {
  const sysd = await probeSystemd("kannaka-radio.service");
  if (!sysd.ok) return { ok: false, message: `service not active: ${sysd.message}` };
  const tcp = await probeTcp("127.0.0.1", 8888, 3000);
  if (!tcp.ok) {
    return {
      ok: false,
      message: "service active but port 8888 silent — http server died inside node, restart needed",
    };
  }
  return { ok: true, message: "service active + port 8888 bound" };
}

// ADR-003 Probe 3 — metadata mount alignment. icecast-metadata.js
// defaults to /preview but the public SPA points listeners at /stream.
// Without `export ICECAST_MOUNT=/stream` in run-radio.sh, listeners see
// blank Now-Playing forever. Probe reads run-radio.sh directly (proc/
// environ is hidden by systemd hardening).
function probeMetadataMountAlignment() {
  return new Promise((resolve) => {
    require("fs").readFile("/home/opc/run-radio.sh", "utf8", (err, content) => {
      if (err) return resolve({ ok: false, message: `cannot read run-radio.sh: ${err.message}` });
      const m = content.match(/^\s*export\s+ICECAST_MOUNT=(\S+)/m);
      const mount = m ? m[1].replace(/['"]/g, "") : "/preview";
      if (mount !== "/stream") {
        return resolve({ ok: false, message: `ICECAST_MOUNT=${mount} but listeners are on /stream` });
      }
      resolve({ ok: true, message: `ICECAST_MOUNT=${mount}` });
    });
  });
}

// ADR-003 Probe 4 — stream_metadata_advancing. Polls icecast status-json
// every tick. Tracks /stream title + last change time. Alert if listeners
// >0 and title hasn't advanced in TRACK_STALL_MS. Catches dj-engine
// stalls, source-disconnect-without-restart, and metadata-writer death.
const _streamTracker = { title: null, lastChangeAt: 0 };
async function probeStreamMetadataAdvancing() {
  const r = await probeHttp("http://127.0.0.1:8000/status-json.xsl", { timeout: 5000 });
  if (!r.ok) return { ok: false, message: `icecast status-json: ${r.message || r.status}` };
  let stream;
  try {
    const d = JSON.parse(r.body).icestats;
    const sources = Array.isArray(d.source) ? d.source : d.source ? [d.source] : [];
    stream = sources.find((s) => (s.listenurl || "").endsWith("/stream"));
  } catch (e) {
    return { ok: false, message: `parse error: ${e.message}` };
  }
  if (!stream) return { ok: false, message: "/stream mount not found in icecast status" };
  const title = stream.title || "";
  const listeners = stream.listeners || 0;
  const now = Date.now();
  if (title !== _streamTracker.title) {
    _streamTracker.title = title;
    _streamTracker.lastChangeAt = now;
  }
  const stallMs = now - _streamTracker.lastChangeAt;
  if (stallMs > TRACK_STALL_MS && listeners > 0) {
    return {
      ok: false,
      message: `title unchanged ${Math.round(stallMs / 60000)}m: "${title}" (${listeners} listener${listeners === 1 ? "" : "s"})`,
    };
  }
  return {
    ok: true,
    message: `"${title || "(no title)"}" — ${listeners} listener${listeners === 1 ? "" : "s"} — ${Math.round(stallMs / 1000)}s since last change`,
  };
}

// ADR-003 Probe 5 — podcast_files_playable. Walks the podcast dir and
// runs ffprobe on each .mp3, checking sample_rate=44100 and
// bit_rate<=192000. Files outside the envelope crash the radio's
// pipe-fed ffmpeg the instant they're played; the podcast scheduler
// then reports "all episodes finished" 5s in. Caught the 2026-05-06
// 10:00 AM CST silent-podcast bug retroactively. Hourly probe.
const PODCAST_DIR = "/home/opc/kannaka-radio/music/Ghost Signals Podcast";
let _lastPodcastProbeAt = 0;
let _lastPodcastResult = { ok: true, message: "not yet probed" };
async function probePodcastFilesPlayable() {
  const now = Date.now();
  // Asymmetric cooldown: 1h when healthy (ffprobe is cheap but not free,
  // and once we've green-lit the dir nothing changes file-by-file), but
  // only 5 min when failing — Nick fixed the bad files 2026-05-14 and
  // the dashboard kept saying broken for nearly an hour because the
  // healthy-state cache window was applied to the failed state too.
  const cooldown = _lastPodcastResult.ok ? 60 * 60 * 1000 : 5 * 60 * 1000;
  if (now - _lastPodcastProbeAt < cooldown) return _lastPodcastResult;
  _lastPodcastProbeAt = now;
  const fs = require("fs");
  const path = require("path");
  if (!fs.existsSync(PODCAST_DIR)) {
    _lastPodcastResult = { ok: true, message: "no podcast dir" };
    return _lastPodcastResult;
  }
  const files = fs
    .readdirSync(PODCAST_DIR)
    .filter((f) => f.endsWith(".mp3") && !f.endsWith(".original.mp3"));
  if (files.length === 0) {
    _lastPodcastResult = { ok: true, message: "no podcast files" };
    return _lastPodcastResult;
  }
  const bad = [];
  for (const f of files) {
    const p = path.join(PODCAST_DIR, f);
    const out = await new Promise((res) =>
      exec(
        `ffprobe -v error -show_entries stream=sample_rate,bit_rate -of default=noprint_wrappers=1 ${JSON.stringify(p)}`,
        { timeout: 8000 },
        (_e, o) => res(o || ""),
      ),
    );
    const sr = (out.match(/sample_rate=(\d+)/) || [])[1];
    const br = (out.match(/bit_rate=(\d+)/) || [])[1];
    if (sr !== "44100" || (br && parseInt(br, 10) > 192000)) {
      bad.push(`${f} (sr=${sr || "?"} br=${br || "?"})`);
    }
  }
  if (bad.length > 0) {
    _lastPodcastResult = { ok: false, message: `${bad.length} podcast file(s) outside envelope: ${bad.join("; ")}` };
  } else {
    _lastPodcastResult = { ok: true, message: `${files.length} podcast file(s) within envelope (44.1kHz, ≤192kbps)` };
  }
  return _lastPodcastResult;
}

// External observer mode: when STAFF_OBSERVER_MODE=external, skip the
// local-only probes (systemd, pgrep, file reads, ffprobe of podcast files)
// because they always-fail on a remote box that doesn't host the radio.
// HTTP/icecast probes still run since they go over the public URL. This
// lets a second Oracle box act as an out-of-process witness without the
// dashboard being a sea of red.
const EXTERNAL_MODE = (process.env.STAFF_OBSERVER_MODE || "").toLowerCase() === "external";

async function runAllProbes() {
  const ts = Date.now();
  const results = {};

  // 1. kannaka-radio.service (local-only)
  if (!EXTERNAL_MODE) {
    const r = await probeSystemd("kannaka-radio.service");
    results.radio_service = { ok: r.ok, message: r.message, ts };
  }

  // 1a. radio_singleton — flag duplicate radio processes (ADR-003 Probe 1, local-only)
  if (!EXTERNAL_MODE) {
    const r = await probeRadioSingleton();
    results.radio_singleton = { ok: r.ok, message: r.message, ts };
  }

  // 1b. radio_port_alive — flag service-alive-but-port-silent (ADR-003 Probe 2, local-only)
  if (!EXTERNAL_MODE) {
    const r = await probeRadioPortAlive();
    results.radio_port_alive = { ok: r.ok, message: r.message, ts };
  }

  // 1c. metadata_mount_alignment — ICECAST_MOUNT vs public SPA mount (local-only file read)
  if (!EXTERNAL_MODE) {
    const r = await probeMetadataMountAlignment();
    results.metadata_mount_alignment = { ok: r.ok, message: r.message, ts };
  }

  // 1d. stream_metadata_advancing — needs icecast status-json on :8000
  // which is firewalled to localhost on the radio host. Local-only.
  if (!EXTERNAL_MODE) {
    const r = await probeStreamMetadataAdvancing();
    results.stream_metadata_advancing = { ok: r.ok, message: r.message, ts };
  }

  // 1e. podcast_files_playable — local ffprobe of podcast files
  if (!EXTERNAL_MODE) {
    const r = await probePodcastFilesPlayable();
    results.podcast_files_playable = { ok: r.ok, message: r.message, ts };
  }

  // 2. radio_now_playing
  let npTitle = null;
  {
    const r = await probeHttp(`${RADIO_BASE}/api/now-playing`);
    let title = null;
    if (r.ok) {
      try { title = JSON.parse(r.body).title; } catch (_) {}
    }
    npTitle = title;
    results.radio_now_playing = {
      ok: r.ok && !!title,
      message: r.ok ? `"${title || "(no title)"}"` : `${r.status || 0} ${r.error || ""}`,
      ts,
    };
  }

  // 3. radio_track_advancing — title changed in last TRACK_STALL_MS
  {
    if (npTitle && npTitle !== state.trackTracker.lastTitle) {
      state.trackTracker.lastTitle = npTitle;
      state.trackTracker.lastChangeTs = ts;
    }
    const sinceChange = ts - state.trackTracker.lastChangeTs;
    const ok = sinceChange < TRACK_STALL_MS;
    results.radio_track_advancing = {
      ok,
      message: ok
        ? `last changed ${Math.round(sinceChange / 1000)}s ago → ${state.trackTracker.lastTitle}`
        : `track stuck for ${Math.round(sinceChange / 1000)}s on ${state.trackTracker.lastTitle}`,
      ts,
    };
  }

  // 4. stream_responsive — GET first kilobyte then abort. Icecast
  // refuses HEAD with 400, so we use GET but kill the connection
  // after we've confirmed audio bytes are flowing.
  {
    const r = await probeStreamHead(STREAM_URL, 4000);
    results.stream_responsive = {
      ok: r.ok,
      message: r.ok ? `HTTP ${r.status} (${r.bytes}B sampled)` : `HTTP ${r.status || 0} ${r.error || ""}`,
      ts,
    };
  }

  // 5. observatory_service (local-only)
  if (!EXTERNAL_MODE) {
    const r = await probeSystemd("kannaka-observatory.service");
    results.observatory_service = { ok: r.ok, message: r.message, ts };
  }

  // 6a. consciousness_fresh — kannaka-prime is publishing to KANNAKA.consciousness
  // recently. Stale (>12h) = the dream-cycle is blocked AND no consciousness
  // updates are flowing (the 2026-05-02 outage we lived through). Hardening
  // priority #3 from consciousness-core/docs/dependency-map.md.
  {
    const r = await probeHttp(`${RADIO_BASE}/api/state`, { timeout: 5000, maxBody: 200 * 1024 });
    let ageMs = null;
    if (r.ok) {
      try {
        const j = JSON.parse(r.body);
        const ts = (j.swarm || {}).consciousness?.timestamp;
        if (ts) ageMs = Date.now() - ts;
      } catch (_) {}
    }
    const stale = ageMs == null || ageMs > 12 * 60 * 60 * 1000;
    results.consciousness_fresh = {
      ok: !stale,
      message: ageMs == null
        ? "no consciousness publish observed (yet?)"
        : `${(ageMs / 60000).toFixed(0)}m old${stale ? " — exceeds 12h threshold" : ""}`,
      ts,
    };
  }

  // 6. observatory_serving — has the consciousness shape (queen.phi, etc.)
  // /api/state on the observatory is 4-6 KB; the default probeHttp cap
  // is 2 KB which truncates before queen.phi and the JSON parse falls
  // through to shapeOk=false. Bump maxBody to fit the response.
  {
    const r = await probeHttp(`${OBSERVATORY_BASE}/api/state`, { timeout: 5000, maxBody: 200 * 1024 });
    let shapeOk = false;
    let phiVal = "?";
    if (r.ok) {
      try {
        const j = JSON.parse(r.body);
        const queen = (j.swarm || {}).queen || {};
        phiVal = queen.phi != null ? String(queen.phi) : "?";
        shapeOk = "phi" in queen;
      } catch (_) {}
    }
    results.observatory_serving = {
      ok: r.ok && shapeOk,
      message: r.ok ? `queen.phi=${phiVal}` : `${r.status || 0} ${r.error || ""}`,
      ts,
    };
  }

  // 7. swarm_serve_service (local-only)
  if (!EXTERNAL_MODE) {
    const r = await probeSystemd("kannaka-swarm-serve.service");
    results.swarm_serve_service = { ok: r.ok, message: r.message, ts };
  }

  // 7b. listener_count — track active stream listeners. Alert when
  // the count drops to 0 for an extended window while the stream is
  // supposedly serving (icecast still 200, dj-engine still advancing).
  // That pattern usually means the audio sink got disconnected and
  // listeners can't actually hear anything even though every other
  // probe is green. We accept counts of 0 as "ok" because nighttime
  // dips are normal; the alert is the persistence of zero across the
  // hysteresis window, same as other probes.
  {
    const r = await probeHttp(`${RADIO_BASE}/api/state`, { timeout: 5000, maxBody: 8 * 1024 });
    if (r.ok) {
      let count = null;
      try {
        const s = JSON.parse(r.body);
        const v = s.listeners ?? s.listenerCount ?? s.listener_count;
        if (typeof v === "number") count = v;
        else if (v && typeof v === "object" && typeof v.total === "number") count = v.total;
      } catch (_) { /* leave count null on parse failure */ }
      results.listener_count = {
        ok: count == null ? false : count > 0,
        message: count == null ? "listener field absent" : `${count} active`,
        ts,
      };
    } else {
      results.listener_count = { ok: false, message: `HTTP ${r.status} ${r.error || ""}`, ts };
    }
  }

  // 8. hrm_size — alert if >HRM_SIZE_ALERT_MB (local-only file stat)
  if (!EXTERNAL_MODE) {
    try {
      const stat = fs.statSync(HRM_PATH);
      const sizeMB = stat.size / (1024 * 1024);
      const ok = sizeMB < HRM_SIZE_ALERT_MB;
      results.hrm_size = {
        ok,
        message: `${sizeMB.toFixed(1)} MB${ok ? "" : ` > ${HRM_SIZE_ALERT_MB} MB threshold`}`,
        ts,
      };
    } catch (e) {
      results.hrm_size = { ok: false, message: e.message, ts };
    }
  }

  // 9. nats_reachable
  {
    const r = await probeTcp(NATS_HOST, NATS_PORT, 5000);
    results.nats_reachable = { ok: r.ok, message: r.message, ts };
  }

  // 10. hrm_memory_count — local cache read; only on the host that owns it.
  if (!EXTERNAL_MODE) {
    try {
      const cachePath = path.join(process.env.HOME || "/home/opc", ".kannaka", "status-cache.json");
      if (fs.existsSync(cachePath)) {
        const j = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        const count = j.total_memories || j.memory_count || j.memories || 0;
        const ok = count < 1500;
        results.hrm_memory_count = {
          ok,
          message: `${count} memories${ok ? "" : ` (>1500 threshold — kannaka ask may silent-fail)`}`,
          ts,
        };
      } else {
        results.hrm_memory_count = { ok: false, message: "status.json not found", ts };
      }
    } catch (e) {
      results.hrm_memory_count = { ok: false, message: e.message, ts };
    }
  }

  // 11. obc_reachable — POST hits the OpenBotCity heartbeat endpoint.
  // GET works too but heartbeat is the canonical liveness check.
  {
    const r = await probeHttp("https://api.openbotcity.com/world/heartbeat", { method: "GET", timeout: 8000 });
    results.obc_reachable = {
      ok: r.ok || r.status === 401 || r.status === 403, // auth-required is still "alive"
      message: `HTTP ${r.status || 0} ${r.error || ""}`,
      ts,
    };
  }

  // 12. disk_space — local df. In external mode this reports the OBSERVER's
  // disk, not the radio host's, which is still a useful "the watcher box is
  // healthy" signal — keep it on. Threshold remains 5 GB.
  {
    const r = await new Promise((resolve) => {
      exec("df -BM --output=avail / | tail -1", { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ ok: false, message: err.message });
        const free = parseInt((stdout || "").trim().replace("M", ""), 10);
        if (isNaN(free)) return resolve({ ok: false, message: `parse: ${(stdout || "").trim()}` });
        const ok = free > 5 * 1024; // 5 GB
        resolve({ ok, message: `${(free / 1024).toFixed(1)} GB free${ok ? "" : " (under 5 GB threshold)"}` });
      });
    });
    results.disk_space = { ok: r.ok, message: r.message, ts };
  }

  // 13. anthropic_reachable — the dependency that orations ride.
  // /v1/models is auth-required but returns 401 without a key —
  // we just want to know the API is alive, not run a billable call.
  {
    const r = await probeHttp("https://api.anthropic.com/v1/models", { method: "GET", timeout: 8000 });
    results.anthropic_reachable = {
      ok: r.ok || r.status === 401 || r.status === 403,
      message: `HTTP ${r.status || 0} ${r.error || ""}`,
      ts,
    };
  }

  // 14. agent_reputation_drift — LADDER step 3. Pull the radio's
  // ghostsignals leaderboard and flag any constellation predictor whose
  // reputation has drifted below the floor (default 0.4). When a trader
  // crosses the threshold, write a proposed-improvements.jsonl entry so
  // the human-in-the-loop has a one-line "this agent's domain perception
  // is failing — propose a new probe / new predictor capability" record.
  // For now: surface the failure. Later: have the proposal generator
  // write a draft ADR / probe spec automatically.
  {
    const r = await probeHttp(`${RADIO_BASE}/api/leaderboard?sort=reputation&limit=20`, { timeout: 5000, maxBody: 200 * 1024 });
    let lowest = null;
    let traderCount = 0;
    let belowFloor = [];
    const FLOOR = 0.4;
    if (r.ok) {
      try {
        const j = JSON.parse(r.body);
        const traders = (j.leaderboard || j.traders || j || []).filter((t) =>
          t.id && t.id !== "system" && t.kind === "ai" && t.trades_total > 0
        );
        traderCount = traders.length;
        for (const t of traders) {
          if (t.reputation != null && t.reputation < FLOOR) belowFloor.push(t);
          if (lowest == null || t.reputation < lowest.reputation) lowest = t;
        }
        // Surface proposals for newly-flagged traders (don't double-record
        // the same agent every minute — track in a small state object).
        try {
          state.repProposed = state.repProposed || {};
          for (const t of belowFloor) {
            const cooldownMs = 60 * 60 * 1000; // re-propose at most hourly
            const last = state.repProposed[t.id] || 0;
            if (Date.now() - last < cooldownMs) continue;
            state.repProposed[t.id] = Date.now();
            const proposal = {
              ts: new Date().toISOString(),
              type: "ladder_proposal",
              trader_id: t.id,
              display_name: t.display_name,
              reputation: t.reputation,
              trades_total: t.trades_total,
              trades_won: t.trades_won,
              accuracy: t.accuracy,
              note: `Agent ${t.id} reputation ${t.reputation.toFixed(3)} < floor ${FLOOR}. Propose: review predictor heuristic, or add a new probe that captures the failure mode.`,
            };
            const proposalsFile = path.join(__dirname, "..", "proposed-improvements.jsonl");
            try {
              fs.appendFileSync(proposalsFile, JSON.stringify(proposal) + "\n");
              console.log(`[ladder] proposal written: ${t.id} reputation=${t.reputation.toFixed(3)}`);
            } catch (_) {}
          }
        } catch (_) {}
      } catch (_) {}
    }
    results.agent_reputation_drift = {
      ok: belowFloor.length === 0,
      message: traderCount === 0
        ? "no traders with completed trades yet"
        : belowFloor.length > 0
          ? `${belowFloor.length}/${traderCount} below floor: ${belowFloor.map((t) => `${t.id}=${t.reputation.toFixed(2)}`).join(", ")}`
          : `${traderCount} traders, lowest=${lowest ? lowest.id + "@" + (lowest.reputation || 0).toFixed(2) : "?"}`,
      ts,
    };
  }

  // ── ORC constellation services (local-only — orc-portal + orc-stem
  // are systemd units on the radio host, not externally probable).
  if (!EXTERNAL_MODE) {
    const sysd = await probeSystemd("orc-portal.service");
    const tcp = sysd.ok ? await probeTcp("127.0.0.1", 3002, 3000) : { ok: false, message: "skipped (service inactive)" };
    results.orc_portal = {
      ok: sysd.ok && tcp.ok,
      message: sysd.ok ? (tcp.ok ? `active, port 3002 open` : `active but ${tcp.message}`) : sysd.message,
      ts,
    };
  }
  if (!EXTERNAL_MODE) {
    const sysd = await probeSystemd("orc-stem.service");
    const tcp = sysd.ok ? await probeTcp("127.0.0.1", 3001, 3000) : { ok: false, message: "skipped (service inactive)" };
    results.orc_stem = {
      ok: sysd.ok && tcp.ok,
      message: sysd.ok ? (tcp.ok ? `active, port 3001 open` : `active but ${tcp.message}`) : sysd.message,
      ts,
    };
  }

  return results;
}

// ── Curator: album-staleness audit ──────────────────────────
//
// Uses kannaka-radio's /api/history endpoint to compute per-album
// last-played time. The watcher dashboard surfaces "stale albums"
// (no plays in N hours) so we can see when the rotation is starving
// half the catalog.
async function fetchAlbumStaleness() {
  const r = await probeHttp(`${RADIO_BASE}/api/history?limit=200`, { timeout: 5000, maxBody: 200 * 1024 });
  if (!r.ok) return { ok: false, message: `HTTP ${r.status} ${r.error || ""}`, albums: [] };
  let hist;
  try { hist = JSON.parse(r.body).history || []; }
  catch (e) { return { ok: false, message: `parse: ${e.message}`, albums: [] }; }

  const now = Date.now();
  const lastByAlbum = {};
  const countByAlbum = {};
  for (const h of hist) {
    if (!h.album || h.commercial) continue;
    countByAlbum[h.album] = (countByAlbum[h.album] || 0) + 1;
    if (!lastByAlbum[h.album] || (h.playedAt || 0) > lastByAlbum[h.album]) {
      lastByAlbum[h.album] = h.playedAt || 0;
    }
  }

  // Also fetch the radio's full album list so we can flag albums that
  // never appeared in the last-200 history.
  const stateR = await probeHttp(`${RADIO_BASE}/api/state`, { timeout: 5000, maxBody: 200 * 1024 });
  let allAlbums = [];
  if (stateR.ok) {
    try {
      const s = JSON.parse(stateR.body);
      allAlbums = (s.albums || []).map((a) => a.name || a);
    } catch (_) { /* ignore */ }
  }

  const albums = [];
  for (const album of new Set([...allAlbums, ...Object.keys(lastByAlbum)])) {
    const last = lastByAlbum[album] || 0;
    const ageMs = last ? now - last : null;
    albums.push({
      album,
      lastPlayed: last || null,
      ageMs,
      playsInWindow: countByAlbum[album] || 0,
    });
  }
  // Sort: never-played first (ageMs null), then oldest first.
  albums.sort((a, b) => {
    if (a.ageMs == null && b.ageMs == null) return 0;
    if (a.ageMs == null) return -1;
    if (b.ageMs == null) return 1;
    return b.ageMs - a.ageMs;
  });
  return { ok: true, albums, historyLen: hist.length };
}

// ── Tick loop ───────────────────────────────────────────────
async function tick() {
  let probeResults;
  try {
    probeResults = await runAllProbes();
  } catch (e) {
    console.error(`[staff] probe error: ${e.message}`);
    return;
  }

  // Compare to previous state and log transitions, with hysteresis to
  // damp single-tick flapping. A probe must report failure on 3
  // consecutive ticks before we emit a FAILED transition; a single
  // success is enough to RECOVER. consciousness_fresh especially flaps
  // during the radio's hourly :17 prune-cycle (single-tick miss while
  // the radio restarts), and the noise masks real persistent failures.
  const FAIL_CONFIRM_TICKS = 3;
  for (const [name, current] of Object.entries(probeResults)) {
    const prev = state.probes[name];
    // History — used both for the UI and for hysteresis.
    const history = (prev && prev.history) || [];
    history.push({ ok: current.ok, ts: current.ts });
    if (history.length > 5) history.shift();
    current.history = history;

    // Effective state: a probe is "officially failing" only when the
    // last FAIL_CONFIRM_TICKS are all failures; otherwise effective is
    // ok=true. Single successes recover immediately.
    const prevEffectiveOk = prev ? (prev.effectiveOk !== undefined ? prev.effectiveOk : prev.ok) : true;
    let effectiveOk;
    if (current.ok) {
      effectiveOk = true;
    } else {
      const tail = history.slice(-FAIL_CONFIRM_TICKS);
      const allFailing = tail.length >= FAIL_CONFIRM_TICKS && tail.every(h => !h.ok);
      // If we were already officially failing, stay failing; otherwise
      // only flip after the confirm window fills with failures.
      effectiveOk = prevEffectiveOk ? !allFailing : false;
    }
    current.effectiveOk = effectiveOk;

    if (effectiveOk !== prevEffectiveOk) {
      const transition = effectiveOk ? "RECOVERED" : "FAILED";
      const entry = {
        ts: new Date(current.ts).toISOString(),
        probe: name,
        transition,
        message: current.message,
      };
      console.log(`[staff] ${transition}: ${name} — ${current.message}`);
      try {
        fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n");
      } catch (e) {
        console.warn(`[staff] alert write: ${e.message}`);
      }
      current.lastChangeAt = current.ts;
    } else if (prev) {
      current.lastChangeAt = prev.lastChangeAt || prev.ts;
    } else {
      current.lastChangeAt = current.ts;
    }
    state.probes[name] = current;
  }
  state.lastTick = Date.now();
}

// ── Operations actions ──────────────────────────────────────
async function handleAction(action, query) {
  switch (action) {
    case "restart-radio":
      return execActionLocal("sudo", ["/bin/systemctl", "restart", "kannaka-radio"]);
    case "restart-observatory":
      return execActionLocal("sudo", ["/bin/systemctl", "restart", "kannaka-observatory"]);
    case "trigger-oration": {
      const r = await probeHttp(`${RADIO_BASE}/api/oration/now`, { method: "POST", timeout: 10_000, maxBody: 4096 });
      return { ok: r.ok, status: r.status, body: r.body };
    }
    case "trigger-showcase": {
      const album = (query.album || "BEND THE ARC").toString();
      const duration = parseInt(query.duration || "35", 10);
      const target = `${RADIO_BASE}/api/album/showcase?album=${encodeURIComponent(album)}&duration=${duration}`;
      const r = await probeHttp(target, { method: "POST", timeout: 10_000, maxBody: 4096 });
      return { ok: r.ok, album, duration, status: r.status, body: r.body };
    }
    case "trigger-dream": {
      // Legacy fire-and-forget. Prefer "growth-dream" so the
      // result lands in growth-state.json + alerts.jsonl.
      exec("/home/opc/kannaka-memory/target/release/kannaka dream --mode lite", { timeout: 900_000 }, () => {});
      return { ok: true, kind: "dream", note: "spawned in background; watch hrm_size + observatory_serving probes" };
    }
    case "growth-dream": {
      // Route through Growth so the dream is tracked (in-flight guard,
      // state persistence, alerts.jsonl transition, dashboard timeline).
      if (!growth) return { ok: false, error: "growth not online" };
      const mode = (query.mode === "deep" || query.mode === "lite") ? query.mode : undefined;
      return growth.requestDream(mode, "manual request from dashboard");
    }
    case "distributor-publish": {
      if (!distributor) return { ok: false, error: "distributor not online" };
      const configPath = (query.config || "").toString();
      const skip = (query.skip || "").toString();
      if (!configPath) return { ok: false, error: "missing ?config=<path-to-album-config.json>" };
      return distributor.requestPublish({ configPath, skip });
    }
    case "creator-request": {
      if (!creator) return { ok: false, error: "creator not online" };
      return creator.requestCreate(query);
    }
    case "marketer-post": {
      if (!marketer) return { ok: false, error: "marketer not online" };
      return marketer.postMessage(query);
    }
    case "curator-rescue": {
      // Manual trigger of the auto-rescue loop (skips the
      // KANNAKA.staff.album.starving publish path; still honors the
      // 24h global cooldown — pass ?force=1 to override for one shot).
      if (query.force === "1") AUTO_RESCUE.lastRescueTs = 0;
      return fireRescue("manual operator trigger from dashboard");
    }
    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}

function execActionLocal(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message, stderr: (stderr || "").trim().slice(0, 500) });
      resolve({ ok: true, stdout: (stdout || "").trim().slice(0, 500) });
    });
  });
}

// ── HTTP server ─────────────────────────────────────────────
function recentAlerts(limit = 50) {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return [];
    const lines = fs.readFileSync(ALERTS_FILE, "utf8").trim().split("\n");
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function dashboardHtml() {
  return `<!doctype html><html><head>
<title>kannaka-staff — watcher</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --bg: #06030a; --ok: #4ade80; --fail: #f87171; --ink: #f5f5f7; --dim: #94a3b8; --vio: #a78bfa; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--ink); font-family: 'JetBrains Mono', Consolas, monospace; padding: 24px; max-width: 980px; margin: 0 auto; }
h1 { font-family: Orbitron, sans-serif; font-size: 1.4rem; color: var(--vio); margin-bottom: 8px; }
.tag { color: var(--dim); font-size: 0.85rem; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 24px 0; }
.probe { padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.18); background: rgba(255,255,255,0.02); }
.probe.ok { border-left: 3px solid var(--ok); }
.probe.fail { border-left: 3px solid var(--fail); }
.probe .name { font-weight: 600; margin-bottom: 4px; }
.probe .name .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.probe .ok-dot { background: var(--ok); }
.probe .fail-dot { background: var(--fail); }
.probe .msg { color: var(--dim); font-size: 0.85rem; }
.probe .since { color: var(--dim); font-size: 0.75rem; margin-top: 4px; }
.alerts { margin-top: 32px; }
.alert { padding: 8px 12px; margin-bottom: 6px; font-size: 0.82rem; border-left: 3px solid var(--fail); background: rgba(248,113,113,0.04); }
.alert.RECOVERED { border-left-color: var(--ok); background: rgba(74,222,128,0.04); }
.alert .when { color: var(--dim); margin-right: 8px; }
.empty { color: var(--dim); font-style: italic; }
.btn { background: rgba(167,139,250,0.12); color: var(--ink); border: 1px solid rgba(167,139,250,0.4); border-radius: 4px; padding: 6px 12px; font-family: inherit; font-size: 0.8rem; cursor: pointer; }
.btn:hover { background: rgba(167,139,250,0.25); }
.btn.warn { border-color: rgba(248,113,113,0.5); color: var(--fail); }
.btn.warn:hover { background: rgba(248,113,113,0.15); }
</style></head>
<body>
<h1>⛩ kannaka-staff — watcher</h1>
<div class="tag" id="meta">loading…</div>
<div class="actions" style="margin: 16px 0; display: flex; gap: 8px; flex-wrap: wrap;">
  <button onclick="act('trigger-oration')" class="btn">🕊 trigger oration</button>
  <button onclick="act('trigger-showcase', { album: 'BEND THE ARC' })" class="btn">🎞 BEND THE ARC showcase</button>
  <button onclick="act('trigger-dream')" class="btn">🌙 dream lite</button>
  <button onclick="confirmAct('restart-radio')" class="btn warn">↻ restart radio</button>
  <button onclick="confirmAct('restart-observatory')" class="btn warn">↻ restart observatory</button>
</div>
<div id="actionResult" style="font-size: 0.78rem; color: var(--dim); min-height: 16px; margin-bottom: 12px;"></div>
<details style="font-size: 0.75rem; color: var(--dim); margin-bottom: 16px;">
  <summary style="cursor: pointer;">remote curl (HMAC signature)</summary>
  <pre style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 4px; overflow-x: auto; margin-top: 6px;">SECRET=...                      # set via STAFF_SHARED_SECRET on the staff host
TS=&#36;(date +%s%3N)
ACTION="growth-dream?mode=lite"
SIG=&#36;(printf "%s\\n%s\\n/action/%s" "&#36;TS" "POST" "&#36;ACTION" | openssl dgst -sha256 -hmac "&#36;SECRET" | awk '{print &#36;2}')
curl -X POST "https://staff.ninja-portal.com/action/&#36;ACTION" \\
  -u "nick:&lt;basic-auth-pass&gt;" \\
  -H "X-Staff-Timestamp: &#36;TS" \\
  -H "X-Staff-Signature: &#36;SIG"</pre>
  <div style="margin-top: 4px;">basic-auth is nginx-layer; HMAC is required for non-localhost callers when STAFF_SHARED_SECRET is set. Within 5-min skew, sha256(<code>&#36;{TS}\\n&#36;{METHOD}\\n&#36;{PATH}</code>) signed with the secret.</div>
</details>
<div class="grid" id="probes"></div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">RECENT ALERTS</h3>
  <div id="alerts"><div class="empty">no recent transitions</div></div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">GROWTH — HRM & DREAM CONSOLIDATION</h3>
  <div id="growth"><div class="empty">loading…</div></div>
  <div style="margin-top: 8px; display: flex; gap: 8px;">
    <button onclick="act('growth-dream', { mode: 'lite' })" class="btn">🌙 dream lite (tracked)</button>
    <button onclick="confirmAct('growth-dream', { mode: 'deep' })" class="btn warn">🌙🌙 dream deep</button>
  </div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">CURATOR — ALBUM STALENESS</h3>
  <div id="staleness"><div class="empty">loading…</div></div>
  <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
    <button onclick="confirmAct('curator-rescue')" class="btn">🚒 rescue oldest-starving (cooldown 24h)</button>
    <button onclick="confirmAct('curator-rescue', { force: '1' })" class="btn warn">🚒 force rescue (skip cooldown)</button>
  </div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">DISTRIBUTOR — RELEASE-ALBUM JOBS</h3>
  <div id="distributor"><div class="empty">loading…</div></div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">CREATOR — GENERATION QUEUE</h3>
  <div id="creator"><div class="empty">loading…</div></div>
  <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
    <button onclick="act('creator-request', { kind: 'oration' })" class="btn">🕊 generate oration</button>
  </div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">MARKETER — RECENT POSTS</h3>
  <div id="marketer"><div class="empty">loading…</div></div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">VOICE — TALK-SEGMENT LOCK</h3>
  <div id="voice"><div class="empty">loading…</div></div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">EAR — STREAM SILENCE</h3>
  <div id="ear"><div class="empty">loading…</div></div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">STORYTELLER — SHOWCASE LANDSCAPE</h3>
  <div id="storyteller"><div class="empty">loading…</div></div>
</div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">BUS — RECENT EVENTS (last 100)</h3>
  <div id="bus"><div class="empty">loading…</div></div>
</div>
<script>
function fmtAge(ms) {
  if (ms < 60_000) return Math.round(ms/1000) + 's';
  if (ms < 3_600_000) return Math.round(ms/60_000) + 'm';
  return (ms/3_600_000).toFixed(1) + 'h';
}
async function refresh() {
  try {
    const [s, a] = await Promise.all([
      fetch('/api/state').then(r => r.json()),
      fetch('/api/alerts').then(r => r.json()),
    ]);
    const now = Date.now();
    const probes = s.probes || {};
    const grid = document.getElementById('probes');
    grid.innerHTML = '';
    for (const [name, p] of Object.entries(probes)) {
      const div = document.createElement('div');
      div.className = 'probe ' + (p.ok ? 'ok' : 'fail');
      div.innerHTML = '<div class="name"><span class="dot ' + (p.ok ? 'ok-dot' : 'fail-dot') + '"></span>' + name + '</div>'
        + '<div class="msg">' + (p.message || '').replace(/</g,'&lt;') + '</div>'
        + '<div class="since">checked ' + fmtAge(now - p.ts) + ' ago</div>';
      grid.appendChild(div);
    }
    const alertsDiv = document.getElementById('alerts');
    if (a.length === 0) {
      alertsDiv.innerHTML = '<div class="empty">no recent transitions</div>';
    } else {
      alertsDiv.innerHTML = a.slice(0, 30).map(e =>
        '<div class="alert ' + e.transition + '"><span class="when">' + e.ts + '</span><strong>' + e.transition + '</strong> ' + e.probe + ' — ' + (e.message||'').replace(/</g,'&lt;') + '</div>'
      ).join('');
    }
    // Growth panel — HRM size, last dream, recent dream timeline.
    try {
      const gr = await fetch('/api/growth').then(r => r.json());
      const gv = document.getElementById('growth');
      if (gr.ok) {
        const hrm = gr.hrm || {};
        const size = hrm.sizeMB != null ? hrm.sizeMB.toFixed(1) + ' MB' : '(unreadable)';
        const mem = hrm.memoryCount != null ? hrm.memoryCount + ' memories' : 'mem ?';
        const inFlight = gr.inFlight
          ? '<span style="color: var(--vio)">⏳ ' + gr.inFlight.mode + ' dream in flight (' + Math.round((now - gr.inFlight.startedAt)/1000) + 's)</span>'
          : '';
        const lastD = gr.lastDream
          ? '<div class="alert ' + (gr.lastDream.ok ? 'RECOVERED' : '') + '" style="border-left-color: ' + (gr.lastDream.ok ? 'var(--ok)' : 'var(--fail)') + ';"><span class="when">' + new Date(gr.lastDream.ts).toLocaleTimeString() + '</span><strong>last:</strong> ' + (gr.lastDream.message || '') + '</div>'
          : '<div class="empty">no dream recorded yet</div>';
        const soft = gr.cfg && gr.cfg.hrmSoftMB, hard = gr.cfg && gr.cfg.hrmHardMB;
        const sizeColor = hrm.sizeMB != null
          ? (hrm.sizeMB >= hard ? 'var(--fail)' : (hrm.sizeMB >= soft ? '#fbbf24' : 'var(--ok)'))
          : 'var(--dim)';
        gv.innerHTML =
          '<div class="alert" style="border-left-color: ' + sizeColor + ';"><strong>HRM</strong> · ' + size + ' · ' + mem + ' · thresholds ' + soft + '/' + hard + ' MB ' + inFlight + '</div>'
          + lastD
          + (gr.dreamHistory && gr.dreamHistory.length > 1
              ? '<div style="color: var(--dim); font-size: 0.78rem; margin-top: 8px;">history: '
                + gr.dreamHistory.slice(0, 6).map(d => (d.ok ? '✓' : '✗') + d.mode[0]).join(' ')
                + '</div>'
              : '');
      } else {
        gv.innerHTML = '<div class="empty">' + (gr.error || 'growth offline') + '</div>';
      }
    } catch (_) {}
    // Crew panels — each role exposes /api/<role>.
    // Try/catch per panel so a single failed role doesn't blank the dashboard.
    async function fillPanel(elId, url, render) {
      try {
        const j = await fetch(url).then(r => r.json());
        document.getElementById(elId).innerHTML = render(j);
      } catch (e) {
        document.getElementById(elId).innerHTML = '<div class="empty">' + e.message + '</div>';
      }
    }
    function ageHtml(ms) {
      if (ms == null) return '<span style="color: var(--dim)">never</span>';
      return fmtAge(ms) + ' ago';
    }
    await Promise.all([
      fillPanel('distributor', '/api/distributor', (d) => {
        if (!d.ok) return '<div class="empty">' + (d.error || 'offline') + '</div>';
        const cur = d.current
          ? '<div class="alert" style="border-left-color: var(--vio); background: rgba(167,139,250,0.06);"><strong>⏳ in flight:</strong> ' + d.current.name + ' (' + fmtAge(d.current.elapsedMs) + ' so far · skip=' + (d.current.skip || '-') + ')</div>'
          : '<div class="alert" style="border-left-color: var(--dim); background: transparent;"><strong>idle</strong> — POST /action/distributor-publish?config=PATH to start</div>';
        const hist = (d.history || []).slice(0, 5).map(h =>
          '<div class="alert ' + (h.ok ? 'RECOVERED' : '') + '" style="border-left-color: ' + (h.ok ? 'var(--ok)' : 'var(--fail)') + ';"><span class="when">' + new Date(h.finishedAt).toLocaleTimeString() + '</span><strong>' + h.name + '</strong> · ' + (h.message || '').replace(/</g,'&lt;') + '</div>'
        ).join('');
        return cur + (hist || '<div class="empty">no jobs yet</div>');
      }),
      fillPanel('creator', '/api/creator', (d) => {
        if (!d.ok) return '<div class="empty">' + (d.error || 'offline') + '</div>';
        const cur = d.current
          ? '<div class="alert" style="border-left-color: var(--vio); background: rgba(167,139,250,0.06);"><strong>⏳ ' + d.current.kind + ':</strong> ' + d.current.id + ' (' + fmtAge(d.current.elapsedMs) + ')</div>'
          : '<div class="alert" style="border-left-color: var(--dim); background: transparent;"><strong>idle</strong></div>';
        const hist = (d.history || []).slice(0, 5).map(h =>
          '<div class="alert ' + (h.ok ? 'RECOVERED' : '') + '" style="border-left-color: ' + (h.ok ? 'var(--ok)' : 'var(--fail)') + ';"><span class="when">' + new Date(h.finishedAt).toLocaleTimeString() + '</span><strong>' + h.kind + '</strong> · ' + (h.message || '').replace(/</g,'&lt;').slice(0, 240) + '</div>'
        ).join('');
        return cur + (hist || '<div class="empty">no requests yet</div>');
      }),
      fillPanel('marketer', '/api/marketer', (d) => {
        if (!d.ok) return '<div class="empty">' + (d.error || 'offline') + '</div>';
        const hist = (d.history || []).slice(0, 5).map(h =>
          '<div class="alert ' + (h.ok ? 'RECOVERED' : '') + '" style="border-left-color: ' + (h.ok ? 'var(--ok)' : 'var(--fail)') + ';"><span class="when">' + new Date(h.finishedAt).toLocaleTimeString() + '</span>' + (h.summary || '').replace(/</g,'&lt;') + '<br><span style="color: var(--dim); font-size: 0.75rem;">' + (h.text || '').replace(/</g,'&lt;').slice(0, 160) + '</span></div>'
        ).join('');
        return hist || '<div class="empty">no posts yet</div>';
      }),
      fillPanel('voice', '/api/voice', (d) => {
        if (!d.ok) return '<div class="empty">' + (d.error || 'offline') + '</div>';
        const s = d.snapshot;
        if (!s) return '<div class="empty">no observations yet</div>';
        const lockColor = s.lockHeld ? (d.lockStuckAlerted ? 'var(--fail)' : '#fbbf24') : 'var(--ok)';
        return '<div class="alert" style="border-left-color: ' + lockColor + ';"><strong>lock:</strong> ' + (s.lockHeld ? 'HELD for ' + fmtAge(d.lockHeldForMs || 0) : 'free') + (s.currentSpeaker ? ' · speaker: ' + s.currentSpeaker : '') + (s.voiceQueue != null ? ' · queue: ' + s.voiceQueue : '') + '</div>';
      }),
      fillPanel('ear', '/api/ear', (d) => {
        if (!d.ok) return '<div class="empty">' + (d.error || 'offline') + '</div>';
        const s = d.lastStats;
        if (!s) return '<div class="empty">no samples yet</div>';
        if (!s.ok) return '<div class="alert" style="border-left-color: var(--fail);"><strong>sample failed:</strong> ' + (s.error || '?') + '</div>';
        const color = d.silentAlerted ? 'var(--fail)' : (d.silentStreak > 0 ? '#fbbf24' : 'var(--ok)');
        return '<div class="alert" style="border-left-color: ' + color + ';"><strong>variance:</strong> ' + s.variance.toFixed(1) + ' · mean: ' + s.mean.toFixed(1) + ' · ' + s.bytes + 'B sampled' + (d.silentStreak ? ' · silent streak: ' + d.silentStreak : '') + '</div>';
      }),
      fillPanel('storyteller', '/api/storyteller', (d) => {
        if (!d.ok) return '<div class="empty">' + (d.error || 'offline') + '</div>';
        const s = d.snapshot;
        if (!s || !s.ok) return '<div class="empty">' + ((s && s.error) || 'no snapshot yet') + '</div>';
        const ov = s.override
          ? '<div class="alert" style="border-left-color: var(--vio); background: rgba(167,139,250,0.06);"><strong>override active:</strong> ' + s.override.album + (s.override.untilHuman ? ' (until ' + s.override.untilHuman + ')' : '') + '</div>'
          : '';
        const next = s.nextShowcase && s.nextShowcase.inMinutes != null
          ? '<div class="alert" style="border-left-color: var(--ok);"><strong>next showcase:</strong> in ' + Math.floor(s.nextShowcase.inMinutes / 60) + 'h ' + (s.nextShowcase.inMinutes % 60) + 'm (' + s.nextShowcase.fixedSchedule + ')</div>'
          : '';
        const cur = '<div class="alert" style="border-left-color: var(--dim); background: transparent;"><strong>now:</strong> ' + (s.currentAlbum || '?') + (s.block ? ' · block: ' + s.block : '') + '</div>';
        return cur + ov + next;
      }),
      fillPanel('bus', '/api/bus', (d) => {
        if (!d.ok || !d.events || d.events.length === 0) return '<div class="empty">no events yet — bus is quiet</div>';
        return d.events.slice(0, 25).map(ev =>
          '<div class="alert" style="border-left-color: var(--vio); background: rgba(167,139,250,0.04); font-size: 0.78rem;">'
          + '<span class="when">' + new Date(ev.ts).toLocaleTimeString() + '</span>'
          + '<strong>' + ev.source + '</strong> · ' + ev.subject.replace(/</g,'&lt;')
          + '<br><span style="color: var(--dim); font-family: Consolas, monospace;">' + (ev.summary || '').replace(/</g,'&lt;') + '</span>'
          + '</div>'
        ).join('');
      }),
    ]);

    // Curator panel — pull classification summary from /api/curator
    // (the Curator role) and the per-album list from /api/album-staleness
    // (the watcher's read-only helper that pre-existed the role).
    try {
      const [cu, cur] = await Promise.all([
        fetch('/api/curator').then(r => r.json()).catch(() => ({ ok: false })),
        fetch('/api/album-staleness').then(r => r.json()).catch(() => ({ ok: false })),
      ]);
      const stale = document.getElementById('staleness');
      let header = '';
      if (cu.ok && cu.counts) {
        const c = cu.counts;
        header =
          '<div class="alert" style="border-left-color: var(--vio); background: rgba(167,139,250,0.04);">'
          + '<strong>roles classification</strong> · '
          + '<span style="color: var(--ok)">fresh ' + (c.fresh||0) + '</span> · '
          + '<span style="color: #fbbf24">aging ' + (c.aging||0) + '</span> · '
          + '<span style="color: var(--fail)">starving ' + (c.starving||0) + '</span>'
          + (c.never ? ' · <span style="color: var(--fail)">never ' + c.never + '</span>' : '')
          + '</div>';
      }
      if (cur.ok && cur.albums && cur.albums.length > 0) {
        stale.innerHTML = header + cur.albums.slice(0, 12).map(c => {
          const ago = c.ageMs == null ? '<span style="color: var(--fail)">never (in last ' + (cur.historyLen||0) + ')</span>' : fmtAge(c.ageMs) + ' ago';
          const plays = c.playsInWindow ? c.playsInWindow + 'x' : '0x';
          return '<div class="alert" style="border-left-color: ' + (c.ageMs == null ? 'var(--fail)' : c.ageMs > 21600000 ? '#fbbf24' : 'var(--ok)') + ';"><strong>' + c.album + '</strong> · last: ' + ago + ' · plays in window: ' + plays + '</div>';
        }).join('');
      } else {
        stale.innerHTML = header + '<div class="empty">' + (cur.message || 'no staleness data') + '</div>';
      }
    } catch (_) {}
    // Pull active listeners out of the listener_count probe message
    // ("N active" or "listener field absent"). Surfaced in the header
    // so the operator sees it without scrolling.
    const lcProbe = probes.listener_count;
    const listenerMatch = lcProbe && lcProbe.message && lcProbe.message.match(/^(\d+) active/);
    const listenerStr = listenerMatch ? listenerMatch[1] + ' listening' : '— listening';
    document.getElementById('meta').textContent =
      listenerStr + ' · tick: ' + (s.lastTick ? new Date(s.lastTick).toLocaleTimeString() : '?') + ' · probes: ' + Object.keys(probes).length + ' · alerts logged: ' + a.length;
  } catch (e) {
    document.getElementById('meta').textContent = 'error: ' + e.message;
  }
}
refresh();
setInterval(refresh, 10000);

async function act(action, params) {
  const result = document.getElementById('actionResult');
  result.textContent = '⏳ ' + action + '…';
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  try {
    const r = await fetch('/action/' + action + qs, { method: 'POST' });
    const j = await r.json();
    result.textContent = (j.ok ? '✓ ' : '✗ ') + action + ' — ' + (j.note || j.body || j.error || '').toString().slice(0, 200);
    setTimeout(() => refresh(), 3000);
  } catch (e) {
    result.textContent = '✗ ' + action + ' — ' + e.message;
  }
}

function confirmAct(action, params) {
  if (!confirm('Run ' + action + (params ? ' ' + JSON.stringify(params) : '') + '? This may interrupt service.')) return;
  act(action, params);
}
</script>
</body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml());
    return;
  }
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      startedAt: state.startedAt,
      lastTick: state.lastTick,
      probes: state.probes,
    }));
    return;
  }
  if (req.url.startsWith("/api/alerts")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(recentAlerts(100)));
    return;
  }
  if (req.url === "/api/album-staleness") {
    fetchAlbumStaleness()
      .then((r) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }
  if (req.url === "/api/growth") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(growth ? { ok: true, ...growth.getState() } : { ok: false, error: "growth not online (EXTERNAL_MODE?)" }));
    return;
  }
  if (req.url === "/api/curator") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(curator ? { ok: true, ...curator.getState() } : { ok: false, error: "curator not online" }));
    return;
  }
  if (req.url === "/api/distributor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(distributor ? { ok: true, ...distributor.getState() } : { ok: false, error: "distributor not online (EXTERNAL_MODE?)" }));
    return;
  }
  if (req.url === "/api/distributor/log") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(distributor ? distributor.getLog() : { ok: false, error: "distributor not online" }));
    return;
  }
  if (req.url === "/api/creator") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(creator ? { ok: true, ...creator.getState() } : { ok: false, error: "creator not online" }));
    return;
  }
  if (req.url === "/api/marketer") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(marketer ? { ok: true, ...marketer.getState() } : { ok: false, error: "marketer not online (EXTERNAL_MODE?)" }));
    return;
  }
  if (req.url === "/api/voice") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(voice ? { ok: true, ...voice.getState() } : { ok: false, error: "voice not online" }));
    return;
  }
  if (req.url === "/api/ear") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ear ? { ok: true, ...ear.getState() } : { ok: false, error: "ear not online" }));
    return;
  }
  if (req.url === "/api/storyteller") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(storyteller ? { ok: true, ...storyteller.getState() } : { ok: false, error: "storyteller not online" }));
    return;
  }
  if (req.url.startsWith("/api/bus")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: busRing.length, events: busRing.slice().reverse() }));
    return;
  }
  // ── Operations console: write actions ───────────────────────
  // Each action wraps a known operational pattern. Authentication
  // model: if STAFF_SHARED_SECRET is configured (production), require
  // an HMAC-SHA256 signature header. If not configured, allow same-
  // origin requests only (dashboard works locally; remote calls fail).
  // ADR-003 Wave 3 — this is the oracle-admin shim QueenSync v2.0
  // will dispatch tasks to from outside the Oracle network.
  if (req.method === "POST" && req.url.startsWith("/action/")) {
    const action = req.url.replace("/action/", "").split("?")[0];
    // Auth check. Localhost always allowed (the dashboard's quick-action
    // buttons + local SSH-tunnel ops). Remote callers must HMAC-sign.
    const secret = process.env.STAFF_SHARED_SECRET;
    const remote = req.socket.remoteAddress || "";
    const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (secret && !isLocal) {
      const sig = req.headers["x-staff-signature"];
      const ts = req.headers["x-staff-timestamp"];
      if (!sig || !ts) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing X-Staff-Signature / X-Staff-Timestamp" }));
        return;
      }
      // Reject stale timestamps to prevent replay (5 min window).
      const skew = Math.abs(Date.now() - (parseInt(ts, 10) || 0));
      if (skew > 5 * 60 * 1000) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "timestamp out of window" }));
        return;
      }
      const expected = crypto.createHmac("sha256", secret)
        .update(`${ts}\n${req.method}\n${req.url}`)
        .digest("hex");
      let ok = false;
      try {
        ok = crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
      } catch (_) { /* length mismatch → ok stays false */ }
      if (!ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad signature" }));
        return;
      }
    } else if (!secret && !isLocal) {
      // No secret configured AND not local — refuse remote calls entirely.
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "remote calls require STAFF_SHARED_SECRET" }));
      return;
    }
    // else: localhost (always allowed) OR signed remote (verified above)
    handleAction(action, url.parse(req.url, true).query)
      .then((r) => {
        res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404");
});

// ── Boot Growth (medium maintenance) ────────────────────────
// Growth boots wherever there's a local HRM, regardless of
// EXTERNAL_MODE. The earlier "disable Growth under EXTERNAL_MODE"
// rule was wrong — the witness on Oracle-2 IS an EXTERNAL_MODE
// staff but it owns its own HRM, and that HRM went unsupervised
// (saw 7753 audio: memories on 2026-05-14 because the radio's
// Growth couldn't reach the witness file). Now the guard is "does
// the configured HRM_PATH exist?" — true on both primaries and
// witness boxes, false on observer-only hosts.
let growth = null;
const hrmExists = (() => { try { return require("fs").existsSync(HRM_PATH); } catch { return false; } })();
if (hrmExists) {
  try {
    growth = bootGrowth({ hrmPath: HRM_PATH, alertsFile: ALERTS_FILE, staffBus });
    const gs = growth.getState();
    console.log(`[staff] growth online — tick ${Math.round(gs.cfg.tickMs / 60000)}m · thresholds ${gs.cfg.hrmSoftMB}/${gs.cfg.hrmHardMB} MB or ${gs.cfg.memorySoft}/${gs.cfg.memoryHard} memories`);
  } catch (e) {
    console.warn(`[staff] growth boot failed: ${e.message}`);
  }
} else {
  console.log(`[staff] growth disabled — no HRM at ${HRM_PATH}`);
}

// ── Boot Curator (album-staleness + empty-album watch) ──────
// Safe in EXTERNAL_MODE — only needs HTTP access to the radio.
let curator = null;
try {
  curator = bootCurator({ radioBase: RADIO_BASE, alertsFile: ALERTS_FILE, staffBus });
  const cs = curator.getState();
  console.log(`[staff] curator online — tick ${Math.round(cs.cfg.tickMs / 60000)}m · starving ≥ ${Math.round(cs.cfg.starvingMs / 3600000)}h`);
} catch (e) {
  console.warn(`[staff] curator boot failed: ${e.message}`);
}

// ── Boot Distributor (release-album pipeline runner) ────────
// Disabled in EXTERNAL_MODE — Distributor expects the
// kannaka-radio scripts/release-album.sh to live on the same host
// (it scp's to Oracle and restarts the radio service).
let distributor = null;
if (!EXTERNAL_MODE) {
  try {
    distributor = bootDistributor({ alertsFile: ALERTS_FILE, staffBus });
    const ds = distributor.getState();
    const scriptOk = require("fs").existsSync(ds.cfg.releaseScript);
    console.log(`[staff] distributor online — release script ${scriptOk ? "ok" : "MISSING"} at ${ds.cfg.releaseScript} · timeout ${Math.round(ds.cfg.jobTimeoutMs / 60000)}m`);
  } catch (e) {
    console.warn(`[staff] distributor boot failed: ${e.message}`);
  }
} else {
  console.log("[staff] distributor disabled (EXTERNAL_MODE)");
}

// ── Boot Creator (generation dispatcher) ────────────────────
let creator = null;
try {
  creator = bootCreator({ radioBase: RADIO_BASE, alertsFile: ALERTS_FILE, staffBus });
  console.log(`[staff] creator online — kinds: oration, image (track via Distributor)`);
} catch (e) {
  console.warn(`[staff] creator boot failed: ${e.message}`);
}

// ── Boot Marketer (social fan-out wrapper) ──────────────────
// Disabled in EXTERNAL_MODE — requires the radio repo locally.
let marketer = null;
if (!EXTERNAL_MODE) {
  try {
    marketer = bootMarketer({ alertsFile: ALERTS_FILE, staffBus });
    const ms = marketer.getState();
    const radioOk = require("fs").existsSync(require("path").join(ms.cfg.radioRepo, "server/broadcasters"));
    console.log(`[staff] marketer online — broadcasters ${radioOk ? "ok" : "MISSING"} at ${ms.cfg.radioRepo}/server/broadcasters`);
  } catch (e) {
    console.warn(`[staff] marketer boot failed: ${e.message}`);
  }
} else {
  console.log("[staff] marketer disabled (EXTERNAL_MODE)");
}

// ── Boot Voice (talk-segment lock observer) ─────────────────
let voice = null;
try {
  voice = bootVoice({ radioBase: RADIO_BASE, alertsFile: ALERTS_FILE, staffBus });
  const vs = voice.getState();
  console.log(`[staff] voice online — tick ${Math.round(vs.cfg.tickMs / 60000)}m · stuck threshold ${Math.round(vs.cfg.stuckMs / 60000)}m`);
} catch (e) {
  console.warn(`[staff] voice boot failed: ${e.message}`);
}

// ── Boot Ear (stream silence detector) ──────────────────────
let ear = null;
try {
  ear = bootEar({ streamUrl: STREAM_URL, alertsFile: ALERTS_FILE, staffBus });
  const es = ear.getState();
  console.log(`[staff] ear online — tick ${Math.round(es.cfg.tickMs / 60000)}m · sample ${es.cfg.sampleBytes}B · confirm ${es.cfg.confirmTicks}t`);
} catch (e) {
  console.warn(`[staff] ear boot failed: ${e.message}`);
}

// ── Boot Storyteller (showcase landscape observer) ──────────
let storyteller = null;
try {
  storyteller = bootStoryteller({ radioBase: RADIO_BASE, alertsFile: ALERTS_FILE, staffBus });
  const ss = storyteller.getState();
  console.log(`[staff] storyteller online — tick ${Math.round(ss.cfg.tickMs / 60000)}m`);
} catch (e) {
  console.warn(`[staff] storyteller boot failed: ${e.message}`);
}

// ── Closed loops (per ADR-003) ──────────────────────────────
// Authorized auto-actions live here, in one auditable block. Each
// loop has a single trigger, a single action, and a rate limit.
// New loops require a new entry in ADR-003.
const AUTO_RECOVER = {
  // Stuck-stream auto-recover: when Ear has confirmed dead air, ask
  // Watcher's existing restart-radio action to bounce the service.
  // Cooldown prevents a flap loop if the radio comes back silent
  // immediately after a restart.
  lastRestartTs: 0,
  cooldownMs: parseInt(process.env.AUTO_RECOVER_COOLDOWN_MS || "", 10) || 30 * 60 * 1000,
};
function runAutoRecoverRestart(reason) {
  const sinceLast = Date.now() - AUTO_RECOVER.lastRestartTs;
  if (sinceLast < AUTO_RECOVER.cooldownMs) {
    const mins = Math.round((AUTO_RECOVER.cooldownMs - sinceLast) / 60000);
    console.log(`[auto-recover] ${reason} — cooldown active (${mins}m remaining)`);
    return;
  }
  AUTO_RECOVER.lastRestartTs = Date.now();
  const entry = {
    ts: new Date().toISOString(),
    probe: "auto-recover",
    transition: "AUTO_RECOVER_RESTART",
    message: `${reason} — restarting kannaka-radio`,
  };
  try { fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n"); } catch (_) {}
  console.log(`[auto-recover] AUTO_RECOVER_RESTART: ${entry.message}`);
  execFile("sudo", ["/bin/systemctl", "restart", "kannaka-radio"], { timeout: 30_000 }, (err, _out, errOut) => {
    const done = {
      ts: new Date().toISOString(),
      probe: "auto-recover",
      transition: err ? "AUTO_RECOVER_FAILED" : "AUTO_RECOVER_DONE",
      message: err ? `restart failed: ${err.message} ${(errOut || "").slice(0, 200)}` : "kannaka-radio restart completed",
    };
    try { fs.appendFileSync(ALERTS_FILE, JSON.stringify(done) + "\n"); } catch (_) {}
    console.log(`[auto-recover] ${done.transition}: ${done.message}`);
  });
}
if (!EXTERNAL_MODE) {
  // Stream-silent trigger: Ear saw dead air → restart.
  staffBus.on("KANNAKA.staff.stream.silent", (ev) => {
    runAutoRecoverRestart(`stream silent (variance=${ev.payload.variance.toFixed(1)}, streak=${ev.payload.silentStreak})`);
  });
  // Voice-lock-stuck trigger: TTS queue jammed → restart fixes it.
  // Shares the SAME cooldown bucket as stream.silent because both
  // failures usually want the same remedy and we don't want a stuck
  // lock + dead air co-occurring to cause a double-restart.
  staffBus.on("KANNAKA.staff.voice.lock.stuck", (ev) => {
    runAutoRecoverRestart(`talk-segment lock stuck for ${Math.round(ev.payload.heldForMs / 60000)}m`);
  });
  console.log(`[staff] auto-recover online — stream.silent + voice.lock.stuck → restart-radio (shared cooldown ${Math.round(AUTO_RECOVER.cooldownMs / 60000)}m)`);
}

// Second closed loop — album rescue. When Curator flags an album as
// starving, schedule a 20-min showcase via the radio's existing
// /api/album/showcase action. The rate-limit is GLOBAL (not per
// album) — five albums starving simultaneously would otherwise burn
// 100+ minutes of overridden programming in a day. Picking the
// oldest-aged starving album keeps the rescue pointed at the worst-
// off entry. Manual override available via /action/curator-rescue.
const AUTO_RESCUE = {
  lastRescueTs: 0,
  cooldownMs: parseInt(process.env.AUTO_RESCUE_COOLDOWN_MS || "", 10) || 24 * 60 * 60 * 1000,
  durationMin: parseInt(process.env.AUTO_RESCUE_DURATION_MIN || "", 10) || 20,
};
async function fireRescue(reason) {
  if (!curator) return { ok: false, error: "curator not online" };
  const sinceLast = Date.now() - AUTO_RESCUE.lastRescueTs;
  if (sinceLast < AUTO_RESCUE.cooldownMs) {
    const hrs = Math.round((AUTO_RESCUE.cooldownMs - sinceLast) / 3600000);
    return { ok: false, error: `cooldown active (${hrs}h remaining)` };
  }
  const starving = curator.starvingAlbums();
  if (starving.length === 0) return { ok: false, error: "no starving albums to rescue" };
  const target = starving[0];
  AUTO_RESCUE.lastRescueTs = Date.now();
  const u = `${RADIO_BASE}/api/album/showcase?album=${encodeURIComponent(target.album)}&duration=${AUTO_RESCUE.durationMin}`;
  return new Promise((resolve) => {
    const lib = url.parse(u).protocol === "https:" ? https : http;
    const uu = url.parse(u);
    const req = lib.request({
      method: "POST",
      hostname: uu.hostname,
      port: uu.port || 80,
      path: uu.pathname + (uu.search || ""),
      timeout: 10_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        const entry = {
          ts: new Date().toISOString(),
          probe: "auto-rescue",
          transition: ok ? "AUTO_RESCUE_FIRED" : "AUTO_RESCUE_FAILED",
          message: `"${target.album}" — ${Math.round((target.ageMs || 0) / 3600000)}h stale — showcase ${AUTO_RESCUE.durationMin}min (${reason}) — HTTP ${res.statusCode}`,
        };
        try { fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n"); } catch (_) {}
        console.log(`[auto-rescue] ${entry.transition}: ${entry.message}`);
        resolve({ ok, album: target.album, durationMin: AUTO_RESCUE.durationMin, status: res.statusCode });
      });
    });
    req.on("error", (e) => {
      // roll back the rate-limit stamp on transport failure so the next
      // tick can retry — we don't want a network blip to consume the
      // 24h slot.
      AUTO_RESCUE.lastRescueTs = sinceLast > 0 ? AUTO_RESCUE.lastRescueTs - AUTO_RESCUE.cooldownMs : 0;
      resolve({ ok: false, error: e.message });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}
if (!EXTERNAL_MODE) {
  staffBus.on("KANNAKA.staff.album.starving", (ev) => {
    fireRescue(`triggered by starving event for "${ev.payload.album}"`)
      .then((r) => { if (!r.ok && r.error && !r.error.startsWith("cooldown")) console.log(`[auto-rescue] skipped: ${r.error}`); });
  });
  console.log(`[staff] auto-rescue online — album.starving → showcase ${AUTO_RESCUE.durationMin}m (cooldown ${Math.round(AUTO_RESCUE.cooldownMs / 3600000)}h)`);
}

server.listen(PORT, () => {
  console.log(`[staff] listening on :${PORT}`);
  console.log(`[staff] alerts log: ${ALERTS_FILE}`);
  console.log(`[staff] probing every ${TICK_MS / 1000}s`);
});

// Test/CI safety: self-destruct after a TTL so a smoke-test can never leak a
// stray server. On Windows/Git Bash `node … & kill $!` often misses the real
// node.exe PID, orphaning the server for weeks; this guarantees cleanup.
// Prod leaves KANNAKA_TEST_TTL_MS unset → no timer.
const TEST_TTL_MS = Number(process.env.KANNAKA_TEST_TTL_MS) || 0;
if (TEST_TTL_MS > 0) {
  console.log(`[staff] KANNAKA_TEST_TTL_MS=${TEST_TTL_MS} — auto-shutdown armed`);
  setTimeout(() => {
    console.log("[staff] test TTL reached — self-destructing");
    shutdown();
  }, TEST_TTL_MS).unref();
}

// First tick immediate, then on interval.
tick().catch((e) => console.error("[staff] first tick:", e));
setInterval(() => tick().catch((e) => console.error("[staff] tick:", e)), TICK_MS);

// Graceful shutdown
function shutdown() {
  console.log("[staff] shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
