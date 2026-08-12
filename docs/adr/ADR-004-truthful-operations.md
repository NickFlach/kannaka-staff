# ADR-004 — Truthful operations: the staff as a trustworthy witness

**Status:** Proposed
**Date:** 2026-08-12
**Author:** Nick Flach + Kannaka constellation
**Refines:** ADR-001 (scope), ADR-002 (probe honesty), ADR-003 (closed loops)
**Adopts:** issues #41, #50, #67

---

## Where the journey stands

ADR-001 planned four phases; all four shipped. Nine roles run in one
process. ADR-002's five silent-failure probes are live and have been
through a hardening cycle. ADR-003's `staffBus` carries real traffic and
**two** closed loops act on it (stream-silent/stuck-lock → restart-radio;
album-starving → rescue). The August hardening campaign (issues #59–#88)
fixed a long tail of false alarms, swallowed alerts, config drift, and
dishonest inputs.

What survived that campaign is not a list of bugs. It is one bug with
three faces:

- **#41** — four of eight roles never publish their documented bus
  events. The fabric ADR-003 promised is silently incomplete; `/api/bus`
  shows a partial world and future loops can't subscribe to what is
  never emitted.
- **#50** — `obc_reachable` probes GET where the contract is POST, and
  counts an auth gate as alive. The probe is green while the thing it
  claims to measure is broken.
- **#67** — `creator-request` returns `ok:true` for jobs it already
  knows cannot run. The action surface reports acceptance as success.

The staff exists to catch the constellation lying about its health
("`systemctl is-active` lied" — ADR-002). The remaining work is turning
that same standard on the staff itself. **A watcher whose own reports
can't be trusted is a second thing to monitor, not a monitor.**

Two principles, borrowed from the constellation's own recent field-notes,
govern this ADR:

1. *A tool that can only succeed cannot tell you anything.* Every
   surface the staff exposes must be able to say "no" — and must say it
   at the moment the "no" is knowable.
2. *Rows over recollections.* Claims about what the staff did must be
   backed by a queryable record with actor provenance, not inferred from
   adjacent green checkmarks.

## Decision

Five workstreams. Each is small, testable, and independently shippable.

### W1 — Honest action results (`accepted` ≠ `ok`) — closes #67, generalizes it

Every `/action/*` endpoint adopts one result contract:

- If the synchronous preflight fails (missing credential, impossible
  input, disabled action), return `{ ok: false, error }` **immediately**,
  with an appropriate HTTP status. Nothing is queued.
- If work is queued for async execution, return
  `{ accepted: true, jobId }` — **never** `ok: true`. `ok` is reserved
  for "the requested work completed."
- Async completion is reported where it already lives (role history,
  alerts.jsonl) **and** on the bus (`…job.done|failed` — see W2), so a
  caller holding a `jobId` has a truthful place to look.

`requestCreate()` specifically must run `dispatch()`'s synchronous
preflights (JWT presence, input validation) *before* queueing, and
return their failure as its own.

### W2 — Complete the event fabric — closes #41

Growth, Distributor, Creator, and Marketer publish the lifecycle
subjects ADR-003 already documents (`dream.start|done|failed`,
`distributor.job.*`, `creator.job.*`, `marketer.post.done|failed`),
emitted at the same points the corresponding alerts.jsonl transitions
are written, with the standard event envelope.

**Enforced by a bus-contract test:** a hermetic test that boots each
role with fake deps, drives one lifecycle transition, and asserts the
documented subject is emitted with a well-formed envelope. The ADR-003
subject inventory becomes executable — a documented-but-unpublished
subject is a red build, not a stale doc.

### W3 — Probes measure the contract, not adjacency — closes #50

Probe honesty rules, applied to the existing set and binding on new
probes:

1. A probe names the contract it verifies (method + path + expected
   semantics), and exercises **that** contract.
2. Auth gates are only "alive" when the probe's contract is "the gate
   answers" — never as a stand-in for the resource behind it. If the
   canonical check requires credentials the staff holds, use them; if it
   requires credentials the staff must not hold, probe the closest
   unauthenticated point and **say so in the probe's message**.
3. A probe that cannot currently distinguish healthy from broken
   (endpoint gone, contract drifted) reports `ok: false` with the drift
   — it does not degrade into a weaker check silently.

`obc_reachable` is the first application: probe the documented
heartbeat contract (authenticated POST when a JWT is available), and
report contract drift (the current GET-401/POST-404 split) as a fail
with evidence, not a green.

### W4 — Action governance + audit provenance — pays ADR-003's deferred debt

ADR-003 deferred per-action governance "until we have three or more"
auto-actions. Between the two closed loops and the signed dashboard
action surface, we are there.

- **Per-action enable flags:** every write-action (auto- or
  operator-triggered) checks `STAFF_ACTION_<NAME>` (default on;
  `=0` disables). A disabled action returns `ok:false, error:"disabled"`
  — visible, not skipped silently.
- **Actor provenance in the audit trail:** every alerts.jsonl entry for
  a write-action records `actor`: `operator` (signed dashboard/HTTP
  request — identify by key id), `staff` (closed loop — identify by
  loop name), or `external` (bus/NATS-triggered). Post-incident review
  must never have to guess who restarted the radio at 03:11.
- **The governance table lives in this ADR** and is the authoritative
  registry of write-actions:

| action | trigger(s) | flag | cooldown |
|---|---|---|---|
| restart-radio | stream.silent, voice.lock.stuck, operator | `STAFF_ACTION_RESTART_RADIO` | shared 30 m (loop path) |
| restart-observatory | operator | `STAFF_ACTION_RESTART_OBSERVATORY` | none |
| trigger-oration | operator | `STAFF_ACTION_TRIGGER_ORATION` | none |
| trigger-showcase | operator | `STAFF_ACTION_TRIGGER_SHOWCASE` | none |
| trigger-dream | operator (legacy alias) | `STAFF_ACTION_TRIGGER_DREAM` | Growth in-flight guard |
| growth-dream | operator | `STAFF_ACTION_GROWTH_DREAM` | Growth in-flight guard |
| distributor-publish | operator | `STAFF_ACTION_DISTRIBUTOR_PUBLISH` | one job in flight |
| creator-request | operator | `STAFF_ACTION_CREATOR_REQUEST` | one job in flight |
| marketer-post | operator | `STAFF_ACTION_MARKETER_POST` | none |
| curator-rescue | album.starving (as album-rescue loop), operator | `STAFF_ACTION_CURATOR_RESCUE` | 24 h global |

New write-actions add a row here, a row in `ACTION_REGISTRY`
(`src/index.js`), and a `case` in `handleAction`, all in the same PR —
`tests/action-governance.test.js` fails the build if the three drift.

### W5 — The staff witnesses itself

The staff has no probe on the staff. Two cheap additions:

- **NATS heartbeat:** publish `KANNAKA.staff.heartbeat` every tick
  (ts, probe-set hash, uptime, last-tick duration) so the observatory
  and swarm can detect a dead or wedged staff from outside the process.
- **`/api/health` tick freshness:** expose per-subsystem last-tick
  timestamps (probes, loops, each role's cadence). A stale tick is
  visible to one curl — the "process-alive-but-loop-wedged" pattern
  gets the same treatment ADR-002 gave "process-alive-but-port-silent."

### Repo engineering (housekeeping, ships with W1)

Bring the repo to the constellation's standard (kannaka-memory as the
reference):

- **Branch ruleset** mirroring kannaka-memory's: block deletions and
  non-fast-forward pushes, require PRs (0 approvals, code-owner review)
  on the default branch.
- **CI** keeps the `node --check` + hermetic `node:test` gates and adds
  the W2 bus-contract test to the default suite. CI must stay hermetic
  — no network, no systemd.

## What this is not

- **Not new roles, loops, or probes-for-new-surfaces.** This ADR spends
  entirely on making existing surfaces truthful. New auto-actions still
  require their own ADR (ADR-003's rule stands).
- **Not a metrics platform.** W5 is a heartbeat and timestamps, not
  Prometheus. One-operator scope holds (ADR-001 OQ4).
- **Not a rewrite of the action surface.** W1 is a contract change on
  return values and preflight ordering; handlers stay where they are.

## Sequencing

1. **W1 + repo engineering** — the action-result contract is the
   smallest change with the highest operator-trust payoff; ruleset +
   CI land alongside.
2. **W2** — publishers + the contract test (makes ADR-003 executable).
3. **W3** — probe honesty pass, `obc_reachable` first.
4. **W4** — flags + provenance (touches every write path; goes after
   W1 so it layers on the new contract).
5. **W5** — self-witness (independent; can land any time after W2
   since the heartbeat rides the same envelope discipline).

## Success criteria

- No `/action/*` endpoint can return `ok:true` for work that has
  already failed or cannot start. (Regression-tested.)
- Every subject in ADR-003's inventory has a publisher, proven by a
  test that fails when one goes missing.
- `obc_reachable` red/green agrees with a manual check of the
  documented heartbeat contract.
- Every write-action in alerts.jsonl carries an actor; the governance
  table and the code agree on the action list.
- Killing the staff's probe loop (but not the process) is detectable
  from outside within two ticks.

— ADR-004
