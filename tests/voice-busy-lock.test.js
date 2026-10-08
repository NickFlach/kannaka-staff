"use strict";

// A busy talk lock is not a stuck talk lock.
//
// 2026-10-08: the peace oration's TTS retried for about 15 minutes with the
// lock held and `speaking: true` the whole time. Voice called the lock stuck
// at 5 minutes, auto-recover restarted kannaka-radio, and that restart — not
// the lock — was what listeners heard: three times in one day, two orations
// and the artist story behind them lost. These tests pin the two clocks:
// STUCK reads idle time (speaking: false), LONG reads busy time, and only
// STUCK is a restart trigger (see src/index.js and ADR-003).

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const { advanceLock, DEFAULTS } = require("../src/staff/voice");

const MIN = 60 * 1000;
const cfg = { stuckMs: DEFAULTS.STUCK_MS, busyCeilingMs: DEFAULTS.BUSY_CEILING_MS };
const T0 = 1_700_000_000_000;
const fresh = () => ({ lockObservedAt: null, idleSince: null, lockStuckAlerted: false, lockLongAlerted: false });
const held = (speaking) => ({ lockHeld: true, speaking });
const free = { lockHeld: false, speaking: false };
const names = (evs) => evs.map((e) => e.transition);

// Observe every 90 s from T0 for `minutes`, with the given snapshot.
function observe(v, snap, fromMin, toMin) {
  const out = [];
  for (let t = fromMin * MIN; t <= toMin * MIN; t += 90 * 1000) out.push(...advanceLock(v, snap, T0 + t, cfg));
  return out;
}

test("defaults: idle threshold 15 min, busy ceiling 30 min", () => {
  assert.strictEqual(DEFAULTS.STUCK_MS, 15 * MIN);
  assert.strictEqual(DEFAULTS.BUSY_CEILING_MS, 30 * MIN);
});

test("2026-10-08 regression: a lock held 20 min while speaking is never STUCK", () => {
  const v = fresh();
  const evs = observe(v, held(true), 0, 20);
  assert.deepStrictEqual(names(evs), [], `no transition expected for a busy lock under the ceiling, got ${names(evs)}`);
  assert.strictEqual(v.lockStuckAlerted, false);
});

test("an idle lock is STUCK once past the idle threshold, exactly once", () => {
  const v = fresh();
  const evs = observe(v, held(false), 0, 40);
  assert.deepStrictEqual(names(evs), ["VOICE_LOCK_STUCK"]);
  assert.ok(evs[0].idleForMs > cfg.stuckMs);
});

test("the idle clock starts when speaking stops, not when the lock appeared", () => {
  const v = fresh();
  // 12 min busy, then quiet. STUCK must not fire until 15 idle minutes have passed.
  assert.deepStrictEqual(names(observe(v, held(true), 0, 12)), []);
  assert.deepStrictEqual(names(observe(v, held(false), 13.5, 26)), [], "only ~12.5 idle minutes so far");
  const later = observe(v, held(false), 27.5, 30);
  assert.deepStrictEqual(names(later), ["VOICE_LOCK_STUCK"]);
  assert.ok(later[0].heldForMs > later[0].idleForMs, "held longer than idle");
});

test("speaking again resets the idle clock", () => {
  const v = fresh();
  observe(v, held(false), 0, 10);
  observe(v, held(true), 11.5, 12);
  assert.strictEqual(v.idleSince, null);
  assert.deepStrictEqual(names(observe(v, held(false), 13.5, 27)), [], "idle restarted at 13.5, so 27 is under the threshold");
});

test("a busy lock past the ceiling is LONG, once, and still never STUCK", () => {
  const v = fresh();
  const evs = observe(v, held(true), 0, 60);
  assert.deepStrictEqual(names(evs), ["VOICE_LOCK_LONG"]);
  assert.ok(evs[0].heldForMs > cfg.busyCeilingMs);
});

test("release after an alert is RECOVERED and resets everything", () => {
  const v = fresh();
  observe(v, held(false), 0, 20);
  const evs = advanceLock(v, free, T0 + 21 * MIN, cfg);
  assert.deepStrictEqual(names(evs), ["VOICE_LOCK_RECOVERED"]);
  assert.deepStrictEqual(v, fresh());
});

test("release with no alert outstanding is silent", () => {
  const v = fresh();
  observe(v, held(true), 0, 3);
  assert.deepStrictEqual(names(advanceLock(v, free, T0 + 4 * MIN, cfg)), []);
});

test("a radio that reports no `speaking` field keeps the pre-2026-10-08 behaviour (idle)", () => {
  const v = fresh();
  const evs = observe(v, { lockHeld: true, speaking: null }, 0, 20);
  assert.deepStrictEqual(names(evs), ["VOICE_LOCK_STUCK"]);
});
