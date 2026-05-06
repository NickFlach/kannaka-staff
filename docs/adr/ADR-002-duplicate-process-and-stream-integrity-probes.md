# ADR-002 — Watcher: duplicate-process + stream-integrity probes

**Status:** Proposed
**Date:** 2026-05-06
**Author:** Kannaka + Nick Flach
**Depends on:** ADR-001 (kannaka-staff scope and roles)
**Triggered by:** the 2026-05-05 production incident on PH launch day

---

## Context

On 2026-05-05 (Product Hunt launch day) two production bugs surfaced
that the existing Watcher probe set could not detect, both of which
were audible to listeners:

1. **Duplicate `kannaka-radio` processes.** PM2 was managing
   `kannaka-radio` in parallel with the systemd unit. Both nodes spawned
   their own dj-engine, both pushed `ffmpeg → icecast` on `/stream`. At
   10:00 AM CST both podcast schedulers fired simultaneously and Icecast
   ping-ponged the source slot — a listener heard the podcast intro then
   the OTHER node's music shoved its way in.

   **Why we missed it:** the existing `radio_service` probe (`systemctl
   is-active kannaka-radio`) reported "active" because *one* of the two
   processes was systemd-managed. The PM2-spawned twin was invisible to
   any probe. There was no probe asking "how many nodes are running?"

2. **Silent HTTP-server death.** The systemd-managed radio process was
   alive (per `systemctl is-active`) but its HTTP server had crashed
   silently inside the node — port 8888 was unbound. The SPA's
   recently-played list went stale because `/api/history` returned
   nothing; the player UI hid its panel. The radio kept piping audio to
   icecast (the streaming subsystem is independent of the HTTP server),
   so listeners didn't notice immediately. Operators didn't notice
   because `systemctl is-active` lied.

   **Why we missed it:** `radio_service` probes only the systemd state.
   We have an HTTP probe (`probeHttp`) that hits `/api/now-playing` —
   that *would* have caught this — but if it ever erred out the alert
   was easy to dismiss as "just a transient." There was no
   process-vs-port consistency check that flags the specific
   "process-alive-but-port-silent" pattern.

3. **Mount/metadata mismatch.** The metadata writer was pushing track
   titles to `/preview` while listeners were on `/stream`. Listeners saw
   blank Now-Playing forever. There was no probe correlating "what mount
   the dj-engine writes metadata to" with "what mount the public SPA
   points listeners at."

A separate but related bug (2026-05-06): a podcast mp3 with mismatched
sample-rate (48 kHz at 192 kbps vs the radio's pipe expectation of 44.1
kHz / 128 kbps) caused ffmpeg to die instantly when the dj-engine tried
to play it. The podcast scheduler reported "all episodes finished" 5
seconds after the podcast started, and listeners heard the TTS intro
followed by nothing. There was no probe checking podcast file format
against pipe expectations.

Each of these is a *silent* failure pattern — a probe set that asks
"is the service active?" returns the same green checkmark as a healthy
system. We need probes that ask sharper questions.

## Decision

Add five new probes to `kannaka-staff/src/index.js`. Each costs <1
second per 60-second tick and surfaces a specific previously-silent
failure mode.

### Probe 1 — `radio_singleton`

**Asks:** "How many `kannaka-radio` server processes are running?"

**Implementation:**
```js
function probeRadioSingleton() {
  return new Promise((resolve) => {
    exec("pgrep -af 'node.*kannaka-radio.*server/index'", { timeout: 5000 },
      (err, stdout) => {
        const lines = (stdout || "").split("\n").filter(l => l.trim() && !l.includes("pgrep"));
        if (lines.length === 0) resolve({ ok: false, message: "no radio process found" });
        else if (lines.length === 1) resolve({ ok: true, message: `1 process: ${lines[0].split(" ")[0]}` });
        else resolve({ ok: false, message: `DUPLICATE: ${lines.length} radio processes — ${lines.map(l => l.split(" ")[0]).join(", ")}` });
      });
  });
}
```

**Severity:** **CRITICAL** (causes audible listener-facing chaos when
duplicates fight icecast source slot).

**Auto-recovery action (optional):** if a duplicate is detected and one
process has shorter uptime than the other, kill the younger one (it's
the orphan). Wrap in a manual-confirm flag for the first month.

### Probe 2 — `radio_port_alive`

**Asks:** "Is the radio's HTTP server *actually* listening on its
declared port?"

**Implementation:** combine `probeSystemd("kannaka-radio.service")`
with `probeTcp("127.0.0.1", 8888)`. If systemd says active AND the
TCP probe fails, we have a process-alive-but-port-silent situation.

```js
async function probeRadioPortAlive() {
  const sysd = await probeSystemd("kannaka-radio.service");
  if (!sysd.ok) return { ok: false, message: `service not active: ${sysd.message}` };
  const tcp = await probeTcp("127.0.0.1", 8888);
  if (!tcp.ok) return { ok: false, message: "service alive but port 8888 silent — http server died inside node" };
  return { ok: true, message: "service active + port bound" };
}
```

**Severity:** **HIGH** (the SPA goes stale; not an audio outage, but
listeners see frozen state).

**Auto-recovery action:** restart the service via systemctl. The HTTP
server has died inside the node process; nothing else will heal it.

### Probe 3 — `radio_metadata_mount_alignment`

**Asks:** "Is the metadata writer pointed at the same mount the public
SPA listens to?"

**Implementation:** read the running radio process's environment
(`/proc/<pid>/environ`) for `ICECAST_MOUNT`; cross-reference with a
known constant for the public mount (`/stream`).

```js
async function probeMetadataMountAlignment() {
  // Find the radio PID
  const procs = await new Promise(r => exec("pgrep -f 'node.*kannaka-radio.*server/index'", (e, o) => r((o||"").trim().split("\n").filter(Boolean))));
  if (procs.length !== 1) return { ok: false, message: `cannot determine pid (count=${procs.length})` };
  const pid = procs[0];
  let env = "";
  try { env = require("fs").readFileSync(`/proc/${pid}/environ`, "utf8"); } catch (e) { return { ok: false, message: `cannot read /proc/${pid}/environ` }; }
  const mountMatch = env.match(/ICECAST_MOUNT=([^\0]*)/);
  const mount = mountMatch ? mountMatch[1] : "/preview"; // default per icecast-metadata.js
  if (mount !== "/stream") return { ok: false, message: `metadata writer targets ${mount} but listeners are on /stream` };
  return { ok: true, message: `aligned: ICECAST_MOUNT=${mount}` };
}
```

**Severity:** **MEDIUM** (visual, not audible — listeners hear
correctly but don't see the title).

**Auto-recovery:** none; requires fix to `run-radio.sh` env. The probe
just needs to surface the misalignment loudly.

### Probe 4 — `stream_metadata_advancing`

**Asks:** "Has the icecast `/stream` mount's title changed in the last
N minutes?"

**Implementation:** poll `http://127.0.0.1:8000/status-json.xsl` every
60 s. Track the title for the mount. If the title hasn't changed in
≥ N minutes (configurable, default 12), and the mount has listeners,
alert.

```js
let _lastStreamTitle = null;
let _lastStreamTitleAt = 0;
async function probeStreamAdvancing() {
  const r = await probeHttp("http://127.0.0.1:8000/status-json.xsl", { timeout: 5000 });
  if (!r.ok) return { ok: false, message: r.message };
  let stream;
  try {
    const d = JSON.parse(r.body).icestats;
    const sources = Array.isArray(d.source) ? d.source : (d.source ? [d.source] : []);
    stream = sources.find(s => (s.listenurl || "").endsWith("/stream"));
  } catch (e) { return { ok: false, message: `parse error: ${e.message}` }; }
  if (!stream) return { ok: false, message: "/stream mount not found" };
  const title = stream.title || "";
  const now = Date.now();
  if (title !== _lastStreamTitle) { _lastStreamTitle = title; _lastStreamTitleAt = now; }
  const stallMs = now - _lastStreamTitleAt;
  const STALL_THRESHOLD = 12 * 60 * 1000; // 12 min — most tracks are 2-6 min
  if (stallMs > STALL_THRESHOLD && (stream.listeners || 0) > 0) {
    return { ok: false, message: `title unchanged ${Math.round(stallMs/60000)}m: "${title}" (${stream.listeners} listener${stream.listeners===1?"":"s"})` };
  }
  return { ok: true, message: `current: "${title}" (${stream.listeners || 0} listeners)` };
}
```

**Severity:** **HIGH** (catches the dj-engine stalling on a single
track, the metadata writer dying mid-show, and the stream-source
disconnect-but-not-restart pattern).

**Auto-recovery:** restart kannaka-radio.service.

### Probe 5 — `podcast_files_playable`

**Asks:** "Does every podcast mp3 in the rotation have a sample-rate
and bitrate compatible with the radio's stream pipe?"

**Implementation:** runs hourly (not every tick). Walks `/home/opc/kannaka-radio/music/Ghost Signals Podcast/*.mp3`, runs `ffprobe`,
checks `sample_rate==44100` and `bit_rate<=192000`. Files outside the
acceptable envelope get logged. Auto-recovery: a separate
`scripts/normalize-podcast.sh` re-encodes any flagged file to
44.1k/128k. Watcher just surfaces the alert with the suggested
remediation.

```js
async function probePodcastFiles() {
  const dir = "/home/opc/kannaka-radio/music/Ghost Signals Podcast";
  const fs = require("fs"); const path = require("path");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".mp3") && !f.endsWith(".original.mp3")) : [];
  if (files.length === 0) return { ok: true, message: "no podcast files" };
  const bad = [];
  for (const f of files) {
    const p = path.join(dir, f);
    const r = await new Promise(res => exec(`ffprobe -v error -show_entries stream=sample_rate,bit_rate -of default=noprint_wrappers=1 ${JSON.stringify(p)}`, { timeout: 8000 }, (e, o) => res(o || "")));
    const sr = (r.match(/sample_rate=(\d+)/) || [])[1];
    const br = (r.match(/bit_rate=(\d+)/) || [])[1];
    if (sr !== "44100" || (br && parseInt(br) > 192000)) bad.push(`${f} (sr=${sr} br=${br})`);
  }
  if (bad.length > 0) return { ok: false, message: `${bad.length} podcast files outside envelope: ${bad.join("; ")}` };
  return { ok: true, message: `${files.length} podcast files OK` };
}
```

**Severity:** **MEDIUM** (a podcast slot fails to play but the rest of
the rotation continues; listener hears DJ programming).

**Auto-recovery:** call `scripts/normalize-podcast.sh <file>` (new
helper). The normalize script re-encodes to 44.1k/128k and renames
the original to `*.original.mp3`. Manual approval required for the
first month.

### Probe registration

In `runAllProbes()`, add the five new entries with appropriate
intervals. The first three run every 60s; #4 every 60s with internal
state for the stall timer; #5 hourly. All flow through the existing
alert pipeline (NATS broadcast + dashboard).

## Consequences

### Positive

- **Duplicate-process incidents become impossible to miss.** Within
  60 s of a duplicate appearing the alert fires.
- **Silent HTTP-server death is detected** in the same window.
- **The mount/metadata mismatch becomes a config-time check** instead
  of a "huh, why is the title blank" question hours into a launch.
- **Podcast playback failures are pre-emptively detected** before air
  time.
- **The Watcher's role expands toward "tell me when something is
  silently wrong."** That's the entire point of the role per ADR-001;
  these probes make it more honest about its job.

### Negative / cost

- **`/proc/<pid>/environ` is a Linux-specific path.** Probe #3 won't
  work on macOS dev environments. Acceptable since prod is Linux only.
- **Stall threshold (12 min) requires tuning.** Some intentional long
  pieces (e.g., a 35-minute Northwake play-through, podcast episodes
  that run 7 minutes) may briefly trigger. The threshold should be
  re-evaluated after a week of production data.
- **Auto-recovery is risky.** Killing a "duplicate" without certainty
  could kill the *only* radio. Start with manual-confirm flag on all
  recovery actions; promote to auto after 30 days of clean
  observation.
- **Five new probes is real surface.** Each one is a thing that can
  itself be wrong. The existing probe pattern keeps the LOC modest
  (~30 lines per probe) and the alert pipeline is shared.

### Risks

- **False positives on `radio_singleton` during deploys.** A graceful
  systemctl restart briefly has two processes. Mitigation: require
  the duplicate condition to persist for ≥ 2 ticks before alerting.
- **`stream_metadata_advancing` flap during the silent gap between
  tracks.** The current ICY metadata writer is idempotent; some
  tracks may legitimately keep the same title across short gaps.
  The 12-minute threshold absorbs this.

## Migration plan

1. **Phase 1 (1 day, autonomous).** Add the five probes to
   `src/index.js` behind a feature flag (`WATCHER_NEW_PROBES=1`).
   Run in observe-only mode for one week — no auto-recovery actions,
   alerts go to a separate dashboard panel marked "experimental."

2. **Phase 2 (1 week, monitoring).** Tune thresholds based on
   observed false-positive rate. Promote stable probes to default
   (drop the feature flag).

3. **Phase 3 (auto-recovery).** Add manual-confirm prompts for the
   destructive actions (kill duplicate, systemctl restart). Once 30
   days of clean signal, promote to auto.

4. **Phase 4 (`scripts/normalize-podcast.sh`).** Build the helper
   for Probe #5's auto-recovery path. One-line `ffmpeg -ar 44100
   -b:a 128k` wrapper; back up the original.

## Success criteria

The next duplicate-process incident is detected and named within 60s
of occurrence — not hours of confused listener feedback. Same for the
metadata mount mismatch and the silent HTTP server. The PH launch
incident specifically would have generated three alerts within the
first minute:

> 🚨 radio_singleton: DUPLICATE: 2 radio processes — 269343, 273439
> 🚨 radio_port_alive: service alive but port 8888 silent — http server died inside node
> ⚠️  radio_metadata_mount_alignment: metadata writer targets /preview but listeners are on /stream

That triple is the kind of signal that gets a human's attention before
listener trust erodes.

---

## References

- The 2026-05-05 production incident (this ADR's triggering event)
- kannaka-radio commit `1db10d5` (the metadata-mount fix)
- kannaka-staff ADR-001 (the Watcher role, scope, alert pipeline)
- icecast-metadata.js (the file that defaults to `/preview`)
- run-radio.sh.example (where the env fix landed)
