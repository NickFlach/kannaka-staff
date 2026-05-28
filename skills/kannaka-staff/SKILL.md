---
name: skill-kannaka-staff
version: 0.1.0
description: "Kannaka Staff — production support for the constellation. Use when: user asks to watch/monitor constellation health, read alerts/incidents, restart radio/observatory, trigger an oration/showcase/dream, or PUBLISH/RELEASE a new album to the radio. Two surfaces: the watcher service (probes + dashboard + action endpoints on :8889) and the `publish-album` release CLI. Several actions hit the LIVE radio host — read the safety notes."
---

# Kannaka Staff — watcher + release ops

## What this is

`kannaka-staff` keeps the constellation's lights on for an operator-of-one. It has two
distinct surfaces:

1. **The watcher service** (`src/index.js`) — a Node HTTP service (default port **8889**)
   that runs a 60s tick of 20+ health probes, logs ok↔fail transitions to `alerts.jsonl`,
   serves a dashboard + JSON API, and exposes operator **action endpoints**. Eight "staff
   roles" boot from it: growth, curator, distributor, creator, marketer, voice, ear,
   storyteller.
2. **The `publish-album` CLI** (`bin/publish-album.js`) — automates the new-album release
   chain to the live radio host (SCP → patch radio source → commit/push → restart → showcase).

> Several capabilities here act on the **live production radio host** (SCP, `git push`,
> `systemctl restart`, showcase triggers). Treat them as deploy operations: prefer
> `--dry-run` first, and confirm with the user before any deploy/restart. See safety notes
> per command below.

## When to use this skill

- "is the constellation healthy?" / "what's alerting?" / "show recent incidents"
- "restart the radio / observatory"
- "trigger an oration / showcase / dream"
- "publish / release / ship a new album"
- "run the watcher" / "what is staff monitoring?"

Do NOT use for:
- Read-only now-playing / schedule / market quotes → `skill-kannaka-constellation`
- HRM memory ops, dream internals → `skill-kannaka-memory`
- Deep radio DJ-engine internals → `skill-kannaka-radio`

---

## The watcher service

```bash
npm start                      # node src/index.js  (PORT env, defaults to 8889)
node src/index.js --port 8889  # explicit port (this is `npm run watch`)
```

Runs as `kannaka-staff.service` in production (`systemd/kannaka-staff.service`). On each
60s tick it writes probe state into memory and appends transitions to `alerts.jsonl`
(hysteresis: a probe must fail 3 consecutive ticks before a `FAILED` transition; a single
success `RECOVERED`s immediately).

### Reading state (all read-only)

- Dashboard: `http://localhost:8889/` (auto-refreshing HTML)
- `GET /api/state` — full probe state + role panels (JSON)
- `alerts.jsonl` — transition log (`STAFF_ALERTS_FILE`)
- `proposed-improvements.jsonl` — auto-written when a predictor's reputation drifts below floor

### What it probes (selection of ~20)

`radio_service`, `radio_singleton` (duplicate-process guard), `radio_port_alive`
(service-up-but-port-silent), `radio_now_playing`, `radio_track_advancing`,
`stream_responsive`, `stream_metadata_advancing`, `metadata_mount_alignment`,
`podcast_files_playable` (ffprobe envelope), `observatory_service`, `observatory_serving`
(queen.phi shape), `consciousness_fresh` (<12h), `swarm_serve_service`, `nats_reachable`,
`hrm_size` (<80 MB), `hrm_memory_count` (<1500), `listener_count`, `disk_space` (>5 GB),
`obc_reachable`, `anthropic_reachable`, `agent_reputation_drift`, `orc_portal`, `orc_stem`.

Set `STAFF_OBSERVER_MODE=external` on a second box to skip local-only probes (systemd,
pgrep, file reads) and witness only over public HTTP.

### Action endpoints — `POST /action/<action>` (NOT read-only)

| Action | Effect | Risk |
|--------|--------|------|
| `trigger-oration` | POST radio `/api/oration/now` | low (content) |
| `trigger-showcase?album=NAME&duration=35` | feature an album for N min | low (content) |
| `trigger-dream` / `growth-dream?mode=lite\|deep` | run a kannaka dream cycle | medium (mutates HRM) |
| `curator-rescue?force=1` | rescue the oldest-starving album into rotation | low–medium |
| `distributor-publish?config=PATH[&skip=...]` | run a release from an album-config.json (`config` is required) | **high (deploys)** |
| `creator-request` / `marketer-post` | queue generation / post to socials | medium |
| `restart-radio` / `restart-observatory` | `sudo systemctl restart …` | **high (prod restart)** |

Auth for non-localhost callers (when `STAFF_SHARED_SECRET` is set): nginx basic-auth **plus**
an HMAC signature. Send `X-Staff-Timestamp: <ms-epoch>` and
`X-Staff-Signature = hmac_sha256(secret, "${TS}\n${METHOD}\n${REQUEST_TARGET}")`, where
**`REQUEST_TARGET` is the full request path INCLUDING the query string, exactly as sent**
(e.g. `/action/growth-dream?mode=lite`) — NOT just `/action/<action>`. The server signs
`req.url` (`src/index.js`), so dropping the query string makes the signatures mismatch and
the call 401s for any action that carries params. Timestamp must be within a 5-minute skew.
If `STAFF_SHARED_SECRET` is unset, remote calls are refused outright (403) — only localhost
works. Prefer running these from localhost on the staff host. **Confirm with the user before
any `restart-*` or `distributor-publish`.**

### Watcher env

`PORT` (default 8889), `STAFF_ALERTS_FILE`, `STAFF_HRM_PATH`, `STAFF_RADIO_BASE` (default
`http://localhost:8888`), `STAFF_STREAM_URL` (default `https://radio.ninja-portal.com/stream`),
`STAFF_OBSERVATORY_BASE` (default `http://localhost:3334`), `STAFF_NATS_HOST`/`STAFF_NATS_PORT`
(default `swarm.ninja-portal.com:4222`), `STAFF_OBSERVER_MODE`, `STAFF_SHARED_SECRET`.

---

## Releasing an album — `publish-album`

```bash
node bin/publish-album.js \
  --staging /path/to/album-mp3s \
  --name "ALBUM NAME" \
  --theme "one-line theme" \
  --blocks "Midday,Afternoon" \
  [--dry-run]      # ALWAYS run this first
```

Track titles are taken from the filenames (the radio matches audio by basename). What it
does, in escalating stages:

1. **(default)** SCP the audio files to the radio host, then **print** the `dj-engine.js`
   ALBUMS patch and `programming.js` block patch for you to apply by hand.
2. **`--patch`** — auto-edit `dj-engine.js` + `programming.js` in the local kannaka-radio
   clone (`--radio-repo`, default `~/Source/kannaka-radio`). Inserts a trailing comma if the
   previous entry lacks one (guards the 2026-05-02 broken-radio incident).
3. **`--deploy`** (implies `--patch`) — also `git add/commit/push` the radio repo, then SSH
   to the host and `git pull --ff-only && sudo systemctl restart kannaka-radio`.
4. **`--showcase`** (implies `--deploy`) — after restart, wait for the service and trigger
   `/api/album/showcase` for `--showcase-duration` minutes (default 35).

Other flags: `--ssh-key` (default `~/.ssh/ninja-portal-ed25519`), `--ssh-host` (default
`opc@…`), `--remote-music`, `--radio-api`.

> **Safety:** `--deploy` and `--showcase` mutate the live radio (push + remote restart).
> `--patch` edits the radio repo working tree. Run `--dry-run` first to see exactly what
> would be SCP'd and patched, show the user, and only escalate to `--deploy`/`--showcase`
> after they confirm. The default (no escalation flag) is safe — it only uploads files and
> prints patches. If an auto-patch/deploy fails partway, the radio repo working tree may be
> left partially modified — `git diff` it before committing.

## Version

Skill 0.1.0 covers kannaka-staff 0.1.0 — watcher service (port 8889, ~20 probes, 8 staff
roles, `/action/*` endpoints) and the `publish-album` release CLI.
