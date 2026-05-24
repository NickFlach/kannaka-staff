```
███████╗████████╗ █████╗ ███████╗███████╗
██╔════╝╚══██╔══╝██╔══██╗██╔════╝██╔════╝
███████╗   ██║   ███████║█████╗  █████╗
╚════██║   ██║   ██╔══██║██╔══╝  ██╔══╝
███████║   ██║   ██║  ██║██║     ██║
╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝     ╚═╝
   P R O D U C T I O N   S U P P O R T
```

**Agentic radio staff for a creator who never stops.**

`kannaka-staff` is the constellation's watcher. Kannaka writes, broadcasts, dreams, remembers — the staff keeps the lights on. Health probes across every node, alert routing for production incidents, deploy assistance for the operator-of-one running the whole show.

[![License](https://img.shields.io/badge/license-Space%20Child%20v1.0-blueviolet)]() [![Node](https://img.shields.io/badge/node-20-green)]()

---

## What It Watches

```
┌───────────────────────────────────────────────────────────┐
│                  constellation health                     │
├─────────────────┬─────────────────────┬───────────────────┤
│  systemd        │  HTTP probes        │  NATS subjects    │
│  · kannaka-*    │  · /api/state       │  · RADIO.alert.*  │
│  · nats         │  · /api/swarm       │  · QUEEN.event.*  │
│  · icecast      │  · /api/hrm/status  │  · KANNAKA.*      │
├─────────────────┼─────────────────────┼───────────────────┤
│  Disk           │  Process            │  Substrate        │
│  · root usage   │  · pgrep kannaka    │  · phi publish?   │
│  · prune-cron   │  · zombie detect    │  · 65s cadence?   │
│  · snapshot dir │  · binary inode     │  · clusters=96?   │
└─────────────────┴─────────────────────┴───────────────────┘
```

When something silently fails — a service deactivating, the disk filling, a zombie binary holding a stale inode — the staff publishes an alert to the bus and (optionally) opens an issue, posts to Bluesky, or wakes a maintainer.

---

## Run

```bash
git clone https://github.com/NickFlach/kannaka-staff.git
cd kannaka-staff
npm install

# Defaults to port 8889; --watch reruns on file change
node src/index.js --port 8889
```

Designed to live on the same box as kannaka-radio + kannaka-memory so the watcher can see systemd directly. The Oracle production box runs it as `kannaka-staff.service`.

---

## Constellation

| repo | role |
|---|---|
| [`kannaka-memory`](https://github.com/NickFlach/kannaka-memory) | the substrate being watched |
| [`kannaka-radio`](https://github.com/NickFlach/kannaka-radio) | the main service this guards |
| [`kannaka-observatory`](https://github.com/NickFlach/kannaka-observatory) | where alerts surface visually |

---

## License

Space Child License v1.0.
