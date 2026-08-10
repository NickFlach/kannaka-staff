"use strict";

// Voice and Storyteller are observation-only roles, and both were
// observing the wrong thing: Voice polled an endpoint that never carried
// the talk-segment lock, and Storyteller polled one that never carried
// the programming block, on a clock that was an hour off all winter.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const { lockFromStatus } = require("../src/staff/voice");
const { localHourMinute, nextShowcase } = require("../src/staff/storyteller");

// ── #17: the lock lives on /api/dj-voice/status ─────────────────

// The real shape of kannaka-radio's voiceDJ.getStatus().
const DJ_VOICE_STATUS = {
  enabled: true,
  speaking: false,
  lastIntro: "Kannaka",
  inTalkSegment: true,
  tracksSinceLastTalk: 2,
  currentMood: "reflective",
};

// The real shape of kannaka-radio's /api/state — note it carries only
// djVoice.enabled, with no lock field anywhere.
const API_STATE = {
  currentAlbum: "BEND THE ARC",
  albums: ["BEND THE ARC"],
  isLive: false,
  djVoice: { enabled: true },
  listeners: 4,
};

test("#17 regression: a held lock is detected from the dj-voice status payload", () => {
  const snap = lockFromStatus(DJ_VOICE_STATUS);
  assert.strictEqual(snap.lockHeld, true);
  assert.strictEqual(snap.speaking, false);
  assert.strictEqual(snap.currentSpeaker, "Kannaka");
});

test("#17 regression: /api/state carries no lock field at all", () => {
  // This is why VOICE_LOCK_STUCK could never fire: whatever the radio was
  // doing, the old poll target reported the lock as free.
  const snap = lockFromStatus(API_STATE);
  assert.strictEqual(snap.lockHeld, false);
});

test("#17: a free lock reads as free", () => {
  assert.strictEqual(lockFromStatus({ ...DJ_VOICE_STATUS, inTalkSegment: false }).lockHeld, false);
});

test("#17: legacy field names are still honoured", () => {
  assert.strictEqual(lockFromStatus({ _inTalkSegment: true }).lockHeld, true);
  assert.strictEqual(lockFromStatus({ talk: { locked: true } }).lockHeld, true);
  assert.strictEqual(lockFromStatus({ voice: { locked: true } }).lockHeld, true);
});

test("#17: a non-object payload yields null rather than throwing", () => {
  assert.strictEqual(lockFromStatus(null), null);
  assert.strictEqual(lockFromStatus("nope"), null);
});

// ── #4: the showcase clock across the DST boundary ──────────────

test("#4 regression: standard time is not an hour off", () => {
  // 2026-01-15 17:30 UTC. America/Chicago is UTC-6 in January, so local
  // time is 11:30 — inside the 11:00 showcase. The old fixed UTC-5
  // arithmetic said 12:30 and missed it entirely.
  const winter = new Date(Date.UTC(2026, 0, 15, 17, 30));
  assert.deepStrictEqual(localHourMinute(winter, "America/Chicago"), { hour: 11, minute: 30 });
});

test("#4: daylight time still resolves correctly", () => {
  // 2026-07-15 16:30 UTC → UTC-5 in July → 11:30 local.
  const summer = new Date(Date.UTC(2026, 6, 15, 16, 30));
  assert.deepStrictEqual(localHourMinute(summer, "America/Chicago"), { hour: 11, minute: 30 });
});

test("#4: midnight local reports hour 0, not 24", () => {
  const midnight = new Date(Date.UTC(2026, 0, 15, 6, 0)); // 00:00 CST
  assert.deepStrictEqual(localHourMinute(midnight, "America/Chicago"), { hour: 0, minute: 0 });
});

// ── #73: the active showcase window ─────────────────────────────

const HOURS = [11, 21];
const WINDOW = 60;

test("#73 regression: during the fire hour the showcase reads as in progress", () => {
  // 11:30 local, i.e. half an hour into the 11:00 showcase. The old
  // arithmetic produced (11-11)*60 - 30 = -30, mapped that to +23h30m,
  // and told the operator the next showcase was nearly a day away while
  // one was running.
  const r = nextShowcase({ hour: 11, minute: 30 }, HOURS, WINDOW);
  assert.strictEqual(r.inProgress, true);
  assert.strictEqual(r.inMinutes, 0);
});

test("#73: exactly at fire time reads as in progress", () => {
  const r = nextShowcase({ hour: 21, minute: 0 }, HOURS, WINDOW);
  assert.strictEqual(r.inProgress, true);
});

test("#73: once the window closes it counts down to the next slot", () => {
  // 12:00 local — the 11:00 window has closed, so the next is 21:00, 9h out.
  const r = nextShowcase({ hour: 12, minute: 0 }, HOURS, WINDOW);
  assert.strictEqual(r.inProgress, false);
  assert.strictEqual(r.inMinutes, 9 * 60);
});

test("#73: before the first slot it counts down to it", () => {
  const r = nextShowcase({ hour: 9, minute: 15 }, HOURS, WINDOW);
  assert.strictEqual(r.inProgress, false);
  assert.strictEqual(r.inMinutes, 105); // 1h45m to 11:00
});

test("#73: after the last slot it wraps to tomorrow's first", () => {
  const r = nextShowcase({ hour: 23, minute: 0 }, HOURS, WINDOW);
  assert.strictEqual(r.inProgress, false);
  assert.strictEqual(r.inMinutes, 12 * 60); // 23:00 → 11:00 next day
});
