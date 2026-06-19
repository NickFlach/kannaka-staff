/**
 * Distributor — fourth staff member online (ADR-001 § 7, Phase 2).
 *
 * Owns "move finished artifacts into the right place". For the first
 * cut, Distributor wraps the kannaka-radio `scripts/release-album.sh`
 * pipeline that was formalized 2026-05-12 — it knows how to:
 *
 *   - render music via Suno V4_5PLUS direct
 *   - render cover art via OBC Pixel Atelier
 *   - copy v1 MP3s into kannaka-radio/music/
 *   - assemble the YouTube album-slideshow MP4 + upload
 *   - scp MP3s to Oracle + git pull + systemctl restart
 *   - optional post-track-announce for the lead track
 *
 * Distributor's job is to invoke that pipeline on demand and report
 * progress + alerts back to the operator stream. A future Creator
 * role will eventually emit publish requests automatically; for now
 * the operator triggers them from the staff dashboard or via the
 * HTTP action.
 *
 * Module surface:
 *   getState()                     → status snapshot (current job +
 *                                    last N completed)
 *   requestPublish(opts)           → start a job. opts = { configPath,
 *                                    skip }. configPath must be a
 *                                    release-album.sh-compatible JSON.
 *                                    skip is an optional comma list
 *                                    of phases (passed as RELEASE_SKIP
 *                                    env).
 *   getLog(jobId)                  → tail the running job's log
 *
 * Alerts emitted into alerts.jsonl:
 *   DISTRIBUTOR_JOB_START   a publish job was launched
 *   DISTRIBUTOR_JOB_DONE    job exited 0
 *   DISTRIBUTOR_JOB_FAILED  job exited non-zero OR timed out
 *
 * Persistence: <ALERTS_FILE dir>/distributor-state.json
 *
 * NOT in scope tonight (deliberate — keep the role small + verifiable):
 *   - NATS subscription for KANNAKA.distributor.publish — wire when
 *     the swarm message bus has a release-album convention.
 *   - KAX upload of audio artifacts.
 *   - Lyrics archival to a creation log.
 *   - Auto-applying the dj-engine.js / programming.js patches that
 *     release-album.sh's preflight currently demands the human prep.
 *
 * Safety: refuses to start a second job while one is in flight. Job
 * timeout default 60 min (Suno rendering + ffmpeg + Oracle deploy
 * typically completes in 25-40 min; 60 leaves headroom).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULTS = {
  JOB_TIMEOUT_MS: 60 * 60 * 1000,    // 60 min
  HISTORY_MAX: 12,
  LOG_TAIL_MAX: 200,                  // most-recent N lines kept in memory
  RELEASE_SCRIPT: "/home/opc/kannaka-radio/scripts/release-album.sh",
};

function readEnvStr(name, fallback) {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}
function readEnvMs(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function bootDistributor(deps) {
  const ALERTS_FILE = deps.alertsFile;
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "distributor-state.json");

  const cfg = {
    jobTimeoutMs: readEnvMs("DISTRIBUTOR_JOB_TIMEOUT_MS", DEFAULTS.JOB_TIMEOUT_MS),
    releaseScript: readEnvStr("DISTRIBUTOR_RELEASE_SCRIPT", DEFAULTS.RELEASE_SCRIPT),
    enabled: process.env.DISTRIBUTOR_ENABLED !== "false",
  };

  const d = {
    cfg,
    bootedAt: Date.now(),
    current: null,    // { id, configPath, name, startedAt, pid, skip, logTail: [], timeoutHandle }
    history: [],      // {id, configPath, name, startedAt, finishedAt, ok, exitCode, message}
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (Array.isArray(persisted.history)) d.history = persisted.history.slice(-DEFAULTS.HISTORY_MAX);
    }
  } catch (e) {
    console.warn(`[distributor] state load: ${e.message}`);
  }

  function persist() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ history: d.history }, null, 2));
    } catch (e) {
      console.warn(`[distributor] state save: ${e.message}`);
    }
  }

  function logAlert(transition, message) {
    const entry = {
      ts: new Date().toISOString(),
      probe: "distributor",
      transition,
      message,
    };
    try {
      fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.warn(`[distributor] alert write: ${e.message}`);
    }
    console.log(`[distributor] ${transition}: ${message}`);
  }

  function readAlbumName(configPath) {
    try {
      const j = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return j.name || "(unnamed)";
    } catch (_) { return "(unreadable config)"; }
  }

  /**
   * Start a publish job.
   * @param {{configPath: string, skip?: string}} opts
   * @returns {{ok: boolean, jobId?: string, name?: string, error?: string}}
   */
  function requestPublish(opts) {
    if (!cfg.enabled) return { ok: false, error: "distributor disabled" };
    if (d.current) {
      return { ok: false, error: `job ${d.current.id} already in flight (${d.current.name})` };
    }
    const configPath = (opts && opts.configPath) || "";
    if (!configPath || !fs.existsSync(configPath)) {
      return { ok: false, error: `configPath missing or not found: ${configPath}` };
    }
    if (!fs.existsSync(cfg.releaseScript)) {
      return { ok: false, error: `release script not found: ${cfg.releaseScript}` };
    }
    const name = readAlbumName(configPath);
    const id = `pub_${Date.now().toString(36)}`;
    const skip = (opts && opts.skip) || "";
    const startedAt = Date.now();
    const job = {
      id, configPath, name, startedAt, skip,
      pid: null,
      logTail: [],
      timeoutHandle: null,
    };
    let finalized = false;

    const env = { ...process.env };
    if (skip) env.RELEASE_SKIP = skip;
    const child = spawn("bash", [cfg.releaseScript, configPath], { env });
    job.pid = child.pid;
    d.current = job;

    logAlert("DISTRIBUTOR_JOB_START", `${id} "${name}" — ${configPath}${skip ? ` (skip=${skip})` : ""}`);

    const onChunk = (buf) => {
      const lines = buf.toString("utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        job.logTail.push(line);
        if (job.logTail.length > DEFAULTS.LOG_TAIL_MAX) job.logTail.shift();
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    job.timeoutHandle = setTimeout(() => {
      if (d.current && d.current.id === id) {
        try { child.kill("SIGKILL"); } catch (_) {}
      }
    }, cfg.jobTimeoutMs);

    child.on("close", (code, signal) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(job.timeoutHandle);
      const finishedAt = Date.now();
      const ok = code === 0 && !signal;
      const tailJoined = job.logTail.slice(-6).join(" | ").slice(0, 600);
      const message = ok
        ? `${id} ok in ${Math.round((finishedAt - startedAt) / 1000)}s · ${name}`
        : `${id} FAILED exit=${code} signal=${signal || "-"} in ${Math.round((finishedAt - startedAt) / 1000)}s · last: ${tailJoined}`;
      const record = {
        id, configPath, name, startedAt, finishedAt,
        ok, exitCode: code, signal: signal || null,
        message,
      };
      d.history.push(record);
      if (d.history.length > DEFAULTS.HISTORY_MAX) d.history.shift();
      d.current = null;
      logAlert(ok ? "DISTRIBUTOR_JOB_DONE" : "DISTRIBUTOR_JOB_FAILED", message);
      persist();
    });

    child.on("error", (err) => {
      if (finalized) return;
      finalized = true;
      // spawn-time failure (script missing, EACCES, etc.)
      const finishedAt = Date.now();
      const message = `${id} FAILED to spawn: ${err.message}`;
      d.history.push({
        id, configPath, name, startedAt, finishedAt,
        ok: false, exitCode: null, signal: null, message,
      });
      d.current = null;
      try { clearTimeout(job.timeoutHandle); } catch (_) {}
      logAlert("DISTRIBUTOR_JOB_FAILED", message);
      persist();
    });

    return { ok: true, jobId: id, name };
  }

  return {
    getState() {
      const cur = d.current
        ? {
            id: d.current.id,
            name: d.current.name,
            configPath: d.current.configPath,
            startedAt: d.current.startedAt,
            elapsedMs: Date.now() - d.current.startedAt,
            skip: d.current.skip || "",
            logTail: d.current.logTail.slice(-30),
          }
        : null;
      return {
        cfg,
        bootedAt: d.bootedAt,
        current: cur,
        history: d.history.slice(-DEFAULTS.HISTORY_MAX).reverse(),
      };
    },
    requestPublish,
    /** Tail of the live job's stdout/stderr (most-recent up to LOG_TAIL_MAX lines). */
    getLog() {
      if (!d.current) return { ok: false, error: "no job in flight" };
      return { ok: true, jobId: d.current.id, lines: d.current.logTail.slice() };
    },
  };
}

module.exports = { bootDistributor };
