"use strict";

// Probe → alert decision path. Every probe class (systemd, http, tcp, file-
// stat, exec) funnels through the same tick() hysteresis: a probe must fail
// FAIL_CONFIRM_TICKS (3) consecutive times before a FAILED alert is written,
// and a single success RECOVERs immediately. computeEffectiveOk makes that
// decision; transitionFor turns an effective-state change into the alert
// label (or null when nothing should be logged). These tests exercise the
// helpers directly and then replay them through a faithful copy of the tick()
// per-probe loop for representative probe classes.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const { computeEffectiveOk, transitionFor } = require("../src/index.js");

const CONFIRM = 3; // FAIL_CONFIRM_TICKS in tick()

test("transitionFor: unchanged state → null, changes → label", () => {
  assert.strictEqual(transitionFor(true, true), null);
  assert.strictEqual(transitionFor(false, false), null);
  assert.strictEqual(transitionFor(true, false), "FAILED");
  assert.strictEqual(transitionFor(false, true), "RECOVERED");
});

test("computeEffectiveOk: a success is always ok immediately", () => {
  assert.strictEqual(computeEffectiveOk(false, [{ ok: false }, { ok: true }], true, CONFIRM), true);
});

test("computeEffectiveOk: one or two fails do not flip a healthy probe", () => {
  assert.strictEqual(computeEffectiveOk(true, [{ ok: false }], false, CONFIRM), true);
  assert.strictEqual(computeEffectiveOk(true, [{ ok: false }, { ok: false }], false, CONFIRM), true);
});

test("computeEffectiveOk: three consecutive fails flip to failing", () => {
  const history = [{ ok: false }, { ok: false }, { ok: false }];
  assert.strictEqual(computeEffectiveOk(true, history, false, CONFIRM), false);
});

test("computeEffectiveOk: a success inside the window keeps it healthy", () => {
  // last three are fail, ok, fail — not all failing → stays ok
  const history = [{ ok: false }, { ok: true }, { ok: false }];
  assert.strictEqual(computeEffectiveOk(true, history, false, CONFIRM), true);
});

test("computeEffectiveOk: already-failing stays failing until a success", () => {
  assert.strictEqual(computeEffectiveOk(false, [{ ok: false }], false, CONFIRM), false);
});

// Faithful reproduction of the per-probe body of tick(): push into a rolling
// 5-deep history, compute effectiveOk, derive the alert transition, and carry
// prevEffectiveOk forward. Returns the transition emitted on each tick.
function driveProbe(sequence) {
  let prevEffectiveOk = true;
  let history = [];
  return sequence.map((ok) => {
    history.push({ ok });
    if (history.length > 5) history.shift();
    const effectiveOk = computeEffectiveOk(prevEffectiveOk, history, ok, CONFIRM);
    const transition = transitionFor(prevEffectiveOk, effectiveOk);
    prevEffectiveOk = effectiveOk;
    return transition;
  });
}

test("systemd class (radio_service) flapping never emits a FAILED alert", () => {
  const transitions = driveProbe([true, false, true, false, true, false]);
  assert.deepStrictEqual(transitions, [null, null, null, null, null, null]);
});

test("http class (radio_now_playing) sustained outage → FAILED on 3rd fail, RECOVERED on return", () => {
  //          t1     t2     t3     t4        t5
  //          ok     fail   fail   fail      ok
  const transitions = driveProbe([true, false, false, false, true]);
  assert.deepStrictEqual(transitions, [null, null, null, "FAILED", "RECOVERED"]);
});

test("tcp class (nats_reachable) dead from the first tick → FAILED on 3rd, then RECOVERED", () => {
  const transitions = driveProbe([false, false, false, true]);
  assert.deepStrictEqual(transitions, [null, null, "FAILED", "RECOVERED"]);
});

test("no alert storm: a probe that stays failed emits FAILED exactly once", () => {
  const transitions = driveProbe([false, false, false, false, false, false]);
  assert.deepStrictEqual(transitions, [null, null, "FAILED", null, null, null]);
});
