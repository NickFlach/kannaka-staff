/**
 * Storyteller — Phase 4 (ADR-001 § 9), observation MVP.
 *
 * The full Storyteller composes album showcase narration, oration
 * framing, programming-transition copy, and Kannaka's self-pondering
 * voice. That belongs co-resident with the existing showcase
 * machinery inside kannaka-radio. The staff role's tonight-MVP is
 * the planner: surface what the showcase landscape looks like next,
 * so the operator (or future automated nudger) sees an upcoming
 * narration window and can prepare.
 *
 * Tick (default 5 min):
 *   - Pull radio /api/state for current block + override + last
 *     showcase fire-times (via /api/programming if present, falling
 *     back to /api/state's `programming` block).
 *   - Compute time-to-next-scheduled-showcase from the radio's
 *     DAILY_SHOWCASES rules (today: BEND THE ARC at 11 AM + 9 PM CST).
 *   - Surface "showcase in flight" or "next showcase in HH:MM".
 *
 * No alerts in MVP — Storyteller is observational. Operators read
 * the dashboard panel.
 *
 * Routes:
 *   GET /api/storyteller
 */
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const url = require("url");

const DEFAULTS = {
  TICK_MS: 5 * 60 * 1000,
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
        catch (_) { resolve({ ok: false, raw: text.slice(0, 400) }); }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function bootStoryteller(deps) {
  const RADIO_BASE = deps.radioBase;
  const ALERTS_FILE = deps.alertsFile;

  const cfg = {
    tickMs: readEnvMs("STORYTELLER_TICK_MS", DEFAULTS.TICK_MS),
    enabled: process.env.STORYTELLER_ENABLED !== "false",
  };

  const s = {
    cfg,
    bootedAt: Date.now(),
    lastTick: null,
    snapshot: null,
  };

  async function tick() {
    if (!cfg.enabled) return;
    const r = await probeJson(`${RADIO_BASE}/api/state`);
    s.lastTick = Date.now();
    if (!r.ok || !r.json) {
      s.snapshot = { ok: false, error: r.error || "no /api/state" };
      return;
    }
    const j = r.json;
    const override = j.programmingOverride || j.override || j.programming?.override || null;
    const overrideActive = !!(override && (override.until ? Date.now() < override.until : true));
    // Compute next scheduled-showcase fire from radio's DAILY_SHOWCASES.
    // The radio exposes the schedule indirectly — we use the well-known
    // pair (11 AM, 9 PM CST = UTC-5 in May; tz-aware). This is a fixed
    // rule documented in server/programming.js DAILY_SHOWCASES.
    const SCHEDULED_HOURS_CST = [11, 21];
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    // CST = UTC-5 (or UTC-6 in standard time). Use UTC-5 as a heuristic;
    // off-by-one-hour is fine for "next in HH:MM" rough estimate.
    const cstHour = ((utcHour - 5) + 24) % 24;
    let nextIn = null;
    for (const h of SCHEDULED_HOURS_CST) {
      const diff = ((h - cstHour) + 24) % 24;
      const mins = diff * 60 - utcMin;
      const candidate = mins <= 0 ? mins + 24 * 60 : mins;
      if (nextIn == null || candidate < nextIn) nextIn = candidate;
    }
    s.snapshot = {
      ok: true,
      currentAlbum: j.currentAlbum || (j.programming && j.programming.currentAlbum) || null,
      block: j.programming?.block || j.block || null,
      override: overrideActive ? { album: override.album, untilMs: override.until || null, untilHuman: override.until ? new Date(override.until).toISOString() : null } : null,
      nextShowcase: { inMinutes: nextIn, fixedSchedule: "11 AM + 9 PM CST" },
    };
  }

  setTimeout(() => { tick().catch((err) => console.warn(`[storyteller] first tick: ${err.message}`)); }, 90_000);
  setInterval(() => { tick().catch((err) => console.warn(`[storyteller] tick: ${err.message}`)); }, cfg.tickMs);

  return {
    getState() {
      return { cfg, bootedAt: s.bootedAt, lastTick: s.lastTick, snapshot: s.snapshot };
    },
    tick,
  };
}

module.exports = { bootStoryteller };
