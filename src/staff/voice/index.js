/**
 * Voice — Phase 3 (ADR-001 § 4), observation MVP.
 *
 * The full Voice role owns the talk-segment lock arbitration: who can
 * speak when (peace orations vs DJ intros vs showcase narration vs
 * live broadcast). That's deep state inside kannaka-radio and not
 * portable as-is. Tonight's MVP is the observer:
 *
 *   - Tick every 90s.
 *   - Pull radio /api/state, inspect lock state (DJ talk segment,
 *     voice queue depth, ongoing oration).
 *   - Edge-trigger VOICE_LOCK_STUCK if the lock has been held longer
 *     than the configured threshold (default 5 min — the 2026-04-30
 *     stuck-lock incident was the canonical bad day).
 *   - VOICE_LOCK_RECOVERED when the lock clears after a stuck alert.
 *
 * Persistence: <ALERTS_FILE dir>/voice-state.json (last-known lock).
 *
 * Routes:
 *   GET /api/voice
 */
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const url = require("url");

const DEFAULTS = {
  TICK_MS: 90 * 1000,
  STUCK_MS: 5 * 60 * 1000,
};

function readEnvMs(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function probeJson(target, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const u = url.parse(target);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ ok: res.statusCode < 400, json: JSON.parse(text) }); }
        catch (_) { resolve({ ok: false, json: null, raw: text.slice(0, 400) }); }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function bootVoice(deps) {
  const RADIO_BASE = deps.radioBase;
  const ALERTS_FILE = deps.alertsFile;
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "voice-state.json");

  const cfg = {
    tickMs: readEnvMs("VOICE_TICK_MS", DEFAULTS.TICK_MS),
    stuckMs: readEnvMs("VOICE_STUCK_MS", DEFAULTS.STUCK_MS),
    enabled: process.env.VOICE_ENABLED !== "false",
  };

  const v = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    lockObservedAt: null,   // ms — when current lock first appeared
    lockStuckAlerted: false,
    snapshot: null,
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (typeof persisted.lockObservedAt === "number") v.lockObservedAt = persisted.lockObservedAt;
      if (typeof persisted.lockStuckAlerted === "boolean") v.lockStuckAlerted = persisted.lockStuckAlerted;
    }
  } catch (e) { console.warn(`[voice] state load: ${e.message}`); }

  function persist() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lockObservedAt: v.lockObservedAt, lockStuckAlerted: v.lockStuckAlerted }, null, 2)); }
    catch (e) { console.warn(`[voice] state save: ${e.message}`); }
  }
  function logAlert(transition, message) {
    const entry = { ts: new Date().toISOString(), probe: "voice", transition, message };
    try { fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n"); }
    catch (e) { console.warn(`[voice] alert write: ${e.message}`); }
    console.log(`[voice] ${transition}: ${message}`);
  }

  async function tick() {
    if (!cfg.enabled) return;
    const r = await probeJson(`${RADIO_BASE}/api/state`);
    v.lastTick = Date.now();
    if (!r.ok || !r.json) return;
    // Radio state field names vary by version; check the documented ones.
    const s = r.json;
    const lockHeld = !!(s._inTalkSegment || s.inTalkSegment || s.talk?.locked || s.voice?.locked);
    v.snapshot = {
      lockHeld,
      voiceQueue: s.voice && typeof s.voice.queueDepth === "number" ? s.voice.queueDepth : null,
      currentSpeaker: s.voice && s.voice.currentSpeaker ? s.voice.currentSpeaker : null,
    };
    if (lockHeld) {
      if (v.lockObservedAt == null) v.lockObservedAt = Date.now();
      const heldFor = Date.now() - v.lockObservedAt;
      if (heldFor > cfg.stuckMs && !v.lockStuckAlerted) {
        logAlert("VOICE_LOCK_STUCK", `talk-segment lock held ${Math.round(heldFor / 60000)} min — investigate`);
        v.lockStuckAlerted = true;
      }
    } else {
      if (v.lockStuckAlerted) {
        const heldFor = v.lockObservedAt ? (Date.now() - v.lockObservedAt) : 0;
        logAlert("VOICE_LOCK_RECOVERED", `lock cleared after ${Math.round(heldFor / 60000)} min`);
      }
      v.lockObservedAt = null;
      v.lockStuckAlerted = false;
    }
    persist();
  }

  setTimeout(() => { tick().catch((e) => console.warn(`[voice] first tick: ${e.message}`)); }, 60_000);
  setInterval(() => { tick().catch((e) => console.warn(`[voice] tick: ${e.message}`)); }, cfg.tickMs);

  return {
    getState() {
      return {
        cfg,
        bootedAt: v.bootedAt,
        lastTick: v.lastTick,
        snapshot: v.snapshot,
        lockObservedAt: v.lockObservedAt,
        lockHeldForMs: v.lockObservedAt ? Date.now() - v.lockObservedAt : 0,
        lockStuckAlerted: v.lockStuckAlerted,
      };
    },
    tick,
  };
}

module.exports = { bootVoice };
