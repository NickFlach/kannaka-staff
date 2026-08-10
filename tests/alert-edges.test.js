"use strict";

// Alert edges that were firing when they shouldn't, or being swallowed
// when they should: Curator's warmup suppression and history-window
// classification, and Ear's dead-air streak.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { evaluateAlbums } = require("../src/staff/curator");
const { bootEar, nextSilentState } = require("../src/staff/ear");

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const CFG = {
  starvingMs: 48 * HOUR,
  agingMs: 12 * HOUR,
  minHistoryForAlerts: 30,
};

const transitions = (r) => r.alerts.map((a) => a.transition);

// ── #63: warmup must delay the STARVING alert, not consume it ───

test("#63 regression: an album starving during warmup still alerts once warmup ends", () => {
  const album = { album: "Old Album", lastPlayed: NOW - 72 * HOUR, ageMs: 72 * HOUR, playsInWindow: 1 };

  // Tick 1 — history too short, so the alert is suppressed.
  const warm = evaluateAlbums({ cfg: CFG, albums: [album], historyLen: 10, now: NOW });
  assert.strictEqual(warm.alertsActive, false);
  assert.deepStrictEqual(transitions(warm), [], "no alert during warmup");
  assert.strictEqual(warm.classification["Old Album"], "starving", "display state still updates");
  assert.strictEqual(warm.alerted["Old Album"], undefined, "but the alert edge is NOT consumed");

  // Tick 2 — history is now meaningful and the album is still starving.
  const real = evaluateAlbums({
    cfg: CFG, albums: [album], historyLen: 30, now: NOW,
    classification: warm.classification, alerted: warm.alerted, everPlayed: warm.everPlayed,
  });
  assert.deepStrictEqual(transitions(real), ["CURATOR_ALBUM_STARVING"]);
  assert.strictEqual(real.alerted["Old Album"], "starving");
});

// ── #46: same for NEVER_PLAYED ──────────────────────────────────

test("#46 regression: an album never played during warmup still alerts once warmup ends", () => {
  const album = { album: "Ghost Album", lastPlayed: null, ageMs: null, playsInWindow: 0 };

  const warm = evaluateAlbums({ cfg: CFG, albums: [album], historyLen: 5, now: NOW });
  assert.deepStrictEqual(transitions(warm), []);
  assert.strictEqual(warm.classification["Ghost Album"], "never");
  assert.strictEqual(warm.alerted["Ghost Album"], undefined);

  const real = evaluateAlbums({
    cfg: CFG, albums: [album], historyLen: 40, now: NOW,
    classification: warm.classification, alerted: warm.alerted, everPlayed: warm.everPlayed,
  });
  assert.deepStrictEqual(transitions(real), ["CURATOR_ALBUM_NEVER_PLAYED"]);
});

test("#46/#63: an alert already emitted is not re-emitted on the next tick", () => {
  const album = { album: "Old Album", lastPlayed: NOW - 72 * HOUR, ageMs: 72 * HOUR, playsInWindow: 1 };
  const first = evaluateAlbums({ cfg: CFG, albums: [album], historyLen: 30, now: NOW });
  assert.deepStrictEqual(transitions(first), ["CURATOR_ALBUM_STARVING"]);
  const second = evaluateAlbums({
    cfg: CFG, albums: [album], historyLen: 30, now: NOW,
    classification: first.classification, alerted: first.alerted, everPlayed: first.everPlayed,
  });
  assert.deepStrictEqual(transitions(second), [], "no alert storm");
});

// ── #5: aged out of the window is starving, not never-played ────

test("#5 regression: an album that ages out of the history window is STARVING, not NEVER_PLAYED", () => {
  // Tick 1: the album is in the window, played 4h ago → fresh.
  const inWindow = { album: "Real Album", lastPlayed: NOW - 4 * HOUR, ageMs: 4 * HOUR, playsInWindow: 3 };
  const first = evaluateAlbums({ cfg: CFG, albums: [inWindow], historyLen: 200, now: NOW });
  assert.strictEqual(first.classification["Real Album"], "fresh");
  assert.strictEqual(first.everPlayed["Real Album"], NOW - 4 * HOUR);

  // Tick 2, three days later: it has fallen out of the bounded window, so
  // the radio reports no play at all. Before the fix that read as "never
  // played — check that files exist" for a perfectly healthy album.
  const later = NOW + 72 * HOUR;
  const agedOut = { album: "Real Album", lastPlayed: null, ageMs: null, playsInWindow: 0 };
  const second = evaluateAlbums({
    cfg: CFG, albums: [agedOut], historyLen: 200, now: later,
    classification: first.classification, alerted: first.alerted, everPlayed: first.everPlayed,
  });
  assert.deepStrictEqual(transitions(second), ["CURATOR_ALBUM_STARVING"]);
  assert.strictEqual(second.classification["Real Album"], "starving");
  assert.match(second.alerts[0].message, /aged out of the last 200 tracks/);
});

test("#5: an album genuinely never seen still raises NEVER_PLAYED", () => {
  const r = evaluateAlbums({
    cfg: CFG,
    albums: [{ album: "Gifts for Humanity", lastPlayed: null, ageMs: null, playsInWindow: 0 }],
    historyLen: 200, now: NOW,
  });
  assert.deepStrictEqual(transitions(r), ["CURATOR_ALBUM_NEVER_PLAYED"]);
});

test("#5: the everPlayed ledger keeps the newest observed play", () => {
  const r1 = evaluateAlbums({
    cfg: CFG, albums: [{ album: "A", lastPlayed: NOW - 10 * HOUR, ageMs: 10 * HOUR, playsInWindow: 1 }],
    historyLen: 200, now: NOW,
  });
  const r2 = evaluateAlbums({
    cfg: CFG, albums: [{ album: "A", lastPlayed: NOW - 1 * HOUR, ageMs: 1 * HOUR, playsInWindow: 2 }],
    historyLen: 200, now: NOW, everPlayed: r1.everPlayed, classification: r1.classification, alerted: r1.alerted,
  });
  assert.strictEqual(r2.everPlayed.A, NOW - 1 * HOUR);
});

test("a starving album coming back into rotation raises REFRESHED", () => {
  const starving = { album: "B", lastPlayed: NOW - 72 * HOUR, ageMs: 72 * HOUR, playsInWindow: 0 };
  const first = evaluateAlbums({ cfg: CFG, albums: [starving], historyLen: 200, now: NOW });
  assert.deepStrictEqual(transitions(first), ["CURATOR_ALBUM_STARVING"]);
  const back = { album: "B", lastPlayed: NOW - 5 * 60 * 1000, ageMs: 5 * 60 * 1000, playsInWindow: 1 };
  const second = evaluateAlbums({
    cfg: CFG, albums: [back], historyLen: 200, now: NOW,
    classification: first.classification, alerted: first.alerted, everPlayed: first.everPlayed,
  });
  assert.deepStrictEqual(transitions(second), ["CURATOR_ALBUM_REFRESHED"]);
});

// ── #71: a failed sample breaks the dead-air streak ─────────────

const EAR = { confirmTicks: 2 };

test("#71 regression: a transport failure between two silent samples does not confirm dead air", () => {
  // silent → transport failure → silent. Before the fix the streak
  // survived the gap, reached confirmTicks, and fired the auto-recover
  // radio restart off two observations minutes apart.
  let s = nextSilentState({ silentStreak: 0, silentAlerted: false, sampleOk: true, isSilent: true, ...EAR });
  assert.strictEqual(s.silentStreak, 1);
  assert.strictEqual(s.alert, null);

  s = nextSilentState({ ...s, sampleOk: false, isSilent: false, ...EAR });
  assert.strictEqual(s.silentStreak, 0, "the failed sample breaks the streak");
  assert.strictEqual(s.alert, null);

  s = nextSilentState({ ...s, sampleOk: true, isSilent: true, ...EAR });
  assert.strictEqual(s.silentStreak, 1, "counting restarts, no false dead-air alert");
  assert.strictEqual(s.alert, null);
});

test("#71: genuinely consecutive silent samples still confirm dead air", () => {
  let s = nextSilentState({ silentStreak: 0, silentAlerted: false, sampleOk: true, isSilent: true, ...EAR });
  s = nextSilentState({ ...s, sampleOk: true, isSilent: true, ...EAR });
  assert.strictEqual(s.silentStreak, 2);
  assert.strictEqual(s.alert, "EAR_STREAM_SILENT");
  assert.strictEqual(s.silentAlerted, true);
});

test("#71: dead air is alerted once, not every tick", () => {
  let s = { silentStreak: 2, silentAlerted: true };
  s = nextSilentState({ ...s, sampleOk: true, isSilent: true, ...EAR });
  assert.strictEqual(s.alert, null);
  assert.strictEqual(s.silentStreak, 3);
});

test("#71: audio returning raises RECOVERED and clears the streak", () => {
  const s = nextSilentState({ silentStreak: 3, silentAlerted: true, sampleOk: true, isSilent: false, ...EAR });
  assert.strictEqual(s.alert, "EAR_STREAM_RECOVERED");
  assert.strictEqual(s.silentStreak, 0);
  assert.strictEqual(s.silentAlerted, false);
});

test("#71: a failed sample does not clear an alert that already fired", () => {
  // We lost the observation, not the outage — the RECOVERED edge must
  // wait for actual audio.
  const s = nextSilentState({ silentStreak: 3, silentAlerted: true, sampleOk: false, isSilent: false, ...EAR });
  assert.strictEqual(s.silentAlerted, true);
  assert.strictEqual(s.alert, null);
});

// ── #77: an in-progress streak survives a restart ───────────────

function bootEarWithState(persisted) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ear-test-"));
  const alertsFile = path.join(dir, "alerts.jsonl");
  fs.writeFileSync(path.join(dir, "ear-state.json"), JSON.stringify(persisted));
  // Ear's timers are unref'd, so this boot cannot outlive the test or
  // reach a live /stream fetch.
  return bootEar({ streamUrl: "http://127.0.0.1:1/stream", alertsFile, staffBus: null });
}

test("#77 regression: a recent in-progress silent streak is restored across a restart", () => {
  // Before the fix only silentAlerted was persisted, so a restart during
  // an outage reset the count and pushed the dead-air alert another
  // confirmTicks into the future.
  const ear = bootEarWithState({ silentAlerted: false, silentStreak: 1, silentStreakAt: Date.now() - 1000 });
  assert.strictEqual(ear.getState().silentStreak, 1);
});

test("#77: a stale streak from a long-dead process is NOT restored", () => {
  const ear = bootEarWithState({ silentAlerted: false, silentStreak: 1, silentStreakAt: Date.now() - 7 * 24 * 60 * 60 * 1000 });
  assert.strictEqual(ear.getState().silentStreak, 0);
});

test("#77: a state file with no streak field still loads (older format)", () => {
  const ear = bootEarWithState({ silentAlerted: true });
  assert.strictEqual(ear.getState().silentStreak, 0);
  assert.strictEqual(ear.getState().silentAlerted, true);
});
