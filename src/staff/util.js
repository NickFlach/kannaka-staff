"use strict";

const fs = require("fs");
const path = require("path");
const url = require("url");

function readEnvMs(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Locate the memory-count cache that belongs to a given HRM. `kannaka`
 * writes status-cache.json beside the medium it describes, so the cache
 * has to be derived from the configured HRM path — reading
 * $HOME/.kannaka/status-cache.json unconditionally makes a host with
 * STAFF_HRM_PATH pointing elsewhere (the witness box) report the
 * primary's memory count against the witness's HRM size.
 * KANNAKA_STATUS_CACHE overrides for layouts that split the two.
 */
function statusCachePathFor(hrmPath) {
  const override = (process.env.KANNAKA_STATUS_CACHE || "").trim();
  if (override) return override;
  const base = hrmPath
    ? path.dirname(hrmPath)
    : path.join(process.env.HOME || "/home/opc", ".kannaka");
  return path.join(base, "status-cache.json");
}

/**
 * Locate the sibling kannaka-radio checkout that Distributor and
 * Marketer shell into. The Oracle box keeps it at /home/opc/kannaka-radio,
 * but that path does not exist in a normal developer checkout, so both
 * roles booted straight into "MISSING" and refused every job.
 *
 * Order: explicit env override, then a sibling of this repo (the usual
 * Source/kannaka-staff + Source/kannaka-radio layout), then the Oracle
 * path last so production behaviour is unchanged.
 */
function resolveRadioRepo(envName, oracleDefault = "/home/opc/kannaka-radio") {
  const override = (process.env[envName] || "").trim();
  if (override) return override;
  const sibling = path.resolve(__dirname, "..", "..", "..", "kannaka-radio");
  try {
    if (fs.existsSync(sibling)) return sibling;
  } catch (_) { /* fall through to the Oracle default */ }
  return oracleDefault;
}

/**
 * Split an http(s) base URL into { hostname, port }, filling in the
 * protocol's default port. Probes that hardcoded 127.0.0.1:8888 ignored
 * STAFF_RADIO_BASE entirely and reported on the wrong host.
 */
function hostPortOf(base, fallbackHost = "127.0.0.1", fallbackPort = 80) {
  try {
    const u = url.parse(base);
    if (!u.hostname) return { hostname: fallbackHost, port: fallbackPort };
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80);
    return { hostname: u.hostname, port };
  } catch (_) {
    return { hostname: fallbackHost, port: fallbackPort };
  }
}

/**
 * Resolve the NATS broker to probe. STAFF_NATS_HOST/PORT win when both
 * are set, but the rest of the constellation configures its broker
 * through the shared KANNAKA_NATS_URL — ignoring it meant staff probed
 * the default Oracle broker while everything else talked to the
 * configured one, so nats_reachable answered a question nobody asked.
 */
function resolveNatsEndpoint(env = process.env) {
  const host = (env.STAFF_NATS_HOST || "").trim();
  const port = (env.STAFF_NATS_PORT || "").trim();
  if (host && port) return { host, port: parseInt(port, 10) };
  const shared = (env.KANNAKA_NATS_URL || "").trim();
  if (shared) {
    const u = url.parse(shared.includes("://") ? shared : `nats://${shared}`);
    if (u.hostname) {
      return { host: host || u.hostname, port: parseInt(port || u.port || "4222", 10) };
    }
  }
  return { host: host || "swarm.ninja-portal.com", port: parseInt(port || "4222", 10) };
}

/**
 * The icecast mount listeners are actually on, read off STREAM_URL
 * instead of assumed to be "/stream". The mount-alignment and
 * metadata-advancing probes both compared against a literal, so a
 * deployment serving any other mount got permanent false failures.
 */
function streamMountOf(streamUrl, fallback = "/stream") {
  try {
    const p = url.parse(streamUrl || "").pathname;
    return p && p !== "/" ? p : fallback;
  } catch (_) {
    return fallback;
  }
}

module.exports = {
  readEnvMs,
  statusCachePathFor,
  resolveRadioRepo,
  hostPortOf,
  resolveNatsEndpoint,
  streamMountOf,
};
