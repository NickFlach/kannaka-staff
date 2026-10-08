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
 *   - Edge-trigger VOICE_LOCK_STUCK if the lock has been held IDLE
 *     (`speaking: false`) longer than the configured threshold (default
 *     15 min). The 2026-04-30 stuck-lock incident was the canonical bad
 *     day; the 2026-10-08 incident was the opposite one: the lock was
 *     held for 15 min because the peace oration's TTS was retrying
 *     (`speaking: true` throughout), Voice called it stuck at 5 min, and
 *     auto-recover restarted the radio mid-song three times in a day.
 *     A lock that is busy is not stuck; it is only long.
 *   - Edge-trigger VOICE_LOCK_LONG (alert only, never a restart) when a
 *     busy lock passes VOICE_BUSY_CEILING_MS (default 30 min).
 *   - VOICE_LOCK_RECOVERED when the lock clears after either alert.
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

const { readEnvMs } = require("../util");

const DEFAULTS = {
  TICK_MS: 90 * 1000,
  // Idle lock (nothing rendering, nothing in flight) before VOICE_LOCK_STUCK.
  // kannaka-radio releases a talk lock itself at a 720 s inject ceiling, so an
  // idle lock older than that is one the radio's own safety net missed.
  STUCK_MS: 15 * 60 * 1000,
  // Busy lock (speaking: true — TTS rendering, retrying, or a voice in flight)
  // before VOICE_LOCK_LONG. The radio's long-form TTS retry budget is about
  // 15 min (three attempts, 60 s and 120 s waits); this sits well above it.
  BUSY_CEILING_MS: 30 * 60 * 1000,
  // kannaka-radio exposes the talk-segment lock on its DJ-voice route.
  // /api/state carries only `djVoice: { enabled }` — none of the lock
  // fields this role was reading — so the lock always read as free and
  // VOICE_LOCK_STUCK could never fire.
  STATUS_PATH: "/api/dj-voice/status",
};

/**
 * Read the talk-segment lock out of a radio status payload (exported for
 * tests). Accepts the /api/dj-voice/status shape and the older
 * /api/state-style field names so a radio that has not been upgraded
 * still reports something sane.
 */
function lockFromStatus(s) {
  if (!s || typeof s !== "object") return null;
  const lockHeld = !!(
    s.inTalkSegment || s._inTalkSegment ||
    (s.talk && s.talk.locked) || (s.voice && s.voice.locked)
  );
  return {
    lockHeld,
    speaking: typeof s.speaking === "boolean" ? s.speaking : null,
    voiceQueue: s.voice && typeof s.voice.queueDepth === "number" ? s.voice.queueDepth : null,
    currentSpeaker: (s.voice && s.voice.currentSpeaker) || s.lastIntro || null,
  };
}

/**
 * Advance the lock bookkeeping by one observation. Pure apart from mutating
 * `v`; returns the transitions to emit. Exported for tests.
 *
 * Two clocks: `lockObservedAt` (how long the lock has been held at all) and
 * `idleSince` (how long it has been held with nothing speaking). STUCK reads
 * the idle clock; LONG reads the held clock while busy. A radio that does not
 * report `speaking` (null) is treated as idle, which is the pre-2026-10-08
 * behaviour.
 */
function advanceLock(v, snap, now, cfg) {
  const out = [];
  if (!snap.lockHeld) {
    if (v.lockStuckAlerted || v.lockLongAlerted) {
      out.push({ transition: "VOICE_LOCK_RECOVERED", heldForMs: v.lockObservedAt ? now - v.lockObservedAt : 0 });
    }
    v.lockObservedAt = null;
    v.idleSince = null;
    v.lockStuckAlerted = false;
    v.lockLongAlerted = false;
    return out;
  }
  if (v.lockObservedAt == null) v.lockObservedAt = now;
  const heldFor = now - v.lockObservedAt;
  const busy = snap.speaking === true;
  if (busy) v.idleSince = null;
  else if (v.idleSince == null) v.idleSince = now;
  const idleFor = v.idleSince == null ? 0 : now - v.idleSince;
  if (!busy && idleFor > cfg.stuckMs && !v.lockStuckAlerted) {
    v.lockStuckAlerted = true;
    out.push({ transition: "VOICE_LOCK_STUCK", heldForMs: heldFor, idleForMs: idleFor });
  }
  if (busy && heldFor > cfg.busyCeilingMs && !v.lockLongAlerted) {
    v.lockLongAlerted = true;
    out.push({ transition: "VOICE_LOCK_LONG", heldForMs: heldFor });
  }
  return out;
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
      const settle = () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ ok: res.statusCode < 400, json: JSON.parse(text) }); }
        catch (_) { resolve({ ok: false, json: null, raw: text.slice(0, 400) }); }
      };
      res.on("end", settle);
      res.on("close", settle);
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
  const bus = deps.staffBus || null;

  function publish(subject, payload) {
    if (!bus) return;
    bus.emit(subject, { ts: Date.now(), source: "voice", subject, payload });
  }

  const cfg = {
    tickMs: readEnvMs("VOICE_TICK_MS", DEFAULTS.TICK_MS),
    stuckMs: readEnvMs("VOICE_STUCK_MS", DEFAULTS.STUCK_MS),
    busyCeilingMs: readEnvMs("VOICE_BUSY_CEILING_MS", DEFAULTS.BUSY_CEILING_MS),
    statusPath: (process.env.VOICE_STATUS_PATH || "").trim() || DEFAULTS.STATUS_PATH,
    enabled: process.env.VOICE_ENABLED !== "false",
  };

  const v = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    lockObservedAt: null,   // ms — when current lock first appeared
    idleSince: null,        // ms — when the held lock last went quiet (speaking: false)
    lockStuckAlerted: false,
    lockLongAlerted: false,
    lastSeenAt: null,       // ms — last tick that actually observed the radio
    snapshot: null,
  };

  // Deliberately NOT restoring lockObservedAt/lockStuckAlerted. The
  // held-duration is a claim about continuous observation, and a restart
  // breaks exactly that: if the radio restarted too, the lock is new but
  // the persisted timer is old, and Voice would alert "held 47 min" on a
  // lock it had watched for seconds. Starting the clock fresh costs at
  // most one stuckMs window before a genuinely stuck lock is reported.
  try {
    if (fs.existsSync(STATE_FILE)) JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) { console.warn(`[voice] state load: ${e.message}`); }

  function persist() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lockObservedAt: v.lockObservedAt, idleSince: v.idleSince, lockStuckAlerted: v.lockStuckAlerted, lockLongAlerted: v.lockLongAlerted }, null, 2)); }
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
    const r = await probeJson(`${RADIO_BASE}${cfg.statusPath}`);
    const now = Date.now();
    v.lastTick = now;
    if (!r.ok || !r.json) {
      // We could not observe the radio. The held-duration counts OBSERVED
      // time, so discount the blind interval by pushing the start stamp
      // forward — otherwise an outage silently accrues "held" minutes and
      // trips the stuck alert (which restarts the radio) on no evidence.
      if (v.lastSeenAt != null) {
        if (v.lockObservedAt != null) v.lockObservedAt += now - v.lastSeenAt;
        if (v.idleSince != null) v.idleSince += now - v.lastSeenAt;
      }
      v.lastSeenAt = now;
      return;
    }
    v.lastSeenAt = now;
    const snap = lockFromStatus(r.json);
    if (!snap) return;
    v.snapshot = snap;
    const min = (ms) => Math.round(ms / 60000);
    for (const ev of advanceLock(v, snap, now, cfg)) {
      if (ev.transition === "VOICE_LOCK_STUCK") {
        logAlert("VOICE_LOCK_STUCK", `talk-segment lock held ${min(ev.heldForMs)} min, idle ${min(ev.idleForMs)} min — investigate`);
        publish("KANNAKA.staff.voice.lock.stuck", {
          heldForMs: ev.heldForMs,
          idleForMs: ev.idleForMs,
          currentSpeaker: snap.currentSpeaker,
          voiceQueue: snap.voiceQueue,
        });
      } else if (ev.transition === "VOICE_LOCK_LONG") {
        logAlert("VOICE_LOCK_LONG", `talk-segment lock busy ${min(ev.heldForMs)} min (speaking) — long-form running long; no action taken`);
        publish("KANNAKA.staff.voice.lock.long", {
          heldForMs: ev.heldForMs,
          currentSpeaker: snap.currentSpeaker,
          voiceQueue: snap.voiceQueue,
        });
      } else if (ev.transition === "VOICE_LOCK_RECOVERED") {
        logAlert("VOICE_LOCK_RECOVERED", `lock cleared after ${min(ev.heldForMs)} min`);
        publish("KANNAKA.staff.voice.lock.recovered", { heldForMs: ev.heldForMs });
      }
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
        lockIdleForMs: v.idleSince ? Date.now() - v.idleSince : 0,
        lockStuckAlerted: v.lockStuckAlerted,
        lockLongAlerted: v.lockLongAlerted,
      };
    },
    tick,
  };
}

module.exports = { bootVoice, lockFromStatus, advanceLock, DEFAULTS };
