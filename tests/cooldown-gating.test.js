"use strict";

// Cooldown gating for the auto-recover (stream.silent + voice.lock.stuck →
// restart-radio) and auto-rescue (album.starving → showcase) closed loops.
// Both loops gate on cooldownRemainingMs; a positive result means "blocked,
// don't fire". These tests lock in the boundary behavior and the shared
// auto-recover bucket that stops a stuck-lock + dead-air pair from firing a
// double restart.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const { cooldownRemainingMs } = require("../src/index.js");

const RECOVER = 30 * 60 * 1000; // AUTO_RECOVER default
const RESCUE = 24 * 60 * 60 * 1000; // AUTO_RESCUE default
const NOW = 1_700_000_000_000;

test("fresh start (lastTs=0) → 0 remaining, action may fire", () => {
  assert.strictEqual(cooldownRemainingMs(0, RECOVER, NOW), 0);
});

test("just fired → full cooldown remaining, blocked", () => {
  assert.strictEqual(cooldownRemainingMs(NOW, RECOVER, NOW), RECOVER);
});

test("half elapsed → half remaining", () => {
  const lastTs = NOW - RECOVER / 2;
  assert.strictEqual(cooldownRemainingMs(lastTs, RECOVER, NOW), RECOVER / 2);
});

test("exactly at the boundary → 0 (sinceLast === cooldown is allowed)", () => {
  const lastTs = NOW - RECOVER;
  assert.strictEqual(cooldownRemainingMs(lastTs, RECOVER, NOW), 0);
});

test("1ms past the boundary → 0", () => {
  const lastTs = NOW - (RECOVER + 1);
  assert.strictEqual(cooldownRemainingMs(lastTs, RECOVER, NOW), 0);
});

test("1ms before the boundary → 1ms remaining (still blocked)", () => {
  const lastTs = NOW - (RECOVER - 1);
  assert.strictEqual(cooldownRemainingMs(lastTs, RECOVER, NOW), 1);
});

test("shared auto-recover bucket: second trigger after first fire is blocked", () => {
  // stream.silent fires first, stamping lastRestartTs=NOW.
  let lastRestartTs = 0;
  assert.strictEqual(cooldownRemainingMs(lastRestartTs, RECOVER, NOW), 0, "first fire allowed");
  lastRestartTs = NOW;
  // voice.lock.stuck arrives 1 minute later — same bucket → still blocked.
  const later = NOW + 60 * 1000;
  assert.ok(cooldownRemainingMs(lastRestartTs, RECOVER, later) > 0, "shared bucket blocks the co-occurring restart");
});

test("auto-rescue 24h window: 23h ago is blocked, 25h ago is allowed", () => {
  assert.ok(cooldownRemainingMs(NOW - 23 * 60 * 60 * 1000, RESCUE, NOW) > 0, "23h < 24h → blocked");
  assert.strictEqual(cooldownRemainingMs(NOW - 25 * 60 * 60 * 1000, RESCUE, NOW), 0, "25h > 24h → allowed");
});
