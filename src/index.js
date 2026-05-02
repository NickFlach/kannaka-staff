#!/usr/bin/env node
/**
 * kannaka-staff — Phase 1: Watcher
 *
 * Single-file watcher that probes every constellation surface every 60s,
 * logs state transitions to a JSONL alert file, and serves a small
 * status dashboard on port 8889 (configurable). Stdlib-only — no npm
 * deps, ships clean to Oracle alongside kannaka-radio.
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
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec, execFile } = require("child_process");
const net = require("net");
const url = require("url");

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "8889", 10) || 8889;
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
        if (chunks.length < 50) chunks.push(c); // cap captured body
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, 2000);
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        resolve({ ok, status: res.statusCode, body, bytes });
      });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
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

async function runAllProbes() {
  const ts = Date.now();
  const results = {};

  // 1. kannaka-radio.service
  {
    const r = await probeSystemd("kannaka-radio.service");
    results.radio_service = { ok: r.ok, message: r.message, ts };
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

  // 4. stream_responsive
  {
    const r = await probeHttp(STREAM_URL, { method: "HEAD", timeout: 8000 });
    results.stream_responsive = {
      ok: r.ok,
      message: r.ok ? `HTTP ${r.status}` : `HTTP ${r.status || 0} ${r.error || ""}`,
      ts,
    };
  }

  // 5. observatory_service
  {
    const r = await probeSystemd("kannaka-observatory.service");
    results.observatory_service = { ok: r.ok, message: r.message, ts };
  }

  // 6. observatory_serving — has the consciousness shape (queen.phi, etc.)
  {
    const r = await probeHttp(`${OBSERVATORY_BASE}/api/state`);
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

  // 7. swarm_serve_service
  {
    const r = await probeSystemd("kannaka-swarm-serve.service");
    results.swarm_serve_service = { ok: r.ok, message: r.message, ts };
  }

  // 8. hrm_size — alert if >HRM_SIZE_ALERT_MB
  {
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

  return results;
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

  // Compare to previous state and log transitions
  for (const [name, current] of Object.entries(probeResults)) {
    const prev = state.probes[name];
    if (prev && prev.ok !== current.ok) {
      const transition = current.ok ? "RECOVERED" : "FAILED";
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
    // Keep last-5 history per probe for the UI
    const history = (prev && prev.history) || [];
    history.push({ ok: current.ok, ts: current.ts });
    if (history.length > 5) history.shift();
    current.history = history;
    state.probes[name] = current;
  }
  state.lastTick = Date.now();
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
</style></head>
<body>
<h1>⛩ kannaka-staff — watcher</h1>
<div class="tag" id="meta">loading…</div>
<div class="grid" id="probes"></div>
<div class="alerts">
  <h3 style="color: var(--vio); font-size: 0.95rem; letter-spacing: 0.1em;">RECENT ALERTS</h3>
  <div id="alerts"><div class="empty">no recent transitions</div></div>
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
    document.getElementById('meta').textContent =
      'tick: ' + (s.lastTick ? new Date(s.lastTick).toLocaleTimeString() : '?') + ' · probes: ' + Object.keys(probes).length + ' · alerts logged: ' + a.length;
  } catch (e) {
    document.getElementById('meta').textContent = 'error: ' + e.message;
  }
}
refresh();
setInterval(refresh, 10000);
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
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404");
});

server.listen(PORT, () => {
  console.log(`[staff] listening on :${PORT}`);
  console.log(`[staff] alerts log: ${ALERTS_FILE}`);
  console.log(`[staff] probing every ${TICK_MS / 1000}s`);
});

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
