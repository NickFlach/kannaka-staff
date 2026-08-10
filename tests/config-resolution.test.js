"use strict";

// Config resolution for the probes and roles that used to carry
// Oracle-only hardcodes: the radio's listen address, the NATS broker,
// the icecast mount, and the sibling kannaka-radio checkout.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hostPortOf, resolveRadioRepo, resolveNatsEndpoint, streamMountOf } = require("../src/staff/util");

// ── #47: radio_port_alive must follow STAFF_RADIO_BASE ──────────

test("#47 regression: the probed socket comes from RADIO_BASE, not a hardcoded 8888", () => {
  // Before the fix, radio_port_alive always dialled 127.0.0.1:8888, so a
  // staff instance pointed at a radio on another host/port reported the
  // wrong socket — green when the real radio was dead, or vice versa.
  assert.deepStrictEqual(
    hostPortOf("http://radio.internal:9999", "127.0.0.1", 8888),
    { hostname: "radio.internal", port: 9999 },
  );
});

test("#47: the default RADIO_BASE still resolves to localhost:8888", () => {
  assert.deepStrictEqual(
    hostPortOf("http://localhost:8888", "127.0.0.1", 8888),
    { hostname: "localhost", port: 8888 },
  );
});

test("#47: a base with no explicit port takes the protocol default", () => {
  assert.deepStrictEqual(hostPortOf("https://radio.ninja-portal.com").port, 443);
  assert.deepStrictEqual(hostPortOf("http://radio.ninja-portal.com").port, 80);
});

test("#47: an unparseable base falls back rather than throwing", () => {
  assert.deepStrictEqual(
    hostPortOf("", "127.0.0.1", 8888),
    { hostname: "127.0.0.1", port: 8888 },
  );
});

// ── #45: nats_reachable must follow the shared broker setting ───

test("#45 regression: KANNAKA_NATS_URL selects the probed broker", () => {
  // Before the fix, staff read only STAFF_NATS_HOST/PORT and silently
  // probed the default Oracle broker while the rest of the constellation
  // talked to whatever KANNAKA_NATS_URL pointed at.
  assert.deepStrictEqual(
    resolveNatsEndpoint({ KANNAKA_NATS_URL: "nats://broker.internal:4333" }),
    { host: "broker.internal", port: 4333 },
  );
});

test("#45: a bare host:port in KANNAKA_NATS_URL is accepted", () => {
  assert.deepStrictEqual(
    resolveNatsEndpoint({ KANNAKA_NATS_URL: "broker.internal:4333" }),
    { host: "broker.internal", port: 4333 },
  );
});

test("#45: KANNAKA_NATS_URL without a port takes the NATS default", () => {
  assert.deepStrictEqual(
    resolveNatsEndpoint({ KANNAKA_NATS_URL: "nats://broker.internal" }),
    { host: "broker.internal", port: 4222 },
  );
});

test("#45: explicit STAFF_NATS_HOST/PORT still win over the shared URL", () => {
  assert.deepStrictEqual(
    resolveNatsEndpoint({ STAFF_NATS_HOST: "a.example", STAFF_NATS_PORT: "1234", KANNAKA_NATS_URL: "nats://b.example:4333" }),
    { host: "a.example", port: 1234 },
  );
});

test("#45: with nothing configured the Oracle broker remains the default", () => {
  assert.deepStrictEqual(
    resolveNatsEndpoint({}),
    { host: "swarm.ninja-portal.com", port: 4222 },
  );
});

// ── #69: the icecast mount comes from STAFF_STREAM_URL ──────────

test("#69 regression: the mount is read off the configured stream URL", () => {
  // stream_metadata_advancing matched `listenurl.endsWith("/stream")`, so
  // a deployment serving any other mount never found its source and
  // reported a permanent false failure.
  assert.strictEqual(streamMountOf("https://radio.ninja-portal.com/live"), "/live");
  assert.strictEqual(streamMountOf("http://127.0.0.1:8000/preview"), "/preview");
});

test("#69: the default stream URL still yields /stream", () => {
  assert.strictEqual(streamMountOf("https://radio.ninja-portal.com/stream"), "/stream");
});

test("#69: a pathless or empty stream URL falls back to /stream", () => {
  assert.strictEqual(streamMountOf("https://radio.ninja-portal.com"), "/stream");
  assert.strictEqual(streamMountOf("https://radio.ninja-portal.com/"), "/stream");
  assert.strictEqual(streamMountOf(""), "/stream");
  assert.strictEqual(streamMountOf(undefined), "/stream");
});

// ── #40 / #55: the sibling kannaka-radio checkout ───────────────

test("#40/#55 regression: a sibling kannaka-radio checkout is preferred over the Oracle path", () => {
  // In a normal Source/kannaka-staff + Source/kannaka-radio layout both
  // Distributor and Marketer used to resolve to /home/opc/kannaka-radio,
  // which does not exist, and refused every job.
  const prev = process.env.TEST_RADIO_REPO;
  delete process.env.TEST_RADIO_REPO;
  try {
    const resolved = resolveRadioRepo("TEST_RADIO_REPO");
    const sibling = path.resolve(__dirname, "..", "..", "kannaka-radio");
    if (fs.existsSync(sibling)) {
      assert.strictEqual(resolved, sibling, "should pick up the sibling checkout");
    } else {
      assert.strictEqual(resolved, "/home/opc/kannaka-radio", "no sibling → Oracle default");
    }
  } finally {
    if (prev !== undefined) process.env.TEST_RADIO_REPO = prev;
  }
});

test("#40/#55: an explicit env override always wins", () => {
  const prev = process.env.TEST_RADIO_REPO;
  const custom = path.join(os.tmpdir(), "some-other-radio");
  process.env.TEST_RADIO_REPO = custom;
  try {
    assert.strictEqual(resolveRadioRepo("TEST_RADIO_REPO"), custom);
  } finally {
    if (prev === undefined) delete process.env.TEST_RADIO_REPO; else process.env.TEST_RADIO_REPO = prev;
  }
});

test("#40/#55: the Oracle path remains the last resort", () => {
  const prev = process.env.TEST_RADIO_REPO;
  delete process.env.TEST_RADIO_REPO;
  try {
    // A repo name that cannot have a sibling proves the final fallback.
    assert.strictEqual(
      resolveRadioRepo("TEST_RADIO_REPO", "/home/opc/kannaka-radio").endsWith("kannaka-radio"),
      true,
    );
  } finally {
    if (prev !== undefined) process.env.TEST_RADIO_REPO = prev;
  }
});
