/**
 * ADR-004 W5 — the staff witnesses itself (#95).
 *
 * healthSnapshot with fake clocks (wedge detection), NATS publish frame
 * format, and a live loopback publish against an in-test fake NATS server
 * — hermetic: the only socket is 127.0.0.1 to a server this file owns.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const net = require("net");

const { healthSnapshot, natsPublishFrames, publishNatsHeartbeat } = require("../src/index.js");

// ── healthSnapshot (fake clocks) ────────────────────────────────────

test("W5: fresh ticks are healthy", () => {
  const now = 1_000_000;
  const s = healthSnapshot({
    now,
    startedAt: now - 500_000,
    probeLastTick: now - 30_000, // half an interval ago
    probeTickMs: 60_000,
    roles: { growth: { online: true }, ear: { online: true } },
  });
  assert.strictEqual(s.ok, true);
  assert.deepStrictEqual(s.wedged, []);
  assert.strictEqual(s.subsystems.probes.stale, false);
});

test("W5: a wedged probe loop is stale past 2× interval and flips ok:false", () => {
  const now = 1_000_000;
  const s = healthSnapshot({
    now,
    startedAt: now - 500_000,
    probeLastTick: now - 121_000, // > 2× 60s
    probeTickMs: 60_000,
  });
  assert.strictEqual(s.ok, false);
  assert.deepStrictEqual(s.wedged, ["probes"]);
  assert.match(s.subsystems.probes.reason, /last tick 121s ago/);
});

test("W5: exactly one missed tick is jitter, not a wedge", () => {
  const now = 1_000_000;
  const s = healthSnapshot({ now, startedAt: now, probeLastTick: now - 110_000, probeTickMs: 60_000 });
  assert.strictEqual(s.subsystems.probes.stale, false, "≤2× interval is tolerated");
});

test("W5: a never-ticked subsystem is stale with an honest reason", () => {
  const s = healthSnapshot({ now: 5, startedAt: 1, probeLastTick: null, probeTickMs: 60_000 });
  assert.strictEqual(s.subsystems.probes.stale, true);
  assert.strictEqual(s.subsystems.probes.reason, "never ticked");
});

test("W5: offline roles report honestly without counting as wedged", () => {
  const now = 1_000_000;
  const s = healthSnapshot({
    now, startedAt: now, probeLastTick: now, probeTickMs: 60_000,
    roles: { growth: { online: false, reason: "no HRM on this host" } },
  });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.subsystems.growth.online, false);
  assert.match(s.subsystems.growth.reason, /no HRM/);
});

test("W5: heartbeat that never sent is stale with the transport error", () => {
  const now = 1_000_000;
  const s = healthSnapshot({
    now, startedAt: now, probeLastTick: now, probeTickMs: 60_000,
    heartbeat: { lastSentTs: null, intervalMs: 60_000, lastError: "ECONNREFUSED" },
  });
  assert.strictEqual(s.subsystems.heartbeat.stale, true);
  assert.match(s.subsystems.heartbeat.reason, /never sent \(ECONNREFUSED\)/);
  assert.strictEqual(s.ok, false);
});

// ── NATS wire format ────────────────────────────────────────────────

test("W5: publish frames are CONNECT + PUB with an exact byte count", () => {
  const frames = natsPublishFrames("KANNAKA.staff.heartbeat", { a: 1 }).toString("utf8");
  const payload = JSON.stringify({ a: 1 });
  assert.match(frames, /^CONNECT \{"verbose":false/);
  assert.ok(
    frames.includes(`PUB KANNAKA.staff.heartbeat ${Buffer.byteLength(payload)}\r\n${payload}\r\n`),
    `bad frame: ${JSON.stringify(frames)}`
  );
});

test("W5: heartbeat publishes over loopback to a fake NATS server", async () => {
  const received = [];
  const server = net.createServer((sock) => {
    sock.write('INFO {"server_id":"fake"}\r\n');
    sock.on("data", (d) => received.push(d.toString("utf8")));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const r = await publishNatsHeartbeat({
      host: "127.0.0.1", port,
      subject: "KANNAKA.staff.heartbeat",
      payload: { ts: 123 },
      timeoutMs: 3000,
    });
    assert.strictEqual(r.ok, true, r.error);
    const all = received.join("");
    assert.match(all, /CONNECT /);
    assert.match(all, /PUB KANNAKA\.staff\.heartbeat \d+\r\n\{"ts":123\}\r\n/);
  } finally {
    server.close();
  }
});

test("W5: a dead NATS host reports the error instead of hanging or throwing", async () => {
  const r = await publishNatsHeartbeat({
    host: "127.0.0.1", port: 1, // nothing listens on 1
    subject: "KANNAKA.staff.heartbeat",
    payload: { ts: 1 },
    timeoutMs: 2000,
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error, "carries the transport error");
});
