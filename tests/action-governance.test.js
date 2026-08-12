/**
 * ADR-004 W4 — action governance (#94).
 *
 * Three guarantees:
 *   1. Every registered write-action honors its STAFF_ACTION_<NAME> flag
 *      (default on; "0"/"false" disable — visibly, never silently).
 *   2. Audit entries carry actor provenance in a fixed shape.
 *   3. The governance table (ADR-004), ACTION_REGISTRY, and handleAction's
 *      cases cannot drift apart — any mismatch is a red build.
 *
 * Hermetic: pure helpers + source/doc reads.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { ACTION_REGISTRY, actionGate, actionAuditEntry } = require("../src/index.js");

const INDEX_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
const ADR = fs.readFileSync(
  path.join(__dirname, "..", "docs", "adr", "ADR-004-truthful-operations.md"),
  "utf8"
);

// ── 1. Flag gating ──────────────────────────────────────────────────

test("W4: actions default to enabled with no env", () => {
  for (const action of Object.keys(ACTION_REGISTRY)) {
    const g = actionGate(action, {});
    assert.strictEqual(g.registered, true);
    assert.strictEqual(g.enabled, true, `${action} should default on`);
  }
});

test('W4: "<flag>=0" and "<flag>=false" disable; other values do not', () => {
  const action = "restart-radio";
  const flag = ACTION_REGISTRY[action].flag;
  assert.strictEqual(actionGate(action, { [flag]: "0" }).enabled, false);
  assert.strictEqual(actionGate(action, { [flag]: "false" }).enabled, false);
  assert.strictEqual(actionGate(action, { [flag]: "FALSE" }).enabled, false);
  assert.strictEqual(actionGate(action, { [flag]: "1" }).enabled, true);
  assert.strictEqual(actionGate(action, { [flag]: "" }).enabled, true);
  assert.strictEqual(actionGate(action, { [flag]: "off-ish" }).enabled, true, "only 0/false disable");
});

test("W4: every action has a distinct, well-formed flag", () => {
  const flags = Object.values(ACTION_REGISTRY).map((r) => r.flag);
  assert.strictEqual(new Set(flags).size, flags.length, "flags must be unique");
  for (const f of flags) assert.match(f, /^STAFF_ACTION_[A-Z_]+$/);
});

test("W4: an unregistered action passes the gate (handleAction 404s it)", () => {
  const g = actionGate("no-such-action", {});
  assert.strictEqual(g.registered, false);
  assert.strictEqual(g.enabled, true);
});

test("W4: handleAction refuses a disabled action visibly", () => {
  // The gate lives at the top of handleAction; assert the wiring exists and
  // produces the documented refusal shape (source-level — handleAction
  // itself closes over booted roles, so we pin the contract textually and
  // the gate behavior functionally above).
  const body = INDEX_SRC.slice(INDEX_SRC.indexOf("async function handleAction"));
  assert.match(body.slice(0, 400), /actionGate\(action\)/, "handleAction must consult the gate first");
  assert.match(body.slice(0, 400), /disabled: true/, "disabled refusal is marked");
});

// ── 2. Audit provenance ─────────────────────────────────────────────

test("W4: audit entries carry actor, action, result, and a message", () => {
  const e = actionAuditEntry({ actor: "operator:local", action: "restart-radio", result: "ok", detail: "systemctl" });
  assert.strictEqual(e.probe, "action");
  assert.strictEqual(e.transition, "ACTION_AUDIT");
  assert.strictEqual(e.actor, "operator:local");
  assert.strictEqual(e.action, "restart-radio");
  assert.strictEqual(e.result, "ok");
  assert.match(e.message, /operator:local → restart-radio: ok — systemctl/);
  assert.ok(!Number.isNaN(Date.parse(e.ts)), "ts is ISO");
});

test("W4: loop-initiated writes carry staff actors in source", () => {
  assert.match(INDEX_SRC, /actor: "staff:auto-recover"/, "auto-recover entries carry actor");
  assert.match(INDEX_SRC, /fireRescue\(reason, actor = "staff:album-rescue"\)/, "rescue defaults to staff actor");
  assert.match(INDEX_SRC, /fireRescue\("manual operator trigger from dashboard", "operator"\)/, "manual rescue is operator");
});

// ── 3. Registry ↔ handleAction ↔ ADR sync ──────────────────────────

function handleActionCases() {
  const start = INDEX_SRC.indexOf("async function handleAction");
  const end = INDEX_SRC.indexOf("function execActionLocal");
  const body = INDEX_SRC.slice(start, end);
  return [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
}

test("W4 sync: every registry action has a handleAction case", () => {
  const cases = handleActionCases();
  for (const action of Object.keys(ACTION_REGISTRY)) {
    assert.ok(cases.includes(action), `${action} is registered but has no case in handleAction`);
  }
});

test("W4 sync: every handleAction case is registered", () => {
  for (const c of handleActionCases()) {
    assert.ok(
      ACTION_REGISTRY[c],
      `handleAction case "${c}" has no ACTION_REGISTRY row — add it and an ADR-004 table row in this PR`
    );
  }
});

test("W4 sync: every registry action + flag appears in ADR-004's governance table", () => {
  for (const [action, { flag }] of Object.entries(ACTION_REGISTRY)) {
    assert.ok(ADR.includes(action), `${action} missing from ADR-004 governance table`);
    assert.ok(ADR.includes(flag), `${flag} missing from ADR-004 governance table`);
  }
});
