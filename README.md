# Hexmap

![Hexmap](docs/images/hexmap.jpg)

Status: active
Created: 2026-06-30
Owner: Felton
Builder: Codex (implementation), Claude (architecture/spec)

## Purpose

An API-driven, agentless network topology visualizer for homelab infrastructure. A Node backend polls existing infrastructure APIs directly — Proxmox, Kubernetes, Docker, Home Assistant, OPNsense, UGOS/NAS, Infisical, Authentik — to discover hosts, VMs, k3s pods, and storage, with live metrics from Prometheus and logs from Loki. Nothing is installed on the monitored hosts themselves; every data point comes from an API the infrastructure already exposes.

Originally a rotating 3D hex grid. Flattened to 2D — at 3D, and as the environment grew, nodes became too hard to make out and the layout stopped being usable for what this is actually for: a quick look at what's up or down.

## How it renders

Custom SVG rendering — no D3, no Cytoscape, no charting library. Each node type maps to a distinct shape so infrastructure tier reads before the label does:

| Type | Shape | Type | Shape |
|---|---|---|---|
| `proxmox-host` | hexagon | `firewall` | diamond |
| `vm` | octagon | `nas` / `baremetal` | diamond |
| `lxc` | circle | `vps` | circle |
| `k3s-service` | triangle | `app` | rounded rect |

CPU/mem/disk/network radiate as small gauge spokes off each node, colored by severity.

## Edge detection

Edges aren't hand-declared — most are inferred from live data:

- **hosts / pod_host** — physical hosting and k8s pod-to-node scheduling
- **database** — TCP port probe (5432/3306/27017/…) cross-checked against pod env-var key names, no values read
- **sso** — pulled from Authentik's provider list
- **secrets_for** — Infisical folder name matched against node IDs
- **storage / network** — NFS mount and tunnel/DNS dependencies

## Structure

```
frontend/   React + Vite app — 2D SVG rendering, node detail panels, OIDC login
api/        Express backend — agentless discovery from infra APIs, threshold evaluation (SQLite-backed), caching
```

Each backend connector (`proxmox.js`, `k8s.js`, `docker.js`, `ugos.js`, `opnsense.js`, …) owns both its node definitions and their live metrics; the topology engine just calls every connector and merges the results.

## Stack

- **Frontend:** React, Vite, Tailwind, Zustand, react-oidc-context
- **Backend:** Node.js, Express, better-sqlite3
- **Auth:** OIDC (Authentik)
- **Metrics/Logs:** Prometheus, Loki
- **Discovery sources:** Proxmox, Kubernetes, Docker, Home Assistant, OPNsense, UGOS, Infisical, Authentik — polled directly, no agents

## Notes

This is a personal homelab tool, published for portfolio purposes. It assumes a specific private infrastructure environment (Proxmox, k3s, Prometheus/Loki, an OIDC provider) and isn't set up as a general-purpose deployable product — no public demo or install docs are provided.
