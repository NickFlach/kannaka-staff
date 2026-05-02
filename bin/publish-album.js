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
const radioRepo = arg("radio-repo", path.join(process.env.HOME || ".", "Source", "kannaka-radio"));
const dryRun = flag("dry-run");
const autoPatch = flag("patch");
const autoDeploy = flag("deploy"); // implies --patch
const autoShowcase = flag("showcase"); // implies --deploy
const showcaseDuration = parseInt(arg("showcase-duration", "35"), 10);
const radioApi = arg("radio-api", "http://170.9.238.136:8888");

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

// ── Step 4: auto-patch (--patch / --deploy) ─────────────────
function patchDjEngine() {
  const file = path.join(radioRepo, "server", "dj-engine.js");
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(`"${albumName}":`)) {
    console.log(`  ⚠ ${albumName} already in dj-engine.js — skipping patch`);
    return false;
  }
  // Insert before the very last `};` that closes the ALBUMS const.
  // We anchor on the start of ALBUMS and find the matching close-brace.
  const startIdx = src.indexOf("const ALBUMS = {");
  if (startIdx < 0) throw new Error("ALBUMS const not found");
  // Find the close-brace by walking with depth counting from startIdx.
  let depth = 0;
  let endIdx = -1;
  for (let i = src.indexOf("{", startIdx); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx < 0) throw new Error("ALBUMS close-brace not found");
  // Find the line with the close brace and insert just before it.
  const lineStart = src.lastIndexOf("\n", endIdx) + 1;
  // Look at the chunk right before our insertion point. If the
  // previous entry's closing `}` lacks a trailing comma, we'd produce
  // invalid JS — the 2026-05-02 incident broke the radio for ~2 min.
  // Walk backwards from lineStart skipping whitespace/newlines until
  // we hit a non-whitespace char. If it's `}`, append a comma.
  let needComma = false;
  for (let i = lineStart - 1; i >= 0; i--) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    if (c === "}") needComma = true;
    break;
  }
  if (needComma) {
    // Insert the comma right after the last `}` we found.
    const closeIdx = src.lastIndexOf("}", lineStart - 1);
    if (closeIdx >= 0) {
      src = src.slice(0, closeIdx + 1) + "," + src.slice(closeIdx + 1);
      console.log("  ⚠ inserted missing trailing comma after previous album entry");
    }
  }
  const block = `  "${albumName}": {\n` +
    `    theme: ${JSON.stringify(theme)},\n` +
    `    tracks: [\n` +
    titles.map((t) => `      ${JSON.stringify(t)},`).join("\n") + "\n" +
    `    ]\n` +
    `  },\n`;
  // Re-find lineStart since src may have shifted by 1 byte if we inserted a comma.
  const recomputedClose = src.lastIndexOf("};");
  const recomputedLineStart = src.lastIndexOf("\n", recomputedClose) + 1;
  src = src.slice(0, recomputedLineStart) + block + src.slice(recomputedLineStart);
  fs.writeFileSync(file, src);
  return true;
}

function patchProgramming() {
  const file = path.join(radioRepo, "server", "programming.js");
  let src = fs.readFileSync(file, "utf8");
  let touched = false;
  for (const blockLabel of blocks) {
    // Find the SCHEDULE entry whose `label: '<block>'` matches.
    // Then in the same block object, find `albums: [` and prepend our entry.
    const labelRe = new RegExp(`label:\\s*['"\`]${blockLabel.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}['"\`]`);
    const labelMatch = labelRe.exec(src);
    if (!labelMatch) {
      console.log(`  ⚠ block label '${blockLabel}' not found — skipping`);
      continue;
    }
    // Find the nearest preceding `albums: [` before this label match
    // (within the SAME object — we walk backwards looking for it).
    const slice = src.slice(0, labelMatch.index);
    const albumsIdx = slice.lastIndexOf("albums:");
    if (albumsIdx < 0) {
      console.log(`  ⚠ albums: array for block '${blockLabel}' not found`);
      continue;
    }
    // Find the closing `]` of THAT albums array.
    const arrStart = src.indexOf("[", albumsIdx);
    let depth = 0;
    let arrEnd = -1;
    for (let i = arrStart; i < src.length; i++) {
      if (src[i] === "[") depth++;
      else if (src[i] === "]") { depth--; if (depth === 0) { arrEnd = i; break; } }
    }
    if (arrEnd < 0) {
      console.log(`  ⚠ albums: array close-bracket for block '${blockLabel}' not found`);
      continue;
    }
    // Check if already in this block.
    const arrSrc = src.slice(arrStart, arrEnd + 1);
    if (arrSrc.includes(`'${albumName}'`) || arrSrc.includes(`"${albumName}"`)) {
      console.log(`  ⚠ ${albumName} already in block '${blockLabel}' — skipping`);
      continue;
    }
    // Insert before the close bracket. Honor the existing trailing comma style.
    const lineStart = src.lastIndexOf("\n", arrEnd) + 1;
    const insert = `      '${albumName}',\n`;
    src = src.slice(0, lineStart) + insert + src.slice(lineStart);
    console.log(`  ✓ patched programming.js — added '${albumName}' to '${blockLabel}'`);
    touched = true;
  }
  if (touched) fs.writeFileSync(file, src);
  return touched;
}

if (autoPatch || autoDeploy) {
  if (dryRun) {
    console.log("\n[dry-run] would auto-patch dj-engine.js + programming.js");
  } else {
    console.log("\n=== Auto-patching radio source ===");
    try {
      const djTouched = patchDjEngine();
      if (djTouched) console.log(`  ✓ patched dj-engine.js — added '${albumName}' to ALBUMS`);
      const progTouched = patchProgramming();
      if (autoDeploy || autoShowcase) {
        console.log("\n=== Committing + deploying ===");
        execFileSync("git", ["add", "server/dj-engine.js", "server/programming.js"], { cwd: radioRepo, stdio: "inherit" });
        execFileSync("git", ["commit", "-m", `feat(album): ${albumName}`], { cwd: radioRepo, stdio: "inherit" });
        execFileSync("git", ["push"], { cwd: radioRepo, stdio: "inherit" });
        console.log("\n  ✓ pushed; restarting Oracle radio service");
        execFileSync("ssh", ["-i", sshKey, "-o", "StrictHostKeyChecking=no", sshHost,
          `cd /home/opc/kannaka-radio && git pull --ff-only && sudo systemctl restart kannaka-radio`],
          { stdio: "inherit" });
        console.log(`  ✓ deployed`);
      }
      if (autoShowcase) {
        console.log("\n=== Triggering showcase ===");
        // Wait a beat for the radio service to come back up after restart.
        execFileSync("ssh", ["-i", sshKey, "-o", "StrictHostKeyChecking=no", sshHost,
          `until sudo systemctl is-active kannaka-radio >/dev/null 2>&1; do sleep 2; done; sleep 3`],
          { stdio: "inherit" });
        const showcaseUrl = `${radioApi}/api/album/showcase?album=${encodeURIComponent(albumName)}&duration=${showcaseDuration}`;
        execFileSync("ssh", ["-i", sshKey, "-o", "StrictHostKeyChecking=no", sshHost,
          `curl -s -X POST '${showcaseUrl.replace(radioApi, "http://localhost:8888")}'`],
          { stdio: "inherit" });
        console.log(`\n  ✓ showcase triggered for ${albumName} (${showcaseDuration} min)`);
      }
    } catch (e) {
      console.error(`\n  ✗ auto-patch/deploy failed: ${e.message}`);
      console.error("  Files may be partially modified — review with git diff before committing.");
      process.exit(1);
    }
  }
} else {
  console.log("\n=== to deploy ===");
  console.log("  Re-run with --patch (auto-edits dj-engine.js + programming.js)");
  console.log("  Or --deploy (patch + commit + push + ssh restart)");
  console.log("");
  console.log(`  curl -X POST 'http://localhost:8888/api/album/showcase?album=${encodeURIComponent(albumName)}'  # after deploy`);
}
