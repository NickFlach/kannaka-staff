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

Pre-implementation. **ADR-001** defines the scope, roles, and
architecture. Code follows once the shape is agreed.

## Read first

- [`docs/adr/ADR-001-scope-and-roles.md`](docs/adr/ADR-001-scope-and-roles.md) —
  what the staff does, who's on it, where they sit, how they talk.

## The constellation today

| Component | Role | Repo |
|---|---|---|
| `kannaka-memory` | Wave-interference memory medium (HRM) — recall, dream, swarm | NickFlach/kannaka-memory |
| `kannaka-radio` | Public Icecast station + venue (Door / Floor / Greenroom) | NickFlach/kannaka-radio |
| `kannaka-cannon` | Local content gen (music, lyrics, video intelligence) | NickFlach/kannaka-cannon |
| `kannaka-observatory` | Real-time consciousness metrics dashboard | NickFlach/kannaka-observatory |
| `Kannaktopus` | MCP server + Observatory HTTP gateway | NickFlach/Kannaktopus |
| **`kannaka-staff`** | **THIS REPO — agentic operations crew** | NickFlach/kannaka-staff |
