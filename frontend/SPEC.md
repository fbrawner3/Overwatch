# Hexmap — Migration & Redesign Spec

> **Author**: Claude (architect)
> **Date**: 2026-06-30
> **Builder**: Codex
> **Reviewer**: Claude

---

## Goal

Strip Base44, wire real data from Prometheus/Loki, redesign the flat layout into a proper 4-layer 3D rotating hex map, add Authentik OIDC, deploy on Heizou Docker at `hexmap.geekygramps.com`.

---

## Phase 1 — Strip Base44 & Wire Prometheus/Loki

### 1.1 Remove dead packages

From `package.json`, remove:
- `@base44/sdk`
- `@base44/vite-plugin`
- `@stripe/react-stripe-js`
- `@stripe/stripe-js`

Add:
- `react-oidc-context` + `oidc-client-ts` (OIDC auth)

### 1.2 Delete Base44 files

- `src/api/base44Client.js`
- `src/lib/app-params.js`
- `src/pages/Login.jsx`
- `src/pages/Register.jsx`
- `src/pages/ForgotPassword.jsx`
- `src/pages/ResetPassword.jsx`

### 1.3 Replace AuthContext

Replace `src/lib/AuthContext.jsx` with `react-oidc-context` provider. Wrap the app root in `AuthProvider` with config from env vars. Protect the app route with `withAuthenticationRequired`. No custom login page — Authentik handles the UI.

```jsx
// src/lib/AuthContext.jsx
import { AuthProvider } from 'react-oidc-context';

const oidcConfig = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY,
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID,
  redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI,
  post_logout_redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI,
  scope: 'openid profile email',
};

export function AppAuthProvider({ children }) {
  return <AuthProvider {...oidcConfig}>{children}</AuthProvider>;
}
```

### 1.4 Fix vite.config.js

Remove all `@base44/vite-plugin` imports and plugin usage. Standard Vite React config only.

### 1.5 Rewrite metricsService.js

Replace Beszel calls with Prometheus HTTP API. Base URL from `VITE_PROMETHEUS_URL`.

**Prometheus query patterns:**

```javascript
const PROMETHEUS_URL = import.meta.env.VITE_PROMETHEUS_URL; // e.g. http://prometheus:9090

async function query(promql) {
  const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`);
  const json = await res.json();
  return json.data.result;
}
```

**Metrics per node type:**

For nodes with `meta.prometheusInstance` (node_exporter — Heizou, Zhongli, Navia, Chiori, Shenhe):
```
CPU:     100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle",instance="<instance>"}[5m])) * 100)
RAM:     (1 - node_memory_MemAvailable_bytes{instance="<instance>"} / node_memory_MemTotal_bytes{instance="<instance>"}) * 100
Disk:    (1 - node_filesystem_avail_bytes{instance="<instance>",mountpoint="/"} / node_filesystem_size_bytes{instance="<instance>",mountpoint="/"}) * 100
Net RX:  rate(node_network_receive_bytes_total{instance="<instance>",device!="lo"}[5m])
Net TX:  rate(node_network_transmit_bytes_total{instance="<instance>",device!="lo"}[5m])
```

For nodes with `meta.pveId` (pve-exporter — Proxmox nodes, VMs, LXCs):
```
CPU:     max by (id) (pve_cpu_usage_ratio{id="<pveId>", job="proxmox-cluster"})
RAM:     max by (id) (pve_memory_usage_bytes{id="<pveId>", job="proxmox-cluster"}) / max by (id) (pve_memory_size_bytes{id="<pveId>", job="proxmox-cluster"}) * 100
Up:      max by (id) (pve_up{id="<pveId>", job="proxmox-cluster"})
```

**Poll interval**: 30s. Keep mock data fallback on fetch error.

### 1.6 Rewrite statusService.js

Replace Uptime Kuma with Prometheus `up` metric and `pve_up`.

```javascript
// For node_exporter targets — use the `up` metric
up{instance="<prometheusInstance>", job=~".+"}

// For PVE targets
max by (id) (pve_up{id="<pveId>", job="proxmox-cluster"})

// Map: 1 → "healthy", 0 → "critical", no data → "unknown"
```

**Poll interval**: 30s.

### 1.7 New logsService.js

Loki HTTP API. Base URL from `VITE_LOKI_URL`.

```javascript
const LOKI_URL = import.meta.env.VITE_LOKI_URL;

// Query recent important logs for a node
async function getNodeLogs(nodeLabel, limit = 50) {
  const logql = `{job=~".+"} |= \`${nodeLabel}\` | json | level=~"error|warn|warning|critical|fatal"`;
  const end = Date.now() * 1e6;         // nanoseconds
  const start = end - 3600 * 1e9;      // last 1 hour
  const url = `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(logql)}&start=${start}&end=${end}&limit=${limit}&direction=backward`;
  const res = await fetch(url);
  const json = await res.json();
  return json.data.result.flatMap(s => s.values.map(([ts, line]) => ({ ts, line })));
}
```

Each node in topology gets `meta.lokiLabel` — the container name or hostname used in Loki labels (e.g. `heizou`, `navia`, `authentik`).

### 1.8 Update topology.js

**Remove**: all `uptimeKumaMonitor` fields, `beszelHostId` fields, stale IPs for Zhongli.

**Add per node**:
- `meta.prometheusInstance` — for node_exporter targets
- `meta.pveId` — for pve-exporter targets (format: `"node/venti"`, `"qemu/106"`, `"lxc/103"`)
- `meta.lokiLabel` — container/host name in Loki
- `layer` — explicit layer assignment: `"edge"` | `"host"` | `"vm"` | `"service"`

**Fix**: Zhongli IP → `10.0.0.10`

**Complete node meta mapping:**

| Node | layer | prometheusInstance | pveId | lokiLabel |
|---|---|---|---|---|
| cyno | edge | — | — | — |
| kazuha | edge | — | — | — |
| venti | host | — | `node/venti` | `venti` |
| nahida | host | — | `node/nahida` | `nahida` |
| furina | host | — | `node/furina` | `furina` |
| raiden | host | — | `node/raiden` | `raiden` |
| heizou | host | `heizou` | — | `heizou` |
| zhongli | host | `10.0.0.10:9100` | — | `zhongli` |
| navia | vm | `navia` | `qemu/106` | `navia` |
| chiori | vm | `chiori` | `qemu/107` | `chiori` |
| shenhe | vm | `shenhe` | `qemu/108` | `shenhe` |
| neuvillette | vm | — | `qemu/100` | `neuvillette` |
| kirara | vm | — | `lxc/103` | `kirara` |
| lyney | vm | — | `lxc/104` | `lyney` |
| lynette | vm | — | `lxc/105` | `lynette` |
| ningguang | vm | — | `lxc/200` | `ningguang` |
| yelan | vm | — | `lxc/201` | `yelan` |
| all k3s apps | service | — | — | `<app-name>` |

K3s app nodes: status = `unknown` (gray) until kube-state-metrics is added. Show `—` for all metrics.

### 1.9 Add env files

`.env.example`:
```
VITE_PROMETHEUS_URL=http://prometheus:9090
VITE_LOKI_URL=http://loki:3100
VITE_OIDC_AUTHORITY=https://auth.brawnandmoore.com
VITE_OIDC_CLIENT_ID=hexmap
VITE_OIDC_REDIRECT_URI=https://hexmap.geekygramps.com/callback
```

`.env.local` (dev, not committed):
```
VITE_PROMETHEUS_URL=http://10.0.0.20:9090
VITE_LOKI_URL=http://10.0.0.20:3100
VITE_OIDC_AUTHORITY=https://auth.brawnandmoore.com
VITE_OIDC_CLIENT_ID=hexmap
VITE_OIDC_REDIRECT_URI=http://localhost:5173/callback
```

---

## Phase 2 — 3D Layered Hex Map Redesign

### 2.1 Layer system

Four horizontal hex planes at Y heights:

```javascript
const LAYER_Y = {
  edge:    12,
  host:    8,
  vm:      4,
  service: 0,
};
```

Assign nodes to layers via `node.layer` field (set in topology.js).

### 2.2 Hex grid layout per layer

Within each layer plane, pack nodes in a hex grid pattern (pointy-top hexagons). Use axial coordinates. Pack order: sort nodes by `id` alphabetically, then assign axial coords in a spiral from center.

```javascript
// Hex axial → 3D world position (within a layer plane)
function hexToWorld(q, r, layerY) {
  const size = 2.2; // hex radius
  const x = size * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
  const z = size * (3 / 2 * r);
  return [x, layerY, z];
}
```

Service layer has 20+ nodes — use tighter packing (`size = 1.8`).

### 2.3 Inter-layer connections

Vertical glowing lines from parent → child (across layers). Use `TOPO_EDGES` where `type === 'hosts'` for the structural spine. Render as `<Line>` from `@react-three/drei`.

**Line colors by edge type:**
```javascript
const EDGE_COLORS = {
  hosts:       '#ffffff44',  // white, dim
  depends_on:  '#f59e0b88',  // amber
  storage:     '#3b82f688',  // blue
  sso_for:     '#a855f788',  // purple
  secrets_for: '#22c55e88',  // green
  network:     '#64748b88',  // slate
};
```

Only render edges visible in current zoom/selection context. `alwaysVisible: true` edges always render. Others render only when either endpoint is selected/hovered.

### 2.4 Camera & rotation

- **Initial**: `position={[0, 20, 35]}`, looking at `[0, 6, 0]` (center of stack)
- **Auto-rotation**: slow Y-axis, `rotationSpeed = 0.003 rad/frame`
- **Pause**: stop rotation on any mouse interaction; resume after 4s idle
- **Controls**: `OrbitControls` from `@react-three/drei`, `enableDamping`, `dampingFactor=0.05`
- **Min/max distance**: 10 to 80

### 2.5 Node appearance

Hex prism geometry per node. Height = 0.3, radius based on layer:
- edge: 1.0, host: 1.0, vm: 0.85, service: 0.7

**Glow color by status:**
```javascript
const STATUS_COLORS = {
  healthy:  '#22c55e',  // green
  warning:  '#f59e0b',  // amber
  critical: '#ef4444',  // red
  unknown:  '#475569',  // slate-600
};
```

Emissive material with bloom post-processing (`@react-three/postprocessing`, `Bloom` effect, `luminanceThreshold=0.3`, `intensity=1.5`).

Name label: `<Text>` from `@react-three/drei`, always facing camera (billboard), size proportional to layer.

### 2.6 Layer plane backdrop

Subtle translucent hex-grid plane behind each layer (thin `PlaneGeometry` with wireframe hex texture or shader). Helps visually separate layers. Opacity 0.05, color `#1e293b`.

### 2.7 Selection & hover

- **Hover**: scale node to 1.15, brighten emissive
- **Click**: set selected node in store, open detail panel
- **Click background**: deselect, close panel

---

## Phase 3 — Detail Panel

### 3.1 Tabs

Three tabs: **Status**, **Metrics**, **Logs**

**Status tab:**
- Node name, type, IP, layer
- Up/down badge from Prometheus
- Dependency list (nodes this depends on, with their status dots)
- `meta.specs` or `meta.notes` if present

**Metrics tab** (only for nodes with `prometheusInstance` or `pveId`):
- CPU gauge (%)
- RAM gauge (%)  
- Disk gauge (%) — only for node_exporter nodes
- Network sparkline (RX/TX bytes/s, last 5 min)
- If no metrics available: "No metrics available for this node"

**Logs tab:**
- Last 50 error/warn/critical log lines from Loki
- Auto-refresh every 30s
- Timestamp + log line
- Color: red=error/critical/fatal, amber=warn
- If `meta.lokiLabel` not set: "No log stream configured"

### 3.2 Remove Uptime Kuma link

Delete the `href="http://uptime-kuma.fndhome"` block entirely (DetailPanel.jsx ~line 203).

---

## Phase 4 — Docker Deployment

### 4.1 Dockerfile

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`nginx.conf`:
```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }
}
```

### 4.2 Add to heizou/compose.yaml

```yaml
  hexmap:
    build:
      context: ../hexmap
      dockerfile: Dockerfile
    container_name: hexmap
    restart: unless-stopped
    ports:
      - "8080:80"
    environment:
      - VITE_PROMETHEUS_URL=http://prometheus:9090
      - VITE_LOKI_URL=http://loki:3100
      - VITE_OIDC_AUTHORITY=https://auth.brawnandmoore.com
      - VITE_OIDC_CLIENT_ID=hexmap
      - VITE_OIDC_REDIRECT_URI=https://hexmap.geekygramps.com/callback
```

> **Note**: Vite `VITE_*` vars are baked at build time. The compose `environment` block does NOT inject them at runtime into the built nginx container. Env vars must be passed to the **build stage**. Use build args:

```yaml
  hexmap:
    build:
      context: ../hexmap
      dockerfile: Dockerfile
      args:
        - VITE_PROMETHEUS_URL=http://10.0.0.20:9090
        - VITE_LOKI_URL=http://10.0.0.20:3100
        - VITE_OIDC_AUTHORITY=https://auth.brawnandmoore.com
        - VITE_OIDC_CLIENT_ID=hexmap
        - VITE_OIDC_REDIRECT_URI=https://hexmap.geekygramps.com/callback
    container_name: hexmap
    restart: unless-stopped
    ports:
      - "8080:80"
```

And in Dockerfile builder stage:
```dockerfile
ARG VITE_PROMETHEUS_URL
ARG VITE_LOKI_URL
ARG VITE_OIDC_AUTHORITY
ARG VITE_OIDC_CLIENT_ID
ARG VITE_OIDC_REDIRECT_URI
ENV VITE_PROMETHEUS_URL=$VITE_PROMETHEUS_URL
ENV VITE_LOKI_URL=$VITE_LOKI_URL
ENV VITE_OIDC_AUTHORITY=$VITE_OIDC_AUTHORITY
ENV VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID
ENV VITE_OIDC_REDIRECT_URI=$VITE_OIDC_REDIRECT_URI
```

### 4.3 Add Caddy route

Add to Heizou's `caddy/Caddyfile`:
```
hexmap.fndhome {
    reverse_proxy hexmap:80
}
```

### 4.4 Authentik setup (Felton does this manually)

In Authentik admin:
1. Create OAuth2/OpenID Connect Provider:
   - Name: `hexmap`
   - Client ID: `hexmap`
   - Client type: Public
   - Redirect URIs: `https://hexmap.geekygramps.com/callback`, `http://localhost:5173/callback`
   - Scopes: `openid profile email`
2. Create Application:
   - Name: `Hexmap`
   - Slug: `hexmap`
   - Provider: the one above
3. Add to Pangolin: point `hexmap.geekygramps.com` → `10.0.0.20:8080`

---

## Prometheus CORS Note

Prometheus by default blocks cross-origin requests from the browser. Two options:

**Option A** (preferred): Caddy proxy routes `/prometheus` to Prometheus — app never calls Prometheus directly from browser.

Add to Heizou Caddyfile:
```
hexmap.fndhome {
    reverse_proxy /api/prometheus/* http://prometheus:9090 {
        uri strip_prefix /api/prometheus
    }
    reverse_proxy /api/loki/* http://loki:3100 {
        uri strip_prefix /api/loki
    }
    reverse_proxy * hexmap:80
}
```

Then `VITE_PROMETHEUS_URL=/api/prometheus` and `VITE_LOKI_URL=/api/loki` — same-origin, no CORS.

**Option B**: Add `--web.cors.origin="*"` to Prometheus startup args. Simpler but less clean.

Use Option A.

---

## Files to Create / Modify

| File | Action |
|---|---|
| `package.json` | remove 3 packages, add 2 |
| `vite.config.js` | remove base44 plugin |
| `Dockerfile` | create |
| `nginx.conf` | create |
| `.env.example` | create |
| `src/lib/AuthContext.jsx` | rewrite (react-oidc-context) |
| `src/main.jsx` | wrap with AuthProvider |
| `src/services/metricsService.js` | rewrite (Prometheus) |
| `src/services/statusService.js` | rewrite (Prometheus up metric) |
| `src/services/logsService.js` | create (Loki) |
| `src/data/topology.js` | update meta fields, fix Zhongli IP, add layer field |
| `src/store/graphStore.js` | add logs slice |
| `src/components/ui/DetailPanel.jsx` | add Logs tab, remove UptimeKuma link |
| `src/components/HexNode.jsx` | update for new layer-aware sizing |
| `src/components/Scene3D.jsx` (or equivalent) | full 3D layered layout |
| `heizou/compose.yaml` | add hexmap service |
| `heizou/caddy/Caddyfile` | add hexmap + proxy routes |
| `src/api/base44Client.js` | delete |
| `src/lib/app-params.js` | delete |
| `src/pages/Login.jsx` | delete |
| `src/pages/Register.jsx` | delete |
| `src/pages/ForgotPassword.jsx` | delete |
| `src/pages/ResetPassword.jsx` | delete |

---

## Out of Scope (v1)

- K3s app node status (needs kube-state-metrics — add later)
- Real-time WebSocket updates (polling is fine for v1)
- Cyno/OPNsense metrics (not scraped)
- Kazuha/AWS metrics (external)
