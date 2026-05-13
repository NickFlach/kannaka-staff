# ADR-002 — closed loops via in-process event bus

**Status:** Accepted
**Date:** 2026-05-13
**Supersedes:** none
**Refines:** ADR-001 (scope and roles)

## The shape of the next problem

ADR-001 stood up the staff crew as nine cooperating modules in one
Node process. Each role currently does its tick in isolation — Ear
detects silence, Voice notices a stuck lock, Watcher knows how to
restart the radio — but no role *acts on* what another role
observes. The operator is still the integration layer.

The next lift is closing those loops. The smallest example: when
Ear has confirmed 4+ minutes of dead air on `/stream` AND there has
been no auto-restart in the last 30 minutes, Watcher should run
`restart-radio` without waiting for a human to read the alert.

## The decision

**Roles communicate via a shared in-process EventEmitter — call it
`staffBus` — passed into every `bootX(deps)` boot call.**

Subjects use the same dotted namespace ADR-001 anticipated for NATS
(`KANNAKA.staff.<verb>.<resource>`), so the wiring transposes
cleanly if and when we extract roles to separate processes.

NATS stays the cross-host bus (radio ↔ memory ↔ observatory ↔
swarm). Within the staff process, NATS adds latency, an extra
moving part, and a serialization round-trip we don't need.

## Event contract

Every event has the same shape:

```js
{
  ts: number,           // ms since epoch
  source: string,       // role that emitted, e.g. "ear"
  subject: string,      // dotted name; matches the NATS-style namespace
  payload: object,      // role-specific, JSON-serializable
}
```

Publishers call `staffBus.emit(subject, event)`. Subscribers register
once at boot via `staffBus.on(subject, handler)`. There is no
back-pressure, no retry, no persistence — emitters are
authoritative-but-fire-and-forget. If a handler needs durable
recovery state it keeps its own ledger on disk (same pattern as
Growth's dream history, Curator's classification map).

## Subject inventory (initial)

The crew gets to extend these freely. Subjects already implied by
existing alerts:

  - `KANNAKA.staff.stream.silent`        — Ear confirmed dead air
  - `KANNAKA.staff.stream.recovered`     — Ear sees audio again
  - `KANNAKA.staff.voice.lock.stuck`     — Voice held lock past threshold
  - `KANNAKA.staff.voice.lock.recovered` — Voice lock cleared
  - `KANNAKA.staff.album.starving`       — Curator: album crossed 48h
  - `KANNAKA.staff.album.never_played`   — Curator: registered but absent
  - `KANNAKA.staff.album.refreshed`      — Curator: back in rotation
  - `KANNAKA.staff.hrm.bloated`          — Growth: HRM ≥ HARD threshold
  - `KANNAKA.staff.hrm.recovered`        — Growth: HRM back under SOFT
  - `KANNAKA.staff.dream.start|done|failed`
  - `KANNAKA.staff.distributor.job.start|done|failed`
  - `KANNAKA.staff.creator.job.start|done|failed`
  - `KANNAKA.staff.marketer.post.done|failed`
  - `KANNAKA.staff.action.auto_recover.restart` — Watcher: auto-restart fired

Roles publish whenever they would have written the corresponding
alerts.jsonl transition; the alert is still written (the operator
still reads it on the dashboard), and the event lets sibling roles
react in real time.

## Closed-loop authorization

Auto-actions on the radio (restart, override, etc.) are
operator-trust decisions. The staff process won't fire a
write-action without a cooldown and a documented predicate.

The first authorized loop:

| Trigger                                                              | Action                          | Predicate                                                                                          |
| -------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `stream.silent` (Ear) — has been silent for ≥ EAR_CONFIRM_TICKS      | `restart-radio` via Watcher     | no auto-restart in the last `AUTO_RECOVER_COOLDOWN_MS` (default 30 min); record to alerts.jsonl    |

Future loops follow the same shape: a single role acts on its
authority, never on inferred consensus, and the action is rate-
limited + logged. We do not chain loops without explicit ADRs —
the staff is not a rules engine and we are not building one.

## What this is not

- **Not a replacement for the operator.** The dashboard still
  reads alerts; auto-actions are belt-and-suspenders for the small
  set of failure modes we already understand. New auto-actions
  require a new ADR.
- **Not a distributed system inside one process.** No
  serialization, no schema registry, no retries. Roles share memory;
  the bus is a notification mechanism, not a message queue.
- **Not the NATS interface.** When a role needs to reach the radio
  or memory, it still calls their HTTP/NATS surfaces directly.
  The bus is for staff-internal coordination only.

## What changes in code

- `src/index.js` boots a single `EventEmitter` as `staffBus` and
  passes it to every `bootX({ staffBus, ... })` call.
- Each role gets two new optional behaviours: publish on its own
  alerts (no behaviour change for the operator stream), subscribe
  to whatever the role wants to react to.
- A new section in `index.js` registers closed-loop handlers —
  the wiring lives in one place so the predicates are auditable.
- Alerts in `alerts.jsonl` gain a new transition for auto-actions
  (`AUTO_RECOVER_RESTART`) so post-incident review can tell whether
  a restart was operator-initiated or staff-initiated.

## Open questions

  1. **Replay / observability of bus events.** Today's bus has no
     event log. If we want to debug "why did Watcher restart at
     03:11", we have alerts.jsonl + journal logs. Probably enough.
     A ring buffer of recent events on the dashboard is cheap and
     might come along with the first loop.
  2. **Action governance as roles grow.** With one auto-action this
     is fine; with ten we need a per-action enable flag + audit
     trail. Defer until we have three or more.

— ADR-002
