# Overwatch
[!Overwatch](docs/images/Overwatch-Logo.png)

Overwatch is an agentless infrastructure topology, observability, and incident automation platform built for heterogeneous environments spanning Kubernetes, Proxmox, Docker, networking, storage, identity, and supporting services.

It continuously discovers infrastructure relationships, builds a live dependency graph, evaluates health and thresholds, suppresses downstream noise when an upstream dependency is already failing, and feeds actionable incidents into an automated triage pipeline.

Overwatch replaces the earlier HexMap prototype.

---

## What Overwatch Does

Overwatch provides a live operational model of the environment by combining infrastructure discovery, topology mapping, health state, observability, and incident automation.

Core capabilities include:

- Agentless infrastructure discovery
- Dependency graph generation
- Proxmox, Kubernetes, Docker, network, storage, identity, and secret relationship discovery
- Health and threshold evaluation
- Dependency-aware alert suppression
- Maintenance mode at host, VM, service, and pod level
- Re-alert / recheck handling for persistent conditions
- Recovery detection and ticket updates
- Loki-backed live log retrieval
- Metrics integration
- Automated incident creation
- AI-assisted triage
- Idempotent ticket handling
- Flood protection
- Human review before final incident closure

---

## Architecture

```text
Infrastructure Sources
        │
        ▼
   Overwatch Discovery
        │
        ├── Proxmox API
        ├── Kubernetes API
        ├── Docker
        ├── Authentik
        ├── Infisical
        ├── NFS mounts
        ├── SNMP
        ├── Host/runtime inspection
        └── Additional infrastructure APIs
        │
        ▼
   Dependency Graph
        │
        ├── hosts
        ├── runs-on relationships
        ├── storage dependencies
        ├── database dependencies
        ├── SSO / identity relationships
        ├── secrets
        └── network relationships
        │
        ▼
   Health / Threshold Engine
        │
        ├── consecutive-evaluation thresholds
        ├── dependency-aware suppression
        ├── maintenance mode
        ├── rechecks / re-alerts
        ├── recovery detection
        └── dead-man's-switch monitoring
        │
        ▼
      n8n
        │
        ▼
   Incident Intake Pipeline
        │
        ├── idempotency
        ├── event routing
        ├── flood control
        ├── AI triage routing
        └── recovery updates
        │
        ▼
     FreeITSM
