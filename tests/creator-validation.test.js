"use strict";

// Creator answers the HTTP caller synchronously, before dispatch()
// resolves, so anything knowable up front has to be checked up front —
// otherwise the operator is told ok:true for a job that has already
// failed by the time they read the response.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { bootCreator } = require("../src/staff/creator");

function bootWithoutJwt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creator-val-"));
  const prevEnvJwt = process.env.OPENBOTCITY_JWT;
  const prevObcJwt = process.env.OBC_JWT;
  const prevFile = process.env.OBC_JWT_FILE;
  delete process.env.OPENBOTCITY_JWT;
  delete process.env.OBC_JWT;
  process.env.OBC_JWT_FILE = path.join(dir, "absent-credentials.json");
  try {
    return bootCreator({
      radioBase: "http://127.0.0.1:1",
      alertsFile: path.join(dir, "alerts.jsonl"),
      staffBus: null,
    });
  } finally {
    if (prevEnvJwt !== undefined) process.env.OPENBOTCITY_JWT = prevEnvJwt;
    if (prevObcJwt !== undefined) process.env.OBC_JWT = prevObcJwt;
    if (prevFile === undefined) delete process.env.OBC_JWT_FILE;
    else process.env.OBC_JWT_FILE = prevFile;
  }
}

test("#67 regression: an image job missing prompt/building_id is refused, not accepted", () => {
  // Before the fix this returned {ok:true, jobId} and only failed inside
  // the async dispatch, long after the HTTP response had gone out.
  const creator = bootWithoutJwt();
  const r = creator.requestCreate({ kind: "image", title: "Untitled" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /prompt \+ building_id/);
  assert.strictEqual(creator.getState().current, null, "no job was started");
});

test("#67 regression: an image job with no OBC JWT is refused up front", () => {
  const creator = bootWithoutJwt();
  const r = creator.requestCreate({ kind: "image", prompt: "a lighthouse", building_id: "b1" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no OBC JWT/);
  assert.strictEqual(creator.getState().current, null);
});

test("#67: kind=track is refused synchronously", () => {
  const creator = bootWithoutJwt();
  const r = creator.requestCreate({ kind: "track" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Distributor/);
});

test("#67: an unknown kind is refused synchronously", () => {
  const creator = bootWithoutJwt();
  const r = creator.requestCreate({ kind: "sculpture" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown kind: sculpture/);
});

test("#67: a missing kind is still refused", () => {
  const creator = bootWithoutJwt();
  const r = creator.requestCreate({});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /missing \?kind=/);
});

test("#67: oration has no up-front preconditions and is accepted", () => {
  // Its failure mode is a live HTTP call, which genuinely cannot be
  // decided synchronously — so ok:true here is honest.
  const creator = bootWithoutJwt();
  assert.strictEqual(creator.rejectionFor("oration", {}), null);
});

test("#67: a fully-specified image job passes validation when a JWT exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creator-jwt-"));
  const jwtFile = path.join(dir, "credentials.json");
  fs.writeFileSync(jwtFile, JSON.stringify({ jwt: "test-token" }));
  const prev = process.env.OBC_JWT_FILE;
  process.env.OBC_JWT_FILE = jwtFile;
  try {
    const creator = bootCreator({
      radioBase: "http://127.0.0.1:1",
      alertsFile: path.join(dir, "alerts.jsonl"),
      staffBus: null,
    });
    assert.strictEqual(creator.rejectionFor("image", { prompt: "p", building_id: "b" }), null);
  } finally {
    if (prev === undefined) delete process.env.OBC_JWT_FILE; else process.env.OBC_JWT_FILE = prev;
  }
});
