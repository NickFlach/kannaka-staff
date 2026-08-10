"use strict";

// obc_healthy asserts what OpenBotCity says about itself, not merely that
// something answered. The probe it replaced counted 401/403 as alive, so it
// went green on any auth-gated response — including one from a front door
// whose backend was dead (#50).

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const { obcHealthVerdict } = require("../src/index.js");

// The real payload, captured from api.openbotcity.com during triage.
const LIVE_BODY = JSON.stringify({
  status: "ok",
  service: "openbotcity-api",
  timestamp: "2026-08-10T21:54:35.404Z",
});

test("#50: the live /health payload reads as healthy", () => {
  const v = obcHealthVerdict({ ok: true, status: 200, body: LIVE_BODY });
  assert.strictEqual(v.ok, true);
  assert.match(v.message, /openbotcity-api status=ok/);
});

test("#50 regression: an auth-gated 401 is NOT healthy", () => {
  // This is the exact response the old probe treated as alive:
  // GET /world/heartbeat -> 401 {"success":false,"error":"Missing Authorization header"}
  const v = obcHealthVerdict({
    ok: false, status: 401,
    body: '{"success":false,"error":"Missing Authorization header"}',
  });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /HTTP 401/);
});

test("#50 regression: a 404 is NOT healthy", () => {
  // POST /world/heartbeat -> 404. The route this issue assumed was
  // canonical does not exist.
  const v = obcHealthVerdict({ ok: false, status: 404, body: '{"error":"Not found"}' });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /HTTP 404/);
});

test("#50: a 200 carrying a non-ok status is NOT healthy", () => {
  // The whole point of asserting the body: the service can answer 200
  // while telling us it is unwell.
  const v = obcHealthVerdict({ ok: true, status: 200, body: '{"status":"degraded","service":"openbotcity-api"}' });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /status="degraded"/);
});

test("#50: a 200 from something that is not the OBC API is NOT healthy", () => {
  // A captive portal or misrouted proxy answering 200 must not read green.
  const v = obcHealthVerdict({ ok: true, status: 200, body: '{"status":"ok","service":"some-other-service"}' });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /unexpected service/);
});

test("#50: a 200 with a non-JSON body is NOT healthy", () => {
  const v = obcHealthVerdict({ ok: true, status: 200, body: "<html>hello</html>" });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /not JSON/);
});

test("#50: a 200 with no status field is NOT healthy", () => {
  const v = obcHealthVerdict({ ok: true, status: 200, body: '{"service":"openbotcity-api"}' });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /\(absent\)/);
});

test("#50: a transport error is NOT healthy", () => {
  const v = obcHealthVerdict({ ok: false, status: 0, error: "ECONNREFUSED" });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /ECONNREFUSED/);
});

test("#50: status casing is tolerated", () => {
  assert.strictEqual(
    obcHealthVerdict({ ok: true, status: 200, body: '{"status":"OK","service":"openbotcity-api"}' }).ok,
    true,
  );
});

test("#50: the expected service name is overridable for other deployments", () => {
  const v = obcHealthVerdict(
    { ok: true, status: 200, body: '{"status":"ok","service":"obc-staging"}' },
    "obc-staging",
  );
  assert.strictEqual(v.ok, true);
});
