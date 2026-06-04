/**
 * Growth — second staff role online (ADR-001 § 6, Phase 1 critical).
 *
 * Watches the medium. Schedules dream consolidation on a cadence so
 * the HRM doesn't drift into the timeout-blown territory that broke
 * kannaka-ask in early May 2026.
 *
 * Decision tree on each Growth tick (default 15 min):
 *
 *   - dream already in flight  → no-op
 *   - HRM size > HARD threshold (95 MB default)  → fire lite dream NOW
 *   - HRM size > SOFT threshold (70 MB default) AND last dream > 6h ago
 *                                                → fire lite dream
 *   - last successful dream > NORMAL_INTERVAL (12h) ago
 *                                                → fire lite dream
 *   - else → no-op, sample HRM history
 *
 * Why lite, not deep: ADR-001 § Dream Maintenance — the bug is that
 * deep dreams time out on bloated mediums and the workaround was
 * routing orations through Anthropic-direct. Lite dreams complete
 * reliably and are the right tool until the deep-dream chunking
 * lands in kannaka-memory itself. When that lands, flip the default
 * via GROWTH_DEFAULT_MODE=deep.
 *
 * State persistence: <ALERTS_FILE dir>/growth-state.json. Restarts
 * preserve `lastDream` and the in-memory hrmHistory tail (so the
 * dashboard's HRM trend doesn't lose all context across a restart).
 *
 * Alerts: state transitions are logged to alerts.jsonl using the
 * watcher's writer so the operator's one alert stream still tells
 * the whole story. Transitions emitted by Growth:
 *
 *   GROWTH_DREAM_START      a dream was launched (kind: lite|deep, reason)
 *   GROWTH_DREAM_DONE       successful return; size delta in message
 *   GROWTH_DREAM_FAILED     non-zero exit OR timeout; raw stderr tail
 *   GROWTH_HRM_BLOATED      one-shot when crossing HARD threshold while
 *                           a dream is unable to run (e.g. in-flight)
 *   GROWTH_HRM_RECOVERED    HRM came back under SOFT after being bloated
 *
 * Exposed API on the http server (wired by src/index.js):
 *   GET  /api/growth  →  { lastTick, hrm, lastDream, dreamHistory, hrmHistory }
 */
"use strict";

const { exec, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  TICK_MS: 15 * 60 * 1000,            // 15 min
  // Size-based thresholds are tuned for the primary HRM (37 MB typical,
  // 70 MB worrying, 95 MB critical). Hosts whose HRM is small but
  // memory-count grows fast (e.g. the witness, which accumulates audio:
  // perception ticks) should override these via env vars to lower
  // values OR rely on the count-based thresholds below instead.
  HRM_SOFT_MB: 70,
  HRM_HARD_MB: 95,
  // Count-based thresholds — added 2026-05-14 after the witness HRM
  // blew up to 7753 entries while staying small in bytes. A host
  // exceeding the count threshold fires the same lite dream as for
  // size — the dream pass + downstream prune-cron drives the count
  // back down. Defaults are generous for the primary HRM; the
  // witness should env-override to ~150 / ~300.
  MEMORY_SOFT: 1200,
  MEMORY_HARD: 2000,
  NORMAL_INTERVAL_MS: 12 * 60 * 60 * 1000,  // 12h
  SOFT_MIN_GAP_MS: 6 * 60 * 60 * 1000,      // 6h
  DREAM_TIMEOUT_MS: 12 * 60 * 1000,         // 12 min — slightly more than
                                            // the watcher's trigger-dream
                                            // budget so we can detect a
                                            // hang vs. a real long dream
  DREAM_HISTORY_MAX: 20,
  HRM_HISTORY_MAX: 96,                       // 96 × 15min = 24h trend
};

function readEnvMs(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function readEnvMB(name, fallback) {
  const v = parseFloat(process.env[name] || "");
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function readEnvStr(name, fallback) {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

function bootGrowth(deps) {
  const HRM_PATH = deps.hrmPath;
  const ALERTS_FILE = deps.alertsFile;
  const KANNAKA_BIN = readEnvStr("KANNAKA_BIN", "/home/opc/kannaka-memory/target/release/kannaka");
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "growth-state.json");

  const cfg = {
    tickMs: readEnvMs("GROWTH_TICK_MS", DEFAULTS.TICK_MS),
    hrmSoftMB: readEnvMB("GROWTH_HRM_SOFT_MB", DEFAULTS.HRM_SOFT_MB),
    hrmHardMB: readEnvMB("GROWTH_HRM_HARD_MB", DEFAULTS.HRM_HARD_MB),
    memorySoft: parseInt(process.env.GROWTH_MEMORY_SOFT || "", 10) || DEFAULTS.MEMORY_SOFT,
    memoryHard: parseInt(process.env.GROWTH_MEMORY_HARD || "", 10) || DEFAULTS.MEMORY_HARD,
    normalIntervalMs: readEnvMs("GROWTH_NORMAL_INTERVAL_MS", DEFAULTS.NORMAL_INTERVAL_MS),
    softMinGapMs: readEnvMs("GROWTH_SOFT_MIN_GAP_MS", DEFAULTS.SOFT_MIN_GAP_MS),
    dreamTimeoutMs: readEnvMs("GROWTH_DREAM_TIMEOUT_MS", DEFAULTS.DREAM_TIMEOUT_MS),
    defaultMode: readEnvStr("GROWTH_DEFAULT_MODE", "lite"),
    enabled: process.env.GROWTH_ENABLED !== "false",  // on by default; opt-out
  };

  // Internal state — exposed read-only via getState().
  const g = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    inFlight: null,            // { startedAt, mode, reason, timer }
    lastDream: null,            // { ts, mode, ok, durationMs, message, before, after, reason }
    dreamHistory: [],           // newest last
    hrmHistory: [],             // [{ts, sizeMB, memoryCount|null}]
    bloatedAlerted: false,      // edge-trigger for GROWTH_HRM_BLOATED
  };

  // ── load persisted state on boot (best-effort) ──────────
  try {
    if (fs.existsSync(STATE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (persisted && typeof persisted === "object") {
        if (persisted.lastDream) g.lastDream = persisted.lastDream;
        if (Array.isArray(persisted.dreamHistory)) g.dreamHistory = persisted.dreamHistory.slice(-DEFAULTS.DREAM_HISTORY_MAX);
        if (Array.isArray(persisted.hrmHistory)) g.hrmHistory = persisted.hrmHistory.slice(-DEFAULTS.HRM_HISTORY_MAX);
        if (typeof persisted.bloatedAlerted === "boolean") g.bloatedAlerted = persisted.bloatedAlerted;
      }
    }
  } catch (e) {
    console.warn(`[growth] state load: ${e.message}`);
  }

  function persist() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        lastDream: g.lastDream,
        dreamHistory: g.dreamHistory,
        hrmHistory: g.hrmHistory,
        bloatedAlerted: g.bloatedAlerted,
      }, null, 2));
    } catch (e) {
      console.warn(`[growth] state save: ${e.message}`);
    }
  }

  function logAlert(transition, message) {
    const entry = {
      ts: new Date().toISOString(),
      probe: "growth",
      transition,
      message,
    };
    try {
      fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.warn(`[growth] alert write: ${e.message}`);
    }
    console.log(`[growth] ${transition}: ${message}`);
  }

  // ── HRM sampling ────────────────────────────
  function sampleHrm() {
    let sizeMB = null;
    try {
      sizeMB = fs.statSync(HRM_PATH).size / (1024 * 1024);
    } catch (_) {
      // HRM file unreadable here — most likely external mode (radio host
      // doesn't have it). Growth's actions assume local HRM, so we just
      // skip tick decisions if size is null.
    }
    let memoryCount = null;
    try {
      const cachePath = path.join(process.env.HOME || "/home/opc", ".kannaka", "status-cache.json");
      if (fs.existsSync(cachePath)) {
        const j = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        memoryCount = j.total_memories || j.memory_count || j.memories || null;
      }
    } catch (_) { /* no count is fine */ }
    return { sizeMB, memoryCount };
  }

  // ── dream launcher ────────────────────────────
  function launchDream(mode, reason) {
    if (g.inFlight) {
      console.log(`[growth] dream already in flight (${g.inFlight.mode}); skip ${reason}`);
      return;
    }
    const before = sampleHrm();
    const startedAt = Date.now();
    logAlert("GROWTH_DREAM_START", `${mode} — ${reason} — HRM=${before.sizeMB != null ? before.sizeMB.toFixed(1) + "MB" : "?"}`);

    const child = exec(
      `${KANNAKA_BIN} dream --mode ${mode}`,
      { timeout: cfg.dreamTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const after = sampleHrm();
        const durationMs = Date.now() - startedAt;
        const ok = !err;
        const tailErr = (stderr || (err && err.message) || "").toString().trim().split("\n").slice(-4).join(" | ").slice(0, 400);
        const deltaMB = (before.sizeMB != null && after.sizeMB != null) ? (after.sizeMB - before.sizeMB) : null;
        const deltaCount = (before.memoryCount != null && after.memoryCount != null) ? (after.memoryCount - before.memoryCount) : null;
        const message = ok
          ? `${mode} ok in ${Math.round(durationMs / 1000)}s · HRM ${before.sizeMB?.toFixed(1) ?? "?"}→${after.sizeMB?.toFixed(1) ?? "?"} MB${deltaMB != null ? ` (Δ${deltaMB >= 0 ? "+" : ""}${deltaMB.toFixed(1)})` : ""}${deltaCount != null ? ` · mem ${deltaCount >= 0 ? "+" : ""}${deltaCount}` : ""}`
          : `${mode} FAILED after ${Math.round(durationMs / 1000)}s: ${tailErr || "no stderr"}`;
        const record = { ts: Date.now(), mode, ok, durationMs, message, before, after, reason };
        g.lastDream = record;
        g.dreamHistory.push(record);
        if (g.dreamHistory.length > DEFAULTS.DREAM_HISTORY_MAX) g.dreamHistory.shift();
        g.inFlight = null;
        logAlert(ok ? "GROWTH_DREAM_DONE" : "GROWTH_DREAM_FAILED", message);
        persist();
      }
    );
    g.inFlight = { startedAt, mode, reason, pid: child.pid };
  }

  // ── tick — decide whether to launch ─────────────────────
  function decide(sample) {
    if (!cfg.enabled) return null;
    if (g.inFlight) {
      const inFlightAge = Date.now() - g.inFlight.startedAt;
      return { action: "wait", reason: `dream in flight (${g.inFlight.mode}, ${Math.round(inFlightAge / 1000)}s)` };
    }
    if (sample.sizeMB == null) return { action: "skip", reason: "HRM not readable on this host" };

    // Edge-trigger bloat alert (one-shot per bloat episode). Either
    // size OR count crossing HARD counts as bloat — recovery requires
    // both to be back under SOFT.
    const sizeBloated = sample.sizeMB >= cfg.hrmHardMB;
    const countBloated = sample.memoryCount != null && sample.memoryCount >= cfg.memoryHard;
    const sizeRecovered = sample.sizeMB < cfg.hrmSoftMB;
    const countRecovered = sample.memoryCount == null || sample.memoryCount < cfg.memorySoft;
    if ((sizeBloated || countBloated) && !g.bloatedAlerted) {
      const reason = sizeBloated
        ? `HRM=${sample.sizeMB.toFixed(1)} MB >= ${cfg.hrmHardMB} MB`
        : `${sample.memoryCount} memories >= ${cfg.memoryHard}`;
      logAlert("GROWTH_HRM_BLOATED", `${reason} — kicking ${cfg.defaultMode} dream`);
      g.bloatedAlerted = true;
    } else if (sizeRecovered && countRecovered && g.bloatedAlerted) {
      const where = sample.memoryCount != null ? `${sample.sizeMB.toFixed(1)} MB / ${sample.memoryCount} memories` : `${sample.sizeMB.toFixed(1)} MB`;
      logAlert("GROWTH_HRM_RECOVERED", `${where} back under SOFT (${cfg.hrmSoftMB} MB / ${cfg.memorySoft} memories)`);
      g.bloatedAlerted = false;
    }

    const lastTs = g.lastDream && g.lastDream.ok ? g.lastDream.ts : 0;
    const sinceLast = Date.now() - lastTs;

    if (sample.sizeMB >= cfg.hrmHardMB) {
      return { action: "dream", mode: cfg.defaultMode, reason: `HRM ${sample.sizeMB.toFixed(1)} MB ≥ HARD ${cfg.hrmHardMB} MB` };
    }
    if (sample.memoryCount != null && sample.memoryCount >= cfg.memoryHard) {
      return { action: "dream", mode: cfg.defaultMode, reason: `${sample.memoryCount} memories ≥ HARD ${cfg.memoryHard}` };
    }
    if (sample.sizeMB >= cfg.hrmSoftMB && sinceLast >= cfg.softMinGapMs) {
      return { action: "dream", mode: cfg.defaultMode, reason: `HRM ${sample.sizeMB.toFixed(1)} MB ≥ SOFT ${cfg.hrmSoftMB} MB + ${Math.round(sinceLast / 3600000)}h since last` };
    }
    if (sample.memoryCount != null && sample.memoryCount >= cfg.memorySoft && sinceLast >= cfg.softMinGapMs) {
      return { action: "dream", mode: cfg.defaultMode, reason: `${sample.memoryCount} memories ≥ SOFT ${cfg.memorySoft} + ${Math.round(sinceLast / 3600000)}h since last` };
    }
    if (sinceLast >= cfg.normalIntervalMs) {
      return { action: "dream", mode: cfg.defaultMode, reason: `${Math.round(sinceLast / 3600000)}h since last (normal cadence)` };
    }
    const countStr = sample.memoryCount != null ? `, ${sample.memoryCount} memories` : "";
    return { action: "skip", reason: `HRM ${sample.sizeMB.toFixed(1)} MB${countStr}, last dream ${Math.round(sinceLast / 60000)}m ago` };
  }

  function tick() {
    const sample = sampleHrm();
    g.hrmHistory.push({ ts: Date.now(), sizeMB: sample.sizeMB, memoryCount: sample.memoryCount });
    if (g.hrmHistory.length > DEFAULTS.HRM_HISTORY_MAX) g.hrmHistory.shift();

    const decision = decide(sample);
    g.lastTick = { ts: Date.now(), decision, sample };
    if (decision && decision.action === "dream") {
      launchDream(decision.mode, decision.reason);
    }
    persist();
  }

  // First tick deferred ~30s so a fresh boot doesn't fire a dream before
  // the watcher has had a chance to surface its baseline probes.
  setTimeout(tick, 30_000);
  setInterval(tick, cfg.tickMs);

  // Public surface for HTTP route + manual ops.
  return {
    getState() {
      return {
        cfg,
        bootedAt: g.bootedAt,
        lastTick: g.lastTick,
        inFlight: g.inFlight,
        hrm: sampleHrm(),
        lastDream: g.lastDream,
        dreamHistory: g.dreamHistory.slice(-DEFAULTS.DREAM_HISTORY_MAX).reverse(),
        hrmHistory: g.hrmHistory,
        bloatedAlerted: g.bloatedAlerted,
      };
    },
    tick,
    /** Force a dream now — useful for the dashboard's manual button. */
    requestDream(mode, reason) {
      if (g.inFlight) {
        return { ok: false, error: `dream in flight (${g.inFlight.mode})` };
      }
      const m = (mode === "deep" || mode === "lite") ? mode : cfg.defaultMode;
      launchDream(m, reason || "manual request from dashboard");
      return { ok: true, mode: m };
    },
  };
}

module.exports = { bootGrowth };
