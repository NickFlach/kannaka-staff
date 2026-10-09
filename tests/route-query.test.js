"use strict";

// #106: GET routes match on the pathname, so a harmless query string
// (cache-buster, trace id) no longer turns a valid /api request into a 404.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { requestTarget, server } = require("../src/index.js");

test("#106: requestTarget splits pathname from query", () => {
  const t = requestTarget("/api/state?x=1&y=two");
  assert.strictEqual(t.pathname, "/api/state");
  assert.strictEqual(t.searchParams.get("y"), "two");
  assert.strictEqual(requestTarget("/api/voice").pathname, "/api/voice");
  assert.strictEqual(requestTarget(undefined).pathname, "/");
});

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

test("#106: /api/state answers 200 with and without a query string", async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    assert.strictEqual(await get(port, "/api/state"), 200);
    assert.strictEqual(await get(port, "/api/state?x=1"), 200);
    assert.strictEqual(await get(port, "/api/bus?since=0"), 200);
    assert.strictEqual(await get(port, "/api/state/extra"), 404);
    assert.strictEqual(await get(port, "/api/nope?x=1"), 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});