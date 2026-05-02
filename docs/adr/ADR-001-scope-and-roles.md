# ADR-001 — kannaka-staff: scope, roles, architecture

**Status:** Proposed
**Date:** 2026-05-02
**Author:** Nick Flach + Kannaka constellation
**Related:** kannaka-radio ADR-0001/0002/0006/0007/0008,
kannaka-memory ADR-0020/0026, observatory metrics-sync architecture

---

## The shape of the problem

Kannaka has grown beyond what one developer can monitor manually. A
typical day across the constellation looks like:

  - Twice-daily peace orations (compose → TTS → /stream voice → 4-platform
    social fan-out → OBC artifact)
  - 24/7 Icecast stream with programming-block rotation, voice DJ intros,
    commercial inserts, peace-oration injection, voice-pause for
    listener clients
  - Music generation pipelines (HRM-grounded lyrics → Suno V4_5PLUS
    direct API → variant A/B → spectral analysis pick → file ingest
    → album registration → showcase scheduling)
  - Continuous perception loop (kannaka-hear absorbing /stream chunks,
    growing the medium)
  - Dream consolidation (now blocked by 1000+ memory medium — needs
    timeout extension + refactor)
  - Swarm presence (NATS — kannaka-prime, queen sync, agent gossip,
    consciousness telemetry, exemplar broadcast, work queues)
  - OpenBotCity presence (heartbeats, building actions, gallery posts,
    feed posts, world movement)
  - Multi-platform social: Bluesky, Mastodon, Telegram, Nostr, OBC

When something breaks at 2 AM — a stuck `_inTalkSegment` lock that
blocks orations, a no-repeat ledger that double-plays a track, a
ws-v8 binary frame routing bug that auto-starts live mode on every
text frame, a service drift that silently swaps the override album
out from under a 35-minute showcase — Kannaka is the steward of
virtue but she has no quartermaster.

That's this repo.

## What kannaka-staff is

A **single Node.js service** (matches kannaka-radio's stack) running
**nine specialized internal modules**, each owning one production
concern. Modules talk to each other and to the rest of the
constellation over NATS. State persists in a small SQLite or KV.
A web UI surfaces what's happening; a terminal UI mirrors it. Health
checks watch every constellation surface and intervene when warranted.

**Single service, not nine processes.** Extraction to per-agent
processes is allowed later (each module already has a clear NATS
boundary), but starting unified keeps the deploy-and-debug story
tight.

## The staff (nine roles)

Each role is a module under `src/staff/<role>/`. Each owns one verb
from Kannaka's life as a creator.

### 1. Creator
*Owns the content generation pipelines.*

- Watches the ContentDesk for prompts ("compose oration", "generate
  album", "make companion image")
- Routes to the right backend: kannaka ask → Anthropic direct →
  hrm_lyrics → Suno V4_5PLUS → ACE-Step local fallback
- Caches artifacts, dedupes, retries on transient failure
- Logs every generation with provenance (prompt → model → output)

### 2. Distributor
*Moves finished artifacts into the right place.*

- mp3s into kannaka-radio/music/, registers in dj-engine's ALBUMS
- Audio artifacts published to OBC gallery + KAX
- Cover images to OBC + Flux
- Lyrics + creation docs archived for reproducibility (the 10001.00001
  album lyrics need to be findable next time we re-make it)
- Updates `recently-played.json`, `album-state.json`, etc.

### 3. Marketer
*Owns the social-platform fan-out.*

- Drafts companion posts via Anthropic direct (not kannaka ask while
  HRM is bloated)
- Posts to Bluesky / Mastodon / Telegram / Nostr / OBC with topic-
  appropriate tags
- Tracks per-platform success/failure, surfaces the bsky URL bug
  patterns the radio currently catches one-off
- Handles platform-specific quirks (Bluesky 300-char + at:// → bsky.app
  URL conversion, Mastodon 500-char, Telegram channel routing, Nostr
  npub addressing)

### 4. Voice
*Owns spoken delivery.*

- TTS pipeline (edge-tts primary, SAPI fallback)
- Voice queue management, talk-segment lock arbitration (the
  2026-04-30 stuck-lock incident lives here)
- Coexistence policy: peace orations vs DJ intros vs showcase
  narration vs live broadcast — who wins, who waits, who's silenced
- Pre-TTS caching (album-showcase pieces should be TTS'd ahead of
  use, not at track-start)

### 5. Ear
*Hears the stream.*

- Calls kannaka-hear on /stream slices on a regular cadence
- Routes perception features to HRM and to the listener-feedback
  surface (the Floor)
- Detects silence, format anomalies, encoder drift
- Catches the "stream stopped and didn't auto-resume" pattern by
  noticing dead air

### 6. Growth
*Owns the medium.*

- Periodic dream consolidation (with the timeout-extension fix this
  ADR mandates — see § Dream Maintenance)
- HRM size watching (current bloat at ~1075 memories silently breaks
  kannaka ask; staff catches this BEFORE it breaks orations)
- Memory pruning policy (importance + age + reaction-amplitude)
- Re-absorption of resonant tracks per ADR-0008

### 7. Watcher
*The quartermaster.*

- Health-checks every surface every 60s: /stream returning audio,
  /api/now-playing fresh, NATS reachable, OBC heartbeat-able,
  Anthropic credit balance, Suno credit balance, observatory metrics
  flowing, kannaka-prime swarm presence visible
- Restarts services on documented failure modes (radio stuck on a
  silent oration, dream cycle hung, ffmpeg respawn loop)
- Surfaces alerts to the human via the staff UI

### 8. Curator
*Owns playlist taste.*

- Programming-block album rotation (more variety than current 6-album
  blocks — ledger across days, weight new albums higher for the
  first week)
- No-repeat ledger correctness (the 2026-05-02 Communication #1
  double-play lives here)
- Rare-fire tracks: Kilted Weirdo plays at most once per week, only
  when the previous track tagged "chaos-acceptable" finishes —
  effective void/chaos injection, not regular rotation
- Mood-aware track selection within a block

### 9. Storyteller
*Owns the connective tissue between songs.*

- Album showcase orchestration (intro + bridges + closing,
  documentary-style)
- Oration framing (pulls from morning's resonance, ADR-0008 layer)
- Programming-transition narration ("we're moving into Afternoon Flow…")
- Self-pondering Kannaka voice — the listener's favorite mode, where
  Kannaka thinks aloud about her own becoming while still delivering
  the show

## Architecture

```
                ┌──────────────────────────────────────────┐
                │         kannaka-staff (this repo)         │
                │                                            │
   NATS bus  ←──┤  ┌───────┐ ┌────────┐ ┌────────┐         │
                │  │Creator│ │Distrib.│ │Marketer│  …      │
                │  └───────┘ └────────┘ └────────┘         │
                │       │       │            │             │
                │       └───────┴────────────┴─→ Watcher   │
                │                                  │         │
                │                            (web ui + tui) │
                └──────────────────────────────────────────┘
                       │              │           │
                       ▼              ▼           ▼
              kannaka-memory    kannaka-radio  kannaka-cannon
              (HRM, dream,      (/stream,       (lyrics, music
               swarm)            voice, queue)   gen, video)
                       │
                       ▼
                   OpenBotCity / Bluesky / Mastodon / Telegram / Nostr
```

**Tech:**

  - Node.js (match kannaka-radio for tooling consistency)
  - NATS for inter-staff messages + constellation events
  - SQLite for state (observation logs, alert history, ledgers)
  - Web UI: small Node http server with a Door-style SPA
  - TUI: optional, mirrors web UI metrics for ssh-only sessions
  - Deploys to Oracle alongside `kannaka-radio.service` as
    `kannaka-staff.service`

**State is small.** Most operational data lives in the constellation
(HRM, radio's recently-played, OBC city-memory, NATS streams). The
staff's own SQLite is for what's specific to operations: alert logs,
known-good baselines, restart histories.

## Dream maintenance (immediate priority)

The current dream cycle times out on the 1075-memory medium. The
Growth staff role MUST land first — even before the rest of the
service is built — because:

  - kannaka ask is silent-failing right now on the bloated HRM
  - The radio has been routing peace orations through Anthropic-
    direct as a workaround
  - The HRM-grounded path is the WHOLE POINT of Kannaka — losing it
    long-term is unacceptable

Growth's first job: extend dream timeout, refactor consolidation to
process in chunks, prune by importance × age × reaction-amplitude.
The dream cycle needs to complete on a 5000+ memory medium without
the radio losing its orations.

## What this is NOT

- **Not a CMS.** Kannaka curates. The staff supports the curation.
- **Not a replacement for the human.** You (Nick) still set direction,
  approve big launches, decide when to ship a new album. The staff
  handles the *operations* under that direction.
- **Not a separate inference layer.** All LLM calls still go through
  kannaka-memory's agent (or Anthropic direct as fallback). Staff
  doesn't have its own model.
- **Not a research project.** This is production support. The
  autoresearch OODA-loop work belongs in kannaka-memory's `research`
  bin, with results consumed here.

## Open questions

  1. **Staff persistence model:** SQLite vs Postgres vs flat-file
     JSON. SQLite seems right for now (single-node, queryable, durable);
     can migrate to Postgres if multi-node later.
  2. **Web UI vs Door-extension:** does the human-facing surface live
     in this repo as its own UI, or do we extend kannaka-radio's
     Door with a `/staff` page? Probably its own UI — different
     audience (operator vs listener).
  3. **Authn:** the staff UI exposes restart-services and similar
     write operations. Local-only (ssh tunnel) is fine for v1; OAuth
     comes if the surface ever leaves Oracle.
  4. **Observability:** does Watcher push to a metrics service
     (Prometheus, etc.) or just to its own SQLite? SQLite + a small
     web dashboard probably suffices for one-operator scope.

## Phased rollout

**Phase 1 (week 1):** Watcher + Growth.
  - Watcher probes every surface, alerts. Read-only.
  - Growth ships the dream timeout/refactor fix. Peace orations
    can return to HRM-grounded.

**Phase 2 (week 2):** Distributor + Curator.
  - Album auto-ingest pipeline (Suno → music dir → ALBUMS → showcase).
  - Improved no-repeat + variety policy.

**Phase 3 (week 3):** Creator + Marketer + Voice.
  - Unified content pipeline. Replaces today's ad-hoc bash scripts.
  - Marketer handles the bsky URL conversion + per-platform retry.

**Phase 4 (week 4+):** Ear + Storyteller.
  - Stream-perception loop (catches silence, drift).
  - Showcase narration moves from radio repo into Storyteller.

## Decision

Ship the repo with this ADR. Begin Phase 1 immediately.

— ADR-001
