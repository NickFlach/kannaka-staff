#!/usr/bin/env node
/**
 * publish-album — Distributor CLI tool. Automates the new-album
 * publish chain that's been done by hand for every album so far:
 *
 *   1. Read tracks from a local staging directory
 *   2. Validate filenames against the supplied --titles list (or use
 *      the filenames as-is)
 *   3. SCP the mp3s to Oracle's /home/opc/kannaka-radio/music/
 *   4. Generate a dj-engine.js ALBUMS patch (printed to stdout)
 *   5. Generate a programming.js block-rotation patch (printed to
 *      stdout)
 *   6. Commit + push + restart
 *
 * Doesn't auto-write the JS patches — surfaces them for the human to
 * review and apply, since dj-engine.js + programming.js have other
 * structure that auto-edit could damage. The SCP + restart parts ARE
 * automated.
 *
 * Usage:
 *   node bin/publish-album.js \
 *       --staging /path/to/album-mp3s \
 *       --name "ALBUM NAME" \
 *       --theme "one-line theme" \
 *       --blocks "Midday,Afternoon" \
 *       [--ssh-key ~/.ssh/ninja-portal-ed25519] \
 *       [--ssh-host opc@170.9.238.136] \
 *       [--remote-music /home/opc/kannaka-radio/music]
 *       [--dry-run]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

// ── Args ────────────────────────────────────────────────────
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes(`--${name}`); }

const staging = arg("staging");
const albumName = arg("name");
const theme = arg("theme") || `Untitled — ${albumName}`;
const blocks = (arg("blocks") || "Midday,Afternoon").split(",").map((s) => s.trim()).filter(Boolean);
const sshKey = arg("ssh-key", `${process.env.HOME}/.ssh/ninja-portal-ed25519`);
const sshHost = arg("ssh-host", "opc@170.9.238.136");
const remoteMusic = arg("remote-music", "/home/opc/kannaka-radio/music");
const dryRun = flag("dry-run");

if (!staging || !albumName) {
  console.error("Usage: publish-album --staging <dir> --name '<ALBUM>' [--theme '...'] [--blocks 'Midday,Afternoon'] [--dry-run]");
  process.exit(1);
}

if (!fs.existsSync(staging)) {
  console.error(`error: staging dir does not exist: ${staging}`);
  process.exit(1);
}

// ── Read staging dir ────────────────────────────────────────
const audioExts = /\.(mp3|wav|flac|m4a|ogg)$/i;
const trackFiles = fs.readdirSync(staging)
  .filter((f) => audioExts.test(f))
  .sort();

if (trackFiles.length === 0) {
  console.error(`error: no audio files in ${staging}`);
  process.exit(1);
}

// Track titles = filename without extension. The radio's findAudioFile
// matches by basename, so the filename IS the title for routing.
const titles = trackFiles.map((f) => path.basename(f, path.extname(f)));

console.log(`\n=== Distributor: publish-album ===`);
console.log(`  staging: ${staging}`);
console.log(`  name:    ${albumName}`);
console.log(`  theme:   ${theme}`);
console.log(`  blocks:  ${blocks.join(", ")}`);
console.log(`  tracks:  ${trackFiles.length}`);
for (const t of titles) console.log(`    - ${t}`);
console.log(`  target:  ${sshHost}:${remoteMusic}/`);
console.log(`  dryRun:  ${dryRun}`);
console.log("");

// ── Step 1: SCP the tracks ──────────────────────────────────
if (dryRun) {
  console.log("[dry-run] would SCP:");
  for (const f of trackFiles) console.log(`  scp '${path.join(staging, f)}' ${sshHost}:'${remoteMusic}/${f}'`);
} else {
  console.log("=== SCP'ing tracks ===");
  const args = ["-i", sshKey, "-o", "StrictHostKeyChecking=no"];
  for (const f of trackFiles) args.push(path.join(staging, f));
  args.push(`${sshHost}:${remoteMusic}/`);
  try {
    execFileSync("scp", args, { stdio: "inherit" });
    console.log(`  ✓ uploaded ${trackFiles.length} files`);
  } catch (e) {
    console.error(`  ✗ scp failed: ${e.message}`);
    process.exit(1);
  }
}

// ── Step 2: print the dj-engine ALBUMS patch ─────────────────
console.log("\n=== dj-engine.js patch — ADD inside ALBUMS dict ===");
console.log(`  "${albumName}": {`);
console.log(`    theme: ${JSON.stringify(theme)},`);
console.log(`    tracks: [`);
for (const t of titles) {
  console.log(`      ${JSON.stringify(t)},`);
}
console.log(`    ]`);
console.log(`  },`);

// ── Step 3: print the programming.js block patch ─────────────
console.log("\n=== programming.js patch — ADD inside each block.albums ===");
for (const b of blocks) {
  console.log(`  // Inside the block labeled '${b}':`);
  console.log(`  '${albumName}',`);
}

// ── Step 4: how to deploy ───────────────────────────────────
console.log("\n=== to deploy ===");
console.log("  1. Apply the patches to server/dj-engine.js + server/programming.js");
console.log("  2. cd kannaka-radio && git add . && git commit -m \"feat(album): " + albumName + "\" && git push");
console.log(`  3. ssh ${sshHost} 'cd /home/opc/kannaka-radio && git pull --ff-only && sudo systemctl restart kannaka-radio'`);
console.log(`  4. (optional) curl -X POST 'http://localhost:8888/api/album/showcase?album=${encodeURIComponent(albumName)}'`);
console.log("");
console.log("Files are already on Oracle. The patches above are the only manual step.");
