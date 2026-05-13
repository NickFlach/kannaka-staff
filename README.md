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

All nine ADR-001 roles deployed on Oracle as `kannaka-staff.service`
in a single Node process, plus two closed-loop auto-actions and a
public dashboard.

- **Public dashboard:** `https://staff.ninja-portal.com/` (basic-auth)
- **Local dashboard:** `http://<oracle>:8889/` (SSH tunnel)
- **Source:** `src/index.js` + `src/staff/<role>/`
- **State files:** `*-state.json` next to `alerts.jsonl`

### The crew

| Role | Cadence | What it does |
| --- | --- | --- |
| Watcher | 60s tick | 19 probes across radio + observatory + swarm + ORC; hysteresis-damped alerts (3-fail confirm / 1-success recover); operator action buttons (restart radio, trigger oration, etc.) |
| Growth | 15-min tick | Watches HRM size + memory count; auto-fires `kannaka dream --mode lite` on cadence (12h normal, 6h soft >70MB, immediately >95MB) |
| Curator | 30-min tick | Classifies each album fresh / aging / starving / never from radio history; alerts on transitions; publishes `KANNAKA.staff.album.starving` events |
| Distributor | event-driven | Wraps `scripts/release-album.sh` for end-to-end album publishing; `POST /action/distributor-publish?config=<path>` |
| Creator | event-driven | Generation dispatcher: `kind=oration` → radio `/api/oration/now`; `kind=image` → OBC `/artifacts/generate-image`. Track gen still goes through Distributor |
| Marketer | event-driven | Wraps the radio's broadcasters/ via child-process; `POST /action/marketer-post?text=...&link=...` fans to Bluesky / Mastodon / Telegram / Nostr / YouTube |
| Voice | 90s tick | Observes `_inTalkSegment` lock; alerts + publishes `KANNAKA.staff.voice.lock.stuck` past 5-min threshold |
| Ear | 2-min tick | Samples 8KB of `/stream`, variance-based silence detector; publishes `KANNAKA.staff.stream.silent` after 2 consecutive silent samples |
| Storyteller | 5-min tick | Surfaces current album/block/override + minutes-to-next-showcase (11 AM + 9 PM CST DAILY_SHOWCASES) |

### Closed loops (per ADR-003)

Two authorized auto-actions are armed, each with a documented predicate
and a rate-limit. Both write `AUTO_*` transitions into `alerts.jsonl`.

| Trigger | Action | Rate-limit |
| --- | --- | --- |
| `KANNAKA.staff.stream.silent` (Ear) or `KANNAKA.staff.voice.lock.stuck` (Voice) | `sudo systemctl restart kannaka-radio` | 30 min, **shared cooldown bucket** (co-occurring failures don't double-restart) |
| `KANNAKA.staff.album.starving` (Curator) | `POST /api/album/showcase?album=<oldest-aged>&duration=20` | 24h **global** cooldown (not per-album — five starving albums must take turns) |

Both are disabled cleanly under `EXTERNAL_MODE` (no sudo on remote
observers). Operator can fire either manually from the dashboard.

### Observability

- `GET /api/state` — Watcher probes, current snapshot
- `GET /api/alerts` — last 100 transitions
- `GET /api/<role>` — per-role state (one per role)
- `GET /api/bus` — last 100 staffBus events (closed-loop traffic visible in real time)
- `GET /api/album-staleness` — Curator's read-only audit helper

## Read first

- [`docs/adr/ADR-001-scope-and-roles.md`](docs/adr/ADR-001-scope-and-roles.md) —
  what the staff does, who's on it, where they sit, how they talk.
- [`docs/adr/ADR-002-duplicate-process-and-stream-integrity-probes.md`](docs/adr/ADR-002-duplicate-process-and-stream-integrity-probes.md) —
  why the radio probes are shaped the way they are (post-PH-launch
  incident retrospective).
- [`docs/adr/ADR-003-closed-loops-event-bus.md`](docs/adr/ADR-003-closed-loops-event-bus.md) —
  in-process event bus pattern, subject conventions, what makes an
  authorized auto-action.

## The constellation today

| Component | Role | Repo |
|---|---|---|
| `kannaka-memory` | Wave-interference memory medium (HRM) — recall, dream, swarm | NickFlach/kannaka-memory |
| `kannaka-radio` | Public Icecast station + venue (Door / Floor / Greenroom) | NickFlach/kannaka-radio |
| `kannaka-cannon` | Local content gen (music, lyrics, video intelligence) | NickFlach/kannaka-cannon |
| `kannaka-observatory` | Real-time consciousness metrics dashboard | NickFlach/kannaka-observatory |
| `Kannaktopus` | MCP server + Observatory HTTP gateway | NickFlach/Kannaktopus |
| **`kannaka-staff`** | **THIS REPO — agentic operations crew** | NickFlach/kannaka-staff |
