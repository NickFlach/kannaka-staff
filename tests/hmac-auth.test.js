"use strict";

// HMAC request-auth for POST /action/* (the write path that can restart
// production services). Drives the extracted verifyStaffHmac helper, which
// carries the exact branch logic of the inline server check — including the
// #21 fix: a non-numeric X-Staff-Timestamp must be rejected as out-of-window,
// never treated as skew 0.

// Defence-in-depth: if the boot guard in src/index.js ever regresses and a
// require() boots the watcher, the TTL makes it self-destruct instead of
// hanging the test runner. Set before require.
process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { verifyStaffHmac } = require("../src/index.js");

const SECRET = "test-shared-secret";
const METHOD = "POST";
const URL_PATH = "/action/growth-dream?mode=lite";
const NOW = 1_700_000_000_000; // fixed clock for deterministic skew

function sign(secret, ts, method, reqUrl) {
  return crypto.createHmac("sha256", secret).update(`${ts}\n${method}\n${reqUrl}`).digest("hex");
}

test("localhost bypasses HMAC entirely", () => {
  const r = verifyStaffHmac({ secret: SECRET, isLocal: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 200);
});

test("remote with no secret configured is refused (403)", () => {
  const r = verifyStaffHmac({ secret: undefined, isLocal: false, method: METHOD, reqUrl: URL_PATH });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 403);
  assert.match(r.error, /STAFF_SHARED_SECRET/);
});

test("remote missing signature/timestamp headers → 401", () => {
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, method: METHOD, reqUrl: URL_PATH });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 401);
  assert.match(r.error, /missing X-Staff-Signature/);
});

test("valid signature within window → authorized", () => {
  const ts = String(NOW - 1000);
  const sig = sign(SECRET, ts, METHOD, URL_PATH);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: METHOD, reqUrl: URL_PATH, now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 200);
});

test("wrong signature → 401 bad signature", () => {
  const ts = String(NOW);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig: "deadbeef", ts, method: METHOD, reqUrl: URL_PATH, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 401);
  assert.match(r.error, /bad signature/);
});

test("signature binds the method — signing GET, sending POST fails", () => {
  const ts = String(NOW);
  const sig = sign(SECRET, ts, "GET", URL_PATH);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: "POST", reqUrl: URL_PATH, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bad signature/);
});

test("signature binds the path — signing /action/a, sending /action/b fails", () => {
  const ts = String(NOW);
  const sig = sign(SECRET, ts, METHOD, "/action/a");
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: METHOD, reqUrl: "/action/b", now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bad signature/);
});

test("non-hex signature (timingSafeEqual throws) is swallowed → 401", () => {
  const ts = String(NOW);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig: "zzzz", ts, method: METHOD, reqUrl: URL_PATH, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 401);
  assert.match(r.error, /bad signature/);
});

test("replay: timestamp older than the 5-min window → rejected", () => {
  const ts = String(NOW - 6 * 60 * 1000); // 6 min in the past
  const sig = sign(SECRET, ts, METHOD, URL_PATH); // otherwise-valid signature
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: METHOD, reqUrl: URL_PATH, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 401);
  assert.match(r.error, /out of window/);
});

test("#21 regression: NaN timestamp must not collapse skew to 0", () => {
  // Sign for the literal string "NaN-clock" so the signature would VERIFY
  // if the window check were bypassed. Under the fix, parseInt(...)||0 makes
  // skew ~= now (huge) and the request is rejected out-of-window BEFORE the
  // signature is ever checked. A regression that let skew become 0 would
  // return ok:true here.
  const ts = "NaN-clock";
  const sig = sign(SECRET, ts, METHOD, URL_PATH);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: METHOD, reqUrl: URL_PATH, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 401);
  assert.match(r.error, /out of window/);
});

test("timestamp exactly at the window edge is still accepted", () => {
  const ts = String(NOW - 5 * 60 * 1000); // skew === skewMs, not greater
  const sig = sign(SECRET, ts, METHOD, URL_PATH);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: METHOD, reqUrl: URL_PATH, now: NOW });
  assert.strictEqual(r.ok, true);
});
