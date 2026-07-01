"use strict";

// PORT env handling (#20) and the ADR-003 in-process bus ring summarizer.
// parsePort resolves the listen port; summarizeBusEvent decides which
// closed-loop events land in the observability ring buffer and how their
// payloads are rendered.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const { parsePort, summarizeBusEvent } = require("../src/index.js");

const ARGV0 = ["node", "src/index.js"]; // argv without --port

test("#20: PORT env is honored", () => {
  assert.strictEqual(parsePort({ PORT: "3000" }, ARGV0), 3000);
});

test("#20: --port argv is used when PORT is unset", () => {
  assert.strictEqual(parsePort({}, ["node", "src/index.js", "--port", "9100"]), 9100);
});

test("#20: default is 8889 with neither PORT nor --port", () => {
  assert.strictEqual(parsePort({}, ARGV0), 8889);
});

test("#20: PORT wins over --port when both are present", () => {
  assert.strictEqual(parsePort({ PORT: "3000" }, ["node", "src/index.js", "--port", "9100"]), 3000);
});

test("#20: empty PORT falls through to --port", () => {
  assert.strictEqual(parsePort({ PORT: "" }, ["node", "src/index.js", "--port", "9100"]), 9100);
});

test("#20: non-numeric PORT falls back to default", () => {
  assert.strictEqual(parsePort({ PORT: "not-a-port" }, ARGV0), 8889);
});

test("#20: non-numeric --port falls back to default", () => {
  assert.strictEqual(parsePort({}, ["node", "src/index.js", "--port", "nope"]), 8889);
});

test("bus: a KANNAKA.* event is summarized into a ring entry", () => {
  const entry = summarizeBusEvent("KANNAKA.staff.stream.silent", {
    ts: 123456,
    source: "ear",
    payload: { variance: 1.2, silentStreak: 4 },
  });
  assert.ok(entry);
  assert.strictEqual(entry.subject, "KANNAKA.staff.stream.silent");
  assert.strictEqual(entry.source, "ear");
  assert.strictEqual(entry.ts, 123456);
  assert.strictEqual(entry.summary, JSON.stringify({ variance: 1.2, silentStreak: 4 }));
});

test("bus: non-KANNAKA subjects (EventEmitter internals) are skipped", () => {
  assert.strictEqual(summarizeBusEvent("newListener", { payload: {} }), null);
  assert.strictEqual(summarizeBusEvent("removeListener", { payload: {} }), null);
});

test("bus: a non-string subject is skipped", () => {
  assert.strictEqual(summarizeBusEvent(123, { payload: {} }), null);
});

test("bus: missing source defaults to '?' and ts falls back to a number", () => {
  const entry = summarizeBusEvent("KANNAKA.staff.album.starving", { payload: { album: "BEND THE ARC" } });
  assert.ok(entry);
  assert.strictEqual(entry.source, "?");
  assert.strictEqual(typeof entry.ts, "number");
});

test("bus: oversized payloads are truncated to 200 chars + ellipsis", () => {
  const entry = summarizeBusEvent("KANNAKA.staff.x", { source: "s", payload: { blob: "x".repeat(500) } });
  assert.ok(entry);
  assert.strictEqual(entry.summary.length, 201);
  assert.ok(entry.summary.endsWith("…"));
});

test("bus: an unserializable payload is rendered safely", () => {
  const circular = {};
  circular.self = circular;
  const entry = summarizeBusEvent("KANNAKA.staff.x", { source: "s", payload: circular });
  assert.ok(entry);
  assert.strictEqual(entry.summary, "(unserializable)");
});
