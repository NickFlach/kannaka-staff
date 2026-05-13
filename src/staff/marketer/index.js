/**
 * Marketer — Phase 3 (ADR-001 § 3).
 *
 * Wraps kannaka-radio's existing broadcasters/ infrastructure. The
 * operator (or a future Creator-triggered automation) posts a payload;
 * Marketer spawns a tiny in-line node call against the radio's
 * broadcastPost() so credentials, link policies, and per-platform
 * quirks (Bluesky 300-char + at:// → bsky.app conversion, Mastodon
 * 500-char, Telegram channel routing, Nostr npub) all stay shared
 * with the dream-cron + post-track-announce flows.
 *
 * Routes:
 *   POST /action/marketer-post?text=...&link=...
 *   GET  /api/marketer
 *
 * Alerts:
 *   MARKETER_POST_DONE     at least one platform succeeded
 *   MARKETER_POST_FAILED   every platform failed
 *
 * Persistence: <ALERTS_FILE dir>/marketer-state.json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULTS = {
  RADIO_REPO: "/home/opc/kannaka-radio",
  TIMEOUT_MS: 60 * 1000,
  HISTORY_MAX: 20,
};

function readEnvStr(name, fallback) {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

function bootMarketer(deps) {
  const ALERTS_FILE = deps.alertsFile;
  const STATE_FILE = path.join(path.dirname(ALERTS_FILE), "marketer-state.json");

  const cfg = {
    radioRepo: readEnvStr("MARKETER_RADIO_REPO", DEFAULTS.RADIO_REPO),
    timeoutMs: parseInt(process.env.MARKETER_TIMEOUT_MS || "", 10) || DEFAULTS.TIMEOUT_MS,
    enabled: process.env.MARKETER_ENABLED !== "false",
  };

  const m = {
    cfg,
    bootedAt: Date.now(),
    history: [],
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (Array.isArray(persisted.history)) m.history = persisted.history.slice(-DEFAULTS.HISTORY_MAX);
    }
  } catch (e) { console.warn(`[marketer] state load: ${e.message}`); }

  function persist() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ history: m.history }, null, 2)); }
    catch (e) { console.warn(`[marketer] state save: ${e.message}`); }
  }
  function logAlert(transition, message) {
    const entry = { ts: new Date().toISOString(), probe: "marketer", transition, message };
    try { fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n"); }
    catch (e) { console.warn(`[marketer] alert write: ${e.message}`); }
    console.log(`[marketer] ${transition}: ${message}`);
  }

  /**
   * Spawn `node -e` with the radio repo's broadcasters. We could
   * `require` them in-process, but child_process keeps the staff
   * service insulated from third-party crashes (Mastodon SDK has
   * historically thrown on schema drift).
   */
  function postViaRadioBroadcasters(text, link) {
    return new Promise((resolve) => {
      const code = `
        process.chdir(${JSON.stringify(cfg.radioRepo)});
        const { broadcastPost } = require(${JSON.stringify(path.join(cfg.radioRepo, "server/broadcasters"))});
        broadcastPost({ text: ${JSON.stringify(text)}, link: ${JSON.stringify(link || "")} }, { rootDir: ${JSON.stringify(cfg.radioRepo)} })
          .then((results) => { console.log(JSON.stringify(results)); process.exit(0); })
          .catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
      `;
      const child = spawn("node", ["-e", code], { cwd: cfg.radioRepo });
      let out = "", err = "";
      child.stdout.on("data", (c) => out += c.toString("utf8"));
      child.stderr.on("data", (c) => err += c.toString("utf8"));
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, cfg.timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        let results = null;
        try { results = JSON.parse(out.trim().split("\n").pop()); } catch (_) {}
        resolve({ ok: code === 0 && Array.isArray(results), exit: code, results, stderr: err.slice(-400) });
      });
      child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, exit: null, error: e.message }); });
    });
  }

  async function postMessage(query) {
    if (!cfg.enabled) return { ok: false, error: "marketer disabled" };
    const text = (query.text || "").toString();
    const link = (query.link || "").toString();
    if (!text) return { ok: false, error: "missing ?text=" };
    const id = `post_${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const r = await postViaRadioBroadcasters(text, link);
    const finishedAt = Date.now();
    const okCount = Array.isArray(r.results) ? r.results.filter((x) => x.ok).length : 0;
    const totalCount = Array.isArray(r.results) ? r.results.length : 0;
    const anyOk = okCount > 0;
    const summary = totalCount > 0
      ? `${okCount}/${totalCount} platforms ok: ${r.results.filter((x) => x.ok).map((x) => x.name).join(",") || "(none)"}`
      : `spawn exit=${r.exit} ${r.error || r.stderr || ""}`.slice(0, 240);
    const record = { id, text: text.slice(0, 160), link, startedAt, finishedAt, ok: anyOk, summary, results: r.results || [] };
    m.history.push(record);
    if (m.history.length > DEFAULTS.HISTORY_MAX) m.history.shift();
    logAlert(anyOk ? "MARKETER_POST_DONE" : "MARKETER_POST_FAILED", `${id} · ${summary}`);
    persist();
    return { ok: anyOk, jobId: id, okCount, totalCount, summary };
  }

  return {
    getState() {
      return {
        cfg,
        bootedAt: m.bootedAt,
        history: m.history.slice(-DEFAULTS.HISTORY_MAX).reverse(),
      };
    },
    postMessage,
  };
}

module.exports = { bootMarketer };
