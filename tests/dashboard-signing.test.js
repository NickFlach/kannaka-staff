"use strict";

// The dashboard signs its own action requests when the caller is remote
// and STAFF_SHARED_SECRET is set (#9): the operator pastes the secret, the
// page derives an HMAC per request, and the secret itself never leaves the
// browser. These tests pin the three render modes, the inline script's
// syntax, and — most importantly — that the signature the page would
// produce is the one the server actually verifies.

process.env.KANNAKA_TEST_TTL_MS = process.env.KANNAKA_TEST_TTL_MS || "5000";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { subtle } = require("node:crypto").webcrypto;
const { dashboardHtml, actionAvailability, verifyStaffHmac } = require("../src/index.js");

const SECRET = "test-shared-secret";

const OPEN = actionAvailability({ isLocal: true, secret: SECRET });
const UNLOCKABLE = actionAvailability({ isLocal: false, secret: SECRET });
const REFUSED = actionAvailability({ isLocal: false, secret: undefined });

// ── availability modes ──────────────────────────────────────────

test("#9: a local caller is 'open' — buttons work unsigned", () => {
  assert.strictEqual(OPEN.mode, "open");
  assert.strictEqual(OPEN.enabled, true);
});

test("#9: remote + secret is 'unlockable' — locked, but signable in-browser", () => {
  assert.strictEqual(UNLOCKABLE.mode, "unlockable");
  assert.strictEqual(UNLOCKABLE.enabled, false, "starts locked");
  assert.match(UNLOCKABLE.reason, /unlock/i);
});

test("#9: remote with no secret is 'refused' — nothing to unlock", () => {
  assert.strictEqual(REFUSED.mode, "refused");
  assert.strictEqual(REFUSED.enabled, false);
  assert.match(REFUSED.reason, /STAFF_SHARED_SECRET/);
});

// ── rendered page ───────────────────────────────────────────────

test("#9: only the unlockable page renders the unlock control", () => {
  assert.ok(dashboardHtml(UNLOCKABLE).includes('id="secretInput"'), "unlockable page offers unlock");
  assert.ok(!dashboardHtml(OPEN).includes('id="secretInput"'), "open page needs no unlock");
  assert.ok(!dashboardHtml(REFUSED).includes('id="secretInput"'), "refused page must not offer a pointless unlock");
});

test("#9: locked pages render their buttons disabled", () => {
  assert.ok(dashboardHtml(UNLOCKABLE).includes("<button") && dashboardHtml(UNLOCKABLE).includes(" disabled>"));
  assert.ok(!dashboardHtml(OPEN).includes(" disabled>"), "open page leaves buttons live");
});

test("#9: the page states the secret is not transmitted", () => {
  assert.match(dashboardHtml(UNLOCKABLE), /never sent/i);
  assert.match(dashboardHtml(UNLOCKABLE), /sessionStorage/);
});

test("#9: the page never embeds the secret itself", () => {
  // The server knows STAFF_SHARED_SECRET; it must never reach the HTML.
  for (const a of [OPEN, UNLOCKABLE, REFUSED]) {
    assert.ok(!dashboardHtml(a).includes(SECRET), `secret leaked into ${a.mode} page`);
  }
});

test("#9: the inline page script parses", () => {
  // The page JS lives inside a template literal, so `node --check` on
  // src/index.js cannot see a syntax error in it. new Function() parses
  // without executing, which is exactly the check we want.
  for (const a of [OPEN, UNLOCKABLE, REFUSED]) {
    const html = dashboardHtml(a);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, "expected at least one inline script");
    for (const body of scripts) {
      assert.doesNotThrow(() => new Function(body), `inline script syntax error in ${a.mode} page`);
    }
  }
});

// ── the signature actually verifies ─────────────────────────────

/** Reproduce exactly what the page's signPath() computes, via Web Crypto. */
async function signLikeBrowser(secret, method, path, ts) {
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await subtle.sign("HMAC", key, enc.encode(ts + "\n" + method + "\n" + path));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("#9 regression: a browser-computed signature passes verifyStaffHmac", async () => {
  const path = "/action/growth-dream?mode=lite";
  const ts = String(Date.now());
  const sig = await signLikeBrowser(SECRET, "POST", path, ts);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: "POST", reqUrl: path });
  assert.strictEqual(r.ok, true, r.error);
});

test("#9: Web Crypto and the server's Node HMAC agree byte for byte", async () => {
  const path = "/action/restart-radio";
  const ts = String(Date.now());
  const web = await signLikeBrowser(SECRET, "POST", path, ts);
  const node = crypto.createHmac("sha256", SECRET).update(ts + "\n" + "POST" + "\n" + path).digest("hex");
  assert.strictEqual(web, node);
});

test("#9: a non-ASCII secret still agrees (UTF-8 encoding matches)", async () => {
  const s = "sécret-ünïcode-🔑";
  const path = "/action/trigger-oration";
  const ts = String(Date.now());
  const web = await signLikeBrowser(s, "POST", path, ts);
  const node = crypto.createHmac("sha256", s).update(ts + "\n" + "POST" + "\n" + path).digest("hex");
  assert.strictEqual(web, node);
});

test("#9: the wrong secret is rejected exactly as before (401)", async () => {
  const path = "/action/restart-radio";
  const ts = String(Date.now());
  const sig = await signLikeBrowser("not-the-secret", "POST", path, ts);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: "POST", reqUrl: path });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 401);
  assert.match(r.error, /bad signature/);
});

test("#9 regression: the query string is part of the signed path", async () => {
  // The server signs req.url, query string included. Signing only the
  // pathname is the obvious way to ship an unlock that 401s on every
  // parameterised action while appearing to work on bare ones.
  const ts = String(Date.now());
  const sigWithoutQs = await signLikeBrowser(SECRET, "POST", "/action/growth-dream", ts);
  const r = verifyStaffHmac({
    secret: SECRET, isLocal: false, sig: sigWithoutQs, ts,
    method: "POST", reqUrl: "/action/growth-dream?mode=lite",
  });
  assert.strictEqual(r.ok, false, "a path-only signature must not verify");
});

test("#9: the page signs the full path including the query string", () => {
  // Guard the call site, not just the concept: act() must build one `path`
  // and use it for both the signature and the fetch.
  const html = dashboardHtml(UNLOCKABLE);
  assert.match(html, /const path = '\/action\/' \+ action \+ qs;/);
  assert.match(html, /signPath\(secret, 'POST', path\)/);
  assert.match(html, /fetch\(path, opts\)/);
});

/**
 * Lift the page's OWN signPath() out of the rendered HTML and run it, with
 * Web Crypto supplied the way a browser would. The tests above prove the
 * scheme is right; this one proves the shipped page implements that scheme,
 * which is the part that can actually regress.
 */
function pageSignPath(html) {
  const m = html.match(/async function signPath\([\s\S]*?\n\}/);
  assert.ok(m, "could not find signPath() in the rendered page");
  return new Function("crypto", "TextEncoder", `${m[0]}; return signPath;`)(
    require("node:crypto").webcrypto,
    TextEncoder,
  );
}

test("#9 regression: the page's own signPath produces a signature the server accepts", async () => {
  const signPath = pageSignPath(dashboardHtml(UNLOCKABLE));
  const path = "/action/growth-dream?mode=lite";
  const { ts, sig } = await signPath(SECRET, "POST", path);
  const r = verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: "POST", reqUrl: path });
  assert.strictEqual(r.ok, true, `page signature rejected: ${r.error}`);
});

test("#9: the page's signPath binds the method and the path", async () => {
  const signPath = pageSignPath(dashboardHtml(UNLOCKABLE));
  const { ts, sig } = await signPath(SECRET, "POST", "/action/restart-radio");
  // same signature, different path → must not verify
  assert.strictEqual(
    verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: "POST", reqUrl: "/action/restart-observatory" }).ok,
    false,
  );
  // same signature, different method → must not verify
  assert.strictEqual(
    verifyStaffHmac({ secret: SECRET, isLocal: false, sig, ts, method: "GET", reqUrl: "/action/restart-radio" }).ok,
    false,
  );
});
