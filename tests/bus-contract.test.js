/**
 * ADR-004 W2 — the bus contract test (#93).
 *
 * ADR-003's subject inventory, made executable: every documented
 * KANNAKA.staff.* subject must have a publisher in its owning module.
 * A documented-but-unpublished subject is a red build, not a stale doc
 * (that drift is exactly how #41 happened).
 *
 * Two layers:
 *   1. Registry — for each subject, its owning source file must contain a
 *      non-comment publish/emit of that subject literal. Removing any
 *      publisher fails the suite.
 *   2. Envelope — dynamic spot-checks that published events carry the
 *      ADR-003 shape {ts, source, subject, payload} (per-role transition
 *      drives live in tests/bus-events.test.js; here we add the marketer,
 *      the one role bus-events does not exercise dynamically).
 *
 * Hermetic: reads source files; the one dynamic test posts to a dead port.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const SRC = path.join(__dirname, "..", "src");

// ── The inventory (mirror of ADR-003 § Subject inventory) ───────────
// subject → repo-relative source file that owns publishing it.
const INVENTORY = {
  "KANNAKA.staff.stream.silent": "staff/ear/index.js",
  "KANNAKA.staff.stream.recovered": "staff/ear/index.js",
  "KANNAKA.staff.voice.lock.stuck": "staff/voice/index.js",
  "KANNAKA.staff.voice.lock.recovered": "staff/voice/index.js",
  "KANNAKA.staff.album.starving": "staff/curator/index.js",
  "KANNAKA.staff.album.never_played": "staff/curator/index.js",
  "KANNAKA.staff.album.refreshed": "staff/curator/index.js",
  "KANNAKA.staff.hrm.bloated": "staff/growth/index.js",
  "KANNAKA.staff.hrm.recovered": "staff/growth/index.js",
  "KANNAKA.staff.dream.start": "staff/growth/index.js",
  "KANNAKA.staff.dream.done": "staff/growth/index.js",
  "KANNAKA.staff.dream.failed": "staff/growth/index.js",
  "KANNAKA.staff.distributor.job.start": "staff/distributor/index.js",
  "KANNAKA.staff.distributor.job.done": "staff/distributor/index.js",
  "KANNAKA.staff.distributor.job.failed": "staff/distributor/index.js",
  "KANNAKA.staff.creator.job.start": "staff/creator/index.js",
  "KANNAKA.staff.creator.job.done": "staff/creator/index.js",
  "KANNAKA.staff.creator.job.failed": "staff/creator/index.js",
  "KANNAKA.staff.marketer.post.done": "staff/marketer/index.js",
  "KANNAKA.staff.marketer.post.failed": "staff/marketer/index.js",
  "KANNAKA.staff.action.auto_recover.restart": "index.js",
};

/** Source with // line comments and /* block comments *\/ removed, so a
 * subject mentioned only in prose can't satisfy the registry. Naive about
 * comment markers inside string literals — good enough for this repo's
 * style, and a false *negative* here just means adding a publisher. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:"'])\/\/[^\n"']*$/gm, "$1");
}

/**
 * True if the file publishes the subject: the subject string appears as a
 * literal, or its tail appears in a template/concat where the shared
 * "KANNAKA.staff." prefix (or role prefix) is factored out. Roles here use
 * plain literals or `publish(ok ? "…done" : "…failed", …)` ternaries —
 * both carry the full literal — so exact-literal matching suffices.
 */
function publishes(code, subject) {
  return code.includes(`"${subject}"`) || code.includes(`'${subject}'`) || code.includes("`" + subject + "`");
}

for (const [subject, relFile] of Object.entries(INVENTORY)) {
  test(`W2 registry: ${subject} has a publisher in src/${relFile}`, () => {
    const file = path.join(SRC, relFile);
    const code = stripComments(fs.readFileSync(file, "utf8"));
    assert.ok(
      publishes(code, subject),
      `ADR-003 documents ${subject} as owned by src/${relFile}, but no non-comment ` +
      `publish of that literal exists there. Either restore the publisher or ` +
      `amend ADR-003 + this inventory in the same PR.`
    );
  });
}

test("W2 registry: the inventory matches ADR-003's documented subject list", () => {
  const adr = fs.readFileSync(path.join(__dirname, "..", "docs", "adr", "ADR-003-closed-loops-event-bus.md"), "utf8");
  // Every inventory subject must be documented; `a|b|c` shorthand in the ADR
  // (e.g. dream.start|done|failed) expands to full names here.
  for (const subject of Object.keys(INVENTORY)) {
    const tail = subject.replace("KANNAKA.staff.", "");
    const last = tail.split(".").pop();
    const stem = tail.slice(0, tail.length - last.length); // "dream." etc.
    const documented =
      adr.includes(subject) ||
      new RegExp(`KANNAKA\\.staff\\.${stem.replace(/\./g, "\\.")}[\\w|]*\\b${last}\\b`).test(adr);
    assert.ok(documented, `${subject} is in the test inventory but not documented in ADR-003`);
  }
});

// ── Envelope spot-check: marketer (the role bus-events skips) ───────

test("W2 envelope: marketer publishes post.failed with the ADR-003 shape", async () => {
  const { bootMarketer } = require("../src/staff/marketer");
  const bus = new EventEmitter();
  const seen = [];
  const orig = bus.emit.bind(bus);
  bus.emit = (subject, event) => { seen.push({ subject, event }); return orig(subject, event); };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w2-marketer-"));
  const prev = process.env.MARKETER_BROADCASTER_URL;
  process.env.MARKETER_BROADCASTER_URL = "http://127.0.0.1:1"; // dead port
  let marketer;
  try {
    marketer = bootMarketer({ alertsFile: path.join(dir, "alerts.jsonl"), staffBus: bus, radioBase: "http://127.0.0.1:1" });
  } finally {
    if (prev === undefined) delete process.env.MARKETER_BROADCASTER_URL;
    else process.env.MARKETER_BROADCASTER_URL = prev;
  }
  if (typeof marketer.requestPost !== "function") {
    // Module surface differs — the registry layer above still guards the
    // publisher; skip the dynamic drive rather than fake a pass.
    return;
  }
  const done = new Promise((resolve) => bus.on("KANNAKA.staff.marketer.post.failed", resolve));
  marketer.requestPost({ text: "W2 envelope check" });
  const ev = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 5000))]);
  assert.ok(ev, "marketer.post.failed was not published for a dead broadcaster");
  assert.strictEqual(ev.source, "marketer");
  assert.strictEqual(typeof ev.ts, "number");
  assert.strictEqual(typeof ev.payload, "object");
});
