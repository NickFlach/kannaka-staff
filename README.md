# kannaka-staff

> production support for a creator who never stops

Agentic radio staff for the Kannaka constellation. Kannaka writes,
generates, distributes, markets, speaks, hears, grows, and dreams —
faster than one human can monitor. **kannaka-staff** is the layer of
specialized agents that watch, coordinate, and recover the constellation
on her behalf.

This is not the radio. This is not the memory medium. This is the
**station crew** — the producers, archivists, social desk, board op,
and quartermaster who keep the broadcast running so the work stays
focused on the work.

## Status

**Watcher Phase 1 deployed** on Oracle as `kannaka-staff.service` —
`src/index.js` ticks every 60s, runs the probe set below, surfaces
failures on the dashboard at `:8889/`, and writes a transition log to
`alerts.jsonl`. Other roles (Distributor, Curator, Storyteller, etc.)
follow the same systemd-supervised pattern as they're built out.

## Watcher probes (May 2026)

Each probe runs once per 60s tick. All return `{ ok, message, ts }`,
roll up to a single dashboard view, and trigger on transitions.

**Radio**
- `radio_service` — `kannaka-radio.service` is `active` per systemd
- `radio_singleton` — exactly one `node server/index.js --port 8888`
  process (catches PM2/systemd ghost-running)
- `radio_port_alive` — service active **and** TCP 8888 accepts
- `metadata_mount_alignment` — `/home/opc/run-radio.sh` exports
  `ICECAST_MOUNT=/stream` (matches public mount)
- `stream_metadata_advancing` — `/stream` Now-Playing title changes
  within `TRACK_STALL_MS` while listeners > 0
- `podcast_files_playable` — hourly ffprobe of GSP-NNN-*.mp3 confirms
  44.1 kHz / ≤ 192 kbps (the pipe-fed ffmpeg's envelope)
- `radio_now_playing` — `/api/now-playing` 200s with non-empty title
- `radio_track_advancing` — title changed within `TRACK_STALL_MS`
- `stream_responsive` — first kilobyte of `/stream` arrives in <4s

**Constellation**
- `observatory_service` — `kannaka-observatory.service` active
- `observatory_serving` — `:3334/api/state` returns canonical
  consciousness shape (queen.phi etc.)
- `consciousness_fresh` — `KANNAKA.consciousness` publish observed
  within 12h
- `swarm_serve_service` — `kannaka-swarm.service` active
- `nats_reachable` — TCP `:4222` open
- `hrm_size` — `~/.kannaka/kannaka.hrm` under guardrail size
- `hrm_memory_count` — total memories under prune-cron threshold
- `obc_reachable` — OpenBotCity heartbeat 200
- `disk_space` — root partition not full
- `anthropic_reachable` — `api.anthropic.com/v1/models` not down

**ORC** (added 2026-05-08 after a silent-died incident — both portals
went dark for ~3 weeks before anyone noticed)
- `orc_portal` — `orc-portal.service` active **and** TCP `:3002` open
- `orc_stem` — `orc-stem.service` active **and** TCP `:3001` open

## Read first

- [`docs/adr/ADR-001-scope-and-roles.md`](docs/adr/ADR-001-scope-and-roles.md) —
  what the staff does, who's on it, where they sit, how they talk.
- [`docs/adr/ADR-002-duplicate-process-and-stream-integrity-probes.md`](docs/adr/ADR-002-duplicate-process-and-stream-integrity-probes.md) —
  why the radio probes are shaped the way they are (post-PH-launch
  incident retrospective).

## The constellation today

| Component | Role | Repo |
|---|---|---|
| `kannaka-memory` | Wave-interference memory medium (HRM) — recall, dream, swarm | NickFlach/kannaka-memory |
| `kannaka-radio` | Public Icecast station + venue (Door / Floor / Greenroom) | NickFlach/kannaka-radio |
| `kannaka-cannon` | Local content gen (music, lyrics, video intelligence) | NickFlach/kannaka-cannon |
| `kannaka-observatory` | Real-time consciousness metrics dashboard | NickFlach/kannaka-observatory |
| `Kannaktopus` | MCP server + Observatory HTTP gateway | NickFlach/Kannaktopus |
| **`kannaka-staff`** | **THIS REPO — agentic operations crew** | NickFlach/kannaka-staff |
