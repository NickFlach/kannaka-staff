"use strict";

const path = require("path");

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

module.exports = { readEnvMs, statusCachePathFor };
