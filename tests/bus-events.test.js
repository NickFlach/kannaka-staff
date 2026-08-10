"use strict";

// ADR-003 documents a staffBus subject for every role action, but Growth,
// Distributor, Creator and Marketer were each handed the bus at boot and
// never published to it — so their work was invisible to the bus panel
// and to any handler that wanted to react.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { bootCreator } = require("../src/staff/creator");
const { bootDistributor } = require("../src/staff/distributor");
const { bootGrowth } = require("../src/staff/growth");

/** A bus that records every KANNAKA.* publication, like busRing does. */
function recordingBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(64);
  const seen = [];
  const original = bus.emit.bind(bus);
  bus.emit = (subject, event) => {
    if (typeof subject === "string" && subject.startsWith("KANNAKA.")) seen.push({ subject, event });
    return original(subject, event);
  };
  return { bus, seen };
}

function tmpAlerts(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "alerts.jsonl");
}

/** Wait for a subject, but fail the test rather than hang if it never comes. */
function waitFor(bus, subject, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${subject}`)), ms);
    bus.once(subject, (ev) => { clearTimeout(timer); resolve(ev); });
  });
}

test("#41 regression: Creator publishes job.start and job.failed", async () => {
  const { bus, seen } = recordingBus();
  const creator = bootCreator({
    radioBase: "http://127.0.0.1:1", // nothing listening — dispatch fails fast
    alertsFile: tmpAlerts("creator-bus-"),
    staffBus: bus,
  });
  // kind=oration is the accepted-then-fails-asynchronously case. It has no
  // up-front preconditions (#67 deliberately does not pre-judge it, since
  // its failure mode is a live HTTP call), so requestCreate returns ok:true
  // and the job only fails once the connection to the dead port is refused.
  // This used to use kind=track, which #67 now — correctly — refuses
  // synchronously, so it no longer reaches the bus at all.
  const done = waitFor(bus, "KANNAKA.staff.creator.job.failed");
  const r = creator.requestCreate({ kind: "oration" });
  assert.strictEqual(r.ok, true, "the job is accepted, then fails in dispatch");
  await done;

  const subjects = seen.map((s) => s.subject);
  assert.ok(subjects.includes("KANNAKA.staff.creator.job.start"), `missing job.start in ${subjects}`);
  assert.ok(subjects.includes("KANNAKA.staff.creator.job.failed"), `missing job.failed in ${subjects}`);

  // Events carry the ADR-003 shape: {ts, source, subject, payload}.
  const start = seen.find((s) => s.subject === "KANNAKA.staff.creator.job.start");
  assert.strictEqual(start.event.source, "creator");
  assert.strictEqual(typeof start.event.ts, "number");
  assert.strictEqual(start.event.payload.kind, "oration");
});

test("#67 + #41: a synchronously-refused kind never reaches the bus at all", () => {
  // The complement of the test above, and the interaction that broke master
  // when #83 and #85 merged in sequence: a job refused up front must not
  // emit job.start, because no job was ever started.
  const { bus, seen } = recordingBus();
  const creator = bootCreator({
    radioBase: "http://127.0.0.1:1",
    alertsFile: tmpAlerts("creator-bus-sync-"),
    staffBus: bus,
  });
  const r = creator.requestCreate({ kind: "track" });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(seen.map((s) => s.subject), [], "no bus traffic for a refused request");
});

test("#41 regression: Distributor publishes job.start", () => {
  const { bus, seen } = recordingBus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dist-bus-"));
  const configPath = path.join(dir, "album.json");
  const releaseScript = path.join(dir, "release-album.sh");
  fs.writeFileSync(configPath, JSON.stringify({ name: "TEST ALBUM" }));
  fs.writeFileSync(releaseScript, "exit 0\n");

  const prev = process.env.DISTRIBUTOR_RELEASE_SCRIPT;
  process.env.DISTRIBUTOR_RELEASE_SCRIPT = releaseScript;
  let distributor;
  try {
    distributor = bootDistributor({
      alertsFile: path.join(dir, "alerts.jsonl"),
      staffBus: bus,
    });
  } finally {
    if (prev === undefined) delete process.env.DISTRIBUTOR_RELEASE_SCRIPT;
    else process.env.DISTRIBUTOR_RELEASE_SCRIPT = prev;
  }
  const r = distributor.requestPublish({ configPath, skip: "" });
  // The spawned bash may or may not exist on this box; either way the
  // START publication happens synchronously at request time.
  assert.strictEqual(r.ok, true, r.error);
  const start = seen.find((s) => s.subject === "KANNAKA.staff.distributor.job.start");
  assert.ok(start, `missing job.start in ${seen.map((s) => s.subject)}`);
  assert.strictEqual(start.event.source, "distributor");
  assert.strictEqual(start.event.payload.name, "TEST ALBUM");
});

test("#41 regression: Growth publishes the HRM bloat edge and the dream start", () => {
  // Growth's bloat edge routes through decide(), which #80 refactored into
  // evaluateTick(). This drives a real tick() so the publish is pinned to
  // that structure — a future refactor of decide() cannot silently drop it.
  const { bus, seen } = recordingBus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "growth-bus-"));
  const hrmPath = path.join(dir, "kannaka.hrm");
  fs.writeFileSync(hrmPath, "x".repeat(1024)); // ~0.001 MB of "medium"

  // Drive the thresholds under the fixture so this tick reads as bloated
  // without needing a 95 MB file, and point KANNAKA_BIN at nothing so the
  // resulting dream launch fails immediately instead of running anything.
  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set("GROWTH_HRM_HARD_MB", "0.0001");
  set("GROWTH_HRM_SOFT_MB", "0.00005");
  set("KANNAKA_BIN", path.join(dir, "no-such-kannaka-binary"));
  let growth;
  try {
    growth = bootGrowth({ hrmPath, alertsFile: path.join(dir, "alerts.jsonl"), staffBus: bus });
    growth.tick();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  const subjects = seen.map((s) => s.subject);
  assert.ok(subjects.includes("KANNAKA.staff.hrm.bloated"), `missing hrm.bloated in ${subjects}`);
  assert.ok(subjects.includes("KANNAKA.staff.dream.start"), `missing dream.start in ${subjects}`);

  const bloated = seen.find((s) => s.subject === "KANNAKA.staff.hrm.bloated");
  assert.strictEqual(bloated.event.source, "growth");
  assert.strictEqual(typeof bloated.event.ts, "number");
  assert.match(bloated.event.payload.message, />= 0\.0001 MB/);
});

test("#41: a role booted without a bus does not throw", () => {
  const creator = bootCreator({
    radioBase: "http://127.0.0.1:1",
    alertsFile: tmpAlerts("creator-nobus-"),
    staffBus: null,
  });
  assert.doesNotThrow(() => creator.requestCreate({ kind: "track" }));
});
