/**
 * ADR-004 W1 — the accepted-vs-ok result contract (#92, generalizes #67).
 *
 * One contract for every action surface:
 *   - synchronous preflight failure  → { ok:false, error }, nothing queued
 *   - work queued for async execution → { accepted:true, jobId|mode }, NEVER ok:true
 *   - ok:true is reserved for completed work
 *
 * Hermetic: roles boot with temp alert files and dead endpoints; nothing
 * here touches the network beyond connections to ports nothing listens on.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { bootCreator } = require("../src/staff/creator");
const { bootDistributor } = require("../src/staff/distributor");
const { bootGrowth } = require("../src/staff/growth");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv(overrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Creator ─────────────────────────────────────────────────────────

test("W1: creator queue return is accepted:true, never ok:true", () => {
  const creator = withEnv(
    { OPENBOTCITY_JWT: undefined, OBC_JWT: undefined, OBC_JWT_FILE: "/nonexistent/creds.json" },
    () => bootCreator({ radioBase: "http://127.0.0.1:1", alertsFile: path.join(tmpDir("w1-creator-"), "alerts.jsonl") })
  );
  const r = creator.requestCreate({ kind: "oration" });
  assert.strictEqual(r.accepted, true);
  assert.ok(r.jobId, "queued work carries a jobId");
  assert.notStrictEqual(r.ok, true, "ok is reserved for completed work");
});

test("W1: creator preflight failure returns ok:false and queues nothing", () => {
  const creator = withEnv(
    { OPENBOTCITY_JWT: undefined, OBC_JWT: undefined, OBC_JWT_FILE: "/nonexistent/creds.json" },
    () => bootCreator({ radioBase: "http://127.0.0.1:1", alertsFile: path.join(tmpDir("w1-creator-"), "alerts.jsonl") })
  );
  const r = creator.requestCreate({ kind: "image", prompt: "x", building_id: "b" });
  assert.strictEqual(r.ok, false);
  assert.notStrictEqual(r.accepted, true, "a refused job is not accepted");
  assert.match(r.error, /no OBC JWT/);
  assert.strictEqual(creator.getState().current, null, "nothing queued");
});

// ── Distributor ─────────────────────────────────────────────────────

test("W1: distributor queue return is accepted:true, never ok:true", () => {
  const dir = tmpDir("w1-dist-");
  const configPath = path.join(dir, "album.json");
  fs.writeFileSync(configPath, JSON.stringify({ name: "W1 ALBUM" }));
  const releaseScript = path.join(dir, "release.sh");
  fs.writeFileSync(releaseScript, "exit 0\n");
  const distributor = withEnv(
    { DISTRIBUTOR_RELEASE_SCRIPT: releaseScript },
    () => bootDistributor({ alertsFile: path.join(dir, "alerts.jsonl") })
  );
  const r = distributor.requestPublish({ configPath, skip: "" });
  assert.strictEqual(r.accepted, true, r.error);
  assert.ok(r.jobId);
  assert.notStrictEqual(r.ok, true, "ok is reserved for completed work");
});

// ── Growth ──────────────────────────────────────────────────────────

test("W1: growth requestDream launch is accepted:true, never ok:true", () => {
  const dir = tmpDir("w1-growth-");
  const hrmPath = path.join(dir, "hrm.bin");
  fs.writeFileSync(hrmPath, "x");
  // A harmless "binary": `true` exists everywhere CI runs; the dream just
  // exits 0. We only assert on the synchronous return shape.
  const growth = withEnv(
    { GROWTH_ENABLED: "true", KANNAKA_BIN: "/bin/true" },
    () => bootGrowth({ hrmPath, alertsFile: path.join(dir, "alerts.jsonl") })
  );
  const r = growth.requestDream("lite", "W1 contract test");
  assert.strictEqual(r.accepted, true, r.error);
  assert.strictEqual(r.mode, "lite");
  assert.notStrictEqual(r.ok, true, "a launched dream is not a finished dream");
});

test("W1: growth disabled refuses with ok:false, not accepted", () => {
  const dir = tmpDir("w1-growth-off-");
  const hrmPath = path.join(dir, "hrm.bin");
  fs.writeFileSync(hrmPath, "x");
  const growth = withEnv(
    { GROWTH_ENABLED: "false" },
    () => bootGrowth({ hrmPath, alertsFile: path.join(dir, "alerts.jsonl") })
  );
  const r = growth.requestDream("lite", "W1 contract test");
  assert.strictEqual(r.ok, false);
  assert.notStrictEqual(r.accepted, true);
});
