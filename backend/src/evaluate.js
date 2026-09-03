const path = require('path');

const DB_PATH = process.env.THRESHOLD_DB_PATH || '/data/threshold.db';
const RESEND_MS         = parseInt(process.env.RESEND_MS               || String(6  * 60 * 60 * 1000));
const STALE_STATE_MS    = parseInt(process.env.STALE_STATE_MS          || String(10 * 60 * 1000));
const MAX_SUPPRESS_MS   = parseInt(process.env.MAX_SUPPRESS_MS         || String(2  * 60 * 60 * 1000));
// F21 (round 5): default TTL dropped 4h -> 1h. A 4h auto-window silenced any
// real failure on the node for hours after a short job. Maintenance longer than
// an hour must pass an explicit expires_at. MAINTENANCE_DEFAULT_TTL_MS overrides.
const MAINT_DEFAULT_TTL = parseInt(process.env.MAINTENANCE_DEFAULT_TTL_MS || String(1  * 60 * 60 * 1000));
const MAINT_MAX_TTL     = parseInt(process.env.MAINTENANCE_MAX_TTL_MS     || String(24 * 60 * 60 * 1000));
// V6-round-6: cron interval, used to flag a chronically-skipped run as degraded.
const EVAL_INTERVAL_MS  = parseInt(process.env.EVAL_INTERVAL_MS           || String(60 * 1000));
// V12-round-6: one webhook send can chain up to 3 sequential FreeITSM calls at
// 2-4s each on the n8n side. 10s was too tight; 20s covers the worst case.
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS        || String(20 * 1000));

// Global defaults — threshold_config rows override per node+metric_type.
const DEFAULTS = {
  cpu:          { threshold_value: 90,   consecutive_required: 3 },
  mem:          { threshold_value: 90,   consecutive_required: 3 },
  disk:         { threshold_value: 85,   consecutive_required: 2 },
  reachability: { threshold_value: null, consecutive_required: 2 },
  // SNMP switches only. Count of admin-up ports that are operationally down;
  // fires when any port drops. Non-switch nodes never populate this metric.
  ports_down:   { threshold_value: 0,    consecutive_required: 2 },
};

// How each edge type relates its two ends:
//   'out' — e.source depends on e.target   (the consumer is e.source)
//   'in'  — e.target depends on e.source   (the provider is e.source)
// Live-State documents Infisical→app (secrets_for) and app→Authentik (sso), and
// Proxmox host→guest (hosts) / k8s node→pod (pod_host) — mixed directions, so
// suppression and the topology adjacency must classify per type, not assume one.
const DEP_EDGE_DIRECTION = {
  depends_on:  'out',
  database:    'out',
  storage:     'out',
  sso:         'out',
  network:     'out',   // local tunnel endpoint depends on the remote it reaches (kirara->kazuha, lyney->navia)
  sso_for:     'in',
  secrets_for: 'in',
  hosts:       'in',
  pod_host:    'in',
};

class MaintenanceValidationError extends Error {}

// Chatty per-pass logging — silenced when running against an in-memory DB (tests).
const QUIET = DB_PATH === ':memory:';
const log  = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => { if (!QUIET) console.warn(...a); };

let _db = null;

function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  if (DB_PATH !== ':memory:') {
    require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  _db = new Database(DB_PATH);
  if (DB_PATH !== ':memory:') {
    try { _db.pragma('journal_mode = WAL'); } catch (e) { console.warn('[evaluate] WAL pragma failed:', e.message); }
    try { _db.pragma('busy_timeout = 5000'); } catch {}
  }
  _db.exec(`
    CREATE TABLE IF NOT EXISTS threshold_config (
      node_id              TEXT NOT NULL,
      metric_type          TEXT NOT NULL,
      enabled              INTEGER NOT NULL DEFAULT 1,
      threshold_value      REAL,
      consecutive_required INTEGER NOT NULL,
      PRIMARY KEY (node_id, metric_type)
    );
    CREATE TABLE IF NOT EXISTS threshold_state (
      node_id                TEXT NOT NULL,
      metric_type            TEXT NOT NULL,
      consecutive_over_count INTEGER NOT NULL DEFAULT 0,
      first_over_at          TEXT,
      last_alert_sent_at     TEXT,
      status                 TEXT NOT NULL DEFAULT 'ok',
      last_seen_at           TEXT,
      suppressed_since       TEXT,
      suppress_note_at       TEXT,
      PRIMARY KEY (node_id, metric_type)
    );
    CREATE TABLE IF NOT EXISTS maintenance_mode (
      node_id     TEXT PRIMARY KEY,
      reason      TEXT,
      set_by      TEXT,
      set_at      TEXT NOT NULL,
      expires_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS source_health (
      source            TEXT PRIMARY KEY,
      last_ok_at        TEXT,
      last_count        INTEGER NOT NULL DEFAULT 0,
      degraded          INTEGER NOT NULL DEFAULT 0,
      consecutive_empty INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Additive migrations for DBs created before these columns existed.
  for (const col of ['last_seen_at TEXT', 'suppressed_since TEXT', 'suppress_note_at TEXT']) {
    try { _db.exec(`ALTER TABLE threshold_state ADD COLUMN ${col}`); } catch {}
  }
  try { _db.exec('ALTER TABLE source_health ADD COLUMN consecutive_empty INTEGER NOT NULL DEFAULT 0'); } catch {}
  return _db;
}

// Close and null the db — call between tests to get a clean in-memory db.
function resetDb() {
  if (_db) { try { _db.close(); } catch {} }
  _db = null;
}

// --- maintenance mode ----------------------------------------------------
function sanitizeText(v, max) {
  if (v == null) return null;
  // drop C0 control chars + DEL, length-cap. Renderers must still treat as text.
  let out = '';
  for (const ch of String(v)) {
    const n = ch.charCodeAt(0);
    out += (n < 32 || n === 127) ? ' ' : ch;
  }
  return out.slice(0, max);
}

// Presence of a row == node in maintenance. A parseable, past expires_at
// deactivates the row and it is lazily deleted here.
function listMaintenanceInternal(db) {
  const now = Date.now();
  const rows = db.prepare('SELECT node_id, reason, set_by, set_at, expires_at FROM maintenance_mode').all();
  const map = new Map();
  const expired = [];
  for (const r of rows) {
    const expMs = r.expires_at ? Date.parse(r.expires_at) : NaN;
    if (Number.isFinite(expMs) && expMs <= now) { expired.push(r.node_id); continue; }
    map.set(r.node_id, r);
  }
  if (expired.length) {
    const del = db.prepare('DELETE FROM maintenance_mode WHERE node_id = ?');
    for (const id of expired) del.run(id);
  }
  return map;
}

function listMaintenance() {
  return listMaintenanceInternal(getDb());
}

// Throws MaintenanceValidationError on bad input. expires_at, when supplied,
// must be a future ISO-8601 string; it is clamped to MAINT_MAX_TTL. When
// omitted, a server default TTL is applied so a crashed caller can't leave a
// node muted forever.
// node ids in this system look like `venti`, `k3s-homelab-nextcloud`,
// `docker-heizou-loki`, `source:proxmox` — letters, digits, dot, colon, hyphen.
const NODE_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function assertNodeId(nodeId) {
  if (!nodeId || typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) {
    throw new MaintenanceValidationError('nodeId must be 1-200 chars of [A-Za-z0-9._:-]');
  }
}

function setMaintenance(nodeId, { reason = null, set_by = null, expires_at = null } = {}) {
  assertNodeId(nodeId);
  const nowMs = Date.now();
  let expMs;
  let clamped = false;
  if (expires_at == null) {
    expMs = nowMs + MAINT_DEFAULT_TTL;
  } else if (typeof expires_at !== 'string') {
    throw new MaintenanceValidationError('expires_at must be an ISO-8601 string');
  } else {
    expMs = Date.parse(expires_at);
    if (!Number.isFinite(expMs)) throw new MaintenanceValidationError('expires_at must be an ISO-8601 string');
    if (expMs <= nowMs)          throw new MaintenanceValidationError('expires_at must be in the future');
    if (expMs > nowMs + MAINT_MAX_TTL) { expMs = nowMs + MAINT_MAX_TTL; clamped = true; }
  }
  getDb().prepare(`
    INSERT INTO maintenance_mode (node_id, reason, set_by, set_at, expires_at)
    VALUES (@node_id, @reason, @set_by, @set_at, @expires_at)
    ON CONFLICT(node_id) DO UPDATE SET
      reason = excluded.reason, set_by = excluded.set_by,
      set_at = excluded.set_at, expires_at = excluded.expires_at
  `).run({
    node_id:    nodeId,
    reason:     sanitizeText(reason, 500),
    set_by:     sanitizeText(set_by, 200),
    set_at:     new Date().toISOString(),
    expires_at: new Date(expMs).toISOString(),
  });
  const row = listMaintenanceInternal(getDb()).get(nodeId) || null;
  if (row) row.clamped = clamped;
  return row;
}

function clearMaintenance(nodeId) {
  return getDb().prepare('DELETE FROM maintenance_mode WHERE node_id = ?').run(nodeId).changes;
}

// Snapshot of firing state: which metrics are firing per node, and the earliest
// first_over_at per node (used to break dependency cycles by "who failed first").
function firingSnapshot(db) {
  const rows = db.prepare(
    "SELECT node_id, metric_type, first_over_at FROM threshold_state WHERE status = 'firing'"
  ).all();
  const byNode = new Map();
  const firstAt = new Map();
  for (const r of rows) {
    if (!byNode.has(r.node_id)) byNode.set(r.node_id, new Set());
    byNode.get(r.node_id).add(r.metric_type);
    const ms = Date.parse(r.first_over_at || '');
    if (Number.isFinite(ms)) {
      const cur = firstAt.get(r.node_id);
      if (cur == null || ms < cur) firstAt.set(r.node_id, ms);
    }
  }
  return { byNode, firstAt };
}

function listFiringStates() {
  return new Set(firingSnapshot(getDb()).byNode.keys());
}

// Consecutive empty polls required before a source latches "degraded" — one
// transient empty read shouldn't disable the stale sweep system-wide.
const SOURCE_DEGRADE_AFTER = parseInt(process.env.SOURCE_DEGRADE_AFTER || '3');

// Record per-discovery-source health. `counts` is { sourceName: nodeCount }.
// A source that returned rows before and now returns 0 for SOURCE_DEGRADE_AFTER
// consecutive polls is "degraded". Returns { degraded, sources, downSources }.
function recordSourceHealth(counts) {
  const db = getDb();
  const now = new Date().toISOString();
  const get = db.prepare('SELECT last_ok_at, last_count, degraded, consecutive_empty FROM source_health WHERE source = ?');
  const up = db.prepare(`
    INSERT INTO source_health (source, last_ok_at, last_count, degraded, consecutive_empty)
    VALUES (@source, @last_ok_at, @last_count, @degraded, @consecutive_empty)
    ON CONFLICT(source) DO UPDATE SET
      last_ok_at = excluded.last_ok_at, last_count = excluded.last_count,
      degraded = excluded.degraded, consecutive_empty = excluded.consecutive_empty
  `);
  const sources = {};
  const downSources = [];
  for (const [source, count] of Object.entries(counts || {})) {
    const prev = get.get(source) || { last_ok_at: null, last_count: 0, degraded: 0, consecutive_empty: 0 };
    const empty = count === 0 && prev.last_count > 0;
    const consecutive_empty = empty ? (prev.consecutive_empty || 0) + 1 : 0;
    const degraded = consecutive_empty >= SOURCE_DEGRADE_AFTER ? 1 : 0;
    up.run({
      source,
      last_ok_at: count > 0 ? now : prev.last_ok_at,
      last_count: count > 0 ? count : prev.last_count,
      consecutive_empty,
      degraded,
    });
    sources[source] = { count, last_ok_at: count > 0 ? now : prev.last_ok_at, degraded: !!degraded };
    if (degraded) downSources.push(source);
  }
  return { degraded: downSources.length > 0, sources, downSources };
}

// The nodes `nodeId` depends on, resolved by edge-type direction.
function dependencyLinks(topology, nodeId) {
  const out = [];
  for (const e of (topology.edges || [])) {
    if (!e || typeof e.type !== 'string' || !e.source || !e.target) continue;
    const dir = DEP_EDGE_DIRECTION[e.type];
    if (!dir) continue;
    if (dir === 'out' && e.source === nodeId) out.push({ id: e.target, viaType: e.type });
    else if (dir === 'in' && e.target === nodeId) out.push({ id: e.source, viaType: e.type });
  }
  return out;
}

// Walk up the dependency chain from `startId` to the ultimate cause — the
// firing/maintenance node that itself has no firing/maintenance dependency.
// Cycle-guarded; on a pure cycle returns the earliest-failing member.
//   isFiring(id)->bool, inMaint(id)->bool, firstAt(id)->ms|undefined,
//   metricsOf(id)->Set<metric>|undefined
// Returns { id, metric, at } — metric is the root's implicated metric
// (reachability if present, else the first firing metric, else null).
function rootCause(topology, startId, isFiring, inMaint, firstAt, metricsOf) {
  const visited = new Set();
  let current = startId;
  let best = startId;
  let bestAt = firstAt(startId);
  while (current && !visited.has(current)) {
    visited.add(current);
    let next = null;
    let nextAt = Infinity;
    for (const dep of dependencyLinks(topology, current)) {
      if (visited.has(dep.id)) continue;
      if (!inMaint(dep.id) && !isFiring(dep.id)) continue;
      const at = firstAt(dep.id);
      const cmp = at == null ? Infinity : at;
      if (cmp < nextAt) { next = dep.id; nextAt = cmp; }
    }
    if (!next) break;
    current = next;
    const at = firstAt(current);
    if (at != null && (bestAt == null || at < bestAt)) { best = current; bestAt = at; }
    else if (bestAt == null) best = current;
  }
  const set = metricsOf ? metricsOf(best) : null;
  const metric = set && set.size ? (set.has('reachability') ? 'reachability' : [...set][0]) : null;
  return { id: best, metric, at: firstAt(best) };
}

function getConfig(db, nodeId, metricType) {
  const row = db.prepare(
    'SELECT enabled, threshold_value, consecutive_required FROM threshold_config WHERE node_id = ? AND metric_type = ?'
  ).get(nodeId, metricType);
  if (row) return row;
  const def = DEFAULTS[metricType];
  return def ? { enabled: 1, ...def } : null;
}

function getState(db, nodeId, metricType) {
  return db.prepare(
    'SELECT consecutive_over_count, first_over_at, last_alert_sent_at, status, suppressed_since, suppress_note_at FROM threshold_state WHERE node_id = ? AND metric_type = ?'
  ).get(nodeId, metricType)
    || { consecutive_over_count: 0, first_over_at: null, last_alert_sent_at: null, status: 'ok', suppressed_since: null, suppress_note_at: null };
}

function setState(db, nodeId, metricType, fields) {
  db.prepare(`
    INSERT INTO threshold_state (node_id, metric_type, consecutive_over_count, first_over_at, last_alert_sent_at, status, last_seen_at, suppressed_since, suppress_note_at)
    VALUES (@nodeId, @metricType, @consecutive_over_count, @first_over_at, @last_alert_sent_at, @status, @last_seen_at, @suppressed_since, @suppress_note_at)
    ON CONFLICT(node_id, metric_type) DO UPDATE SET
      consecutive_over_count = excluded.consecutive_over_count,
      first_over_at          = excluded.first_over_at,
      last_alert_sent_at     = excluded.last_alert_sent_at,
      status                 = excluded.status,
      last_seen_at           = excluded.last_seen_at,
      suppressed_since       = excluded.suppressed_since,
      suppress_note_at       = excluded.suppress_note_at
  `).run({ nodeId, metricType, last_seen_at: null, suppressed_since: null, suppress_note_at: null, ...fields });
}

function buildMessage(nodeId, metricType, value, config) {
  if (metricType === 'reachability') {
    return `${nodeId} reachability critical for ${config.consecutive_required} consecutive evaluations`;
  }
  if (metricType === 'ports_down') {
    return `${nodeId} has ${value} port(s) down for ${config.consecutive_required} consecutive evaluations`;
  }
  return `${nodeId} ${metricType} at ${Math.round(value * 10) / 10}% exceeds ${config.threshold_value}% threshold for ${config.consecutive_required} consecutive evaluations`;
}

// Returns { ok, reason, payload }. ok is true only on a 2xx response — callers
// must not advance alert state on a non-ok result.
//   kind: 'alert' | 'suppressed' | 'resolved' | 'maintenance-suppressed'
const EVENT_STATUS = {
  alert: 'firing',
  suppressed: 'suppressed',
  resolved: 'resolved',
  'maintenance-suppressed': 'suppressed',
};
async function sendEvent(kind, { nodeId, metricType, value, config, detectedAt, upstreamNode, upstreamMetric, note }) {
  const url = process.env.N8N_THRESHOLD_WEBHOOK_URL;
  const secret = process.env.ALERT_WEBHOOK_SECRET;
  if (!url) return { ok: false, reason: 'no-url' };
  if (!secret) {
    console.error('[evaluate] ALERT_WEBHOOK_SECRET not set — refusing to send an unsigned webhook');
    return { ok: false, reason: 'no-secret' };
  }

  const suppressed = kind === 'suppressed' || kind === 'maintenance-suppressed';
  const payload = {
    source:      'hexmap-watcher',
    hexmap_node: nodeId,
    metric:      metricType,
    event:       kind,
    status:      EVENT_STATUS[kind] || 'firing',
    suppressed,
    message:     note || buildMessage(nodeId, metricType, value, config),
    detected_at: detectedAt,
    ...(upstreamNode ? { upstream_node: upstreamNode } : {}),
    ...(upstreamMetric ? { upstream_metric: upstreamMetric } : {}),
  };

  try {
    const fetch = require('node-fetch');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Alert-Webhook-Secret': secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      // V14-round-6: a 429 (n8n flood guard / rate limit) means "throttled, try
      // later" — NOT "alerting is down". Only real failures feed `degraded`.
      const throttled = res.status === 429;
      warn(`[evaluate] webhook ${throttled ? 'throttled (429)' : `non-2xx (${res.status})`} ${nodeId}/${metricType}`);
      return { ok: false, reason: `http-${res.status}`, throttled, payload };
    }
    log(`[evaluate] ${kind} sent ${nodeId}/${metricType}: HTTP ${res.status}`);
    return { ok: true, payload };
  } catch (err) {
    warn(`[evaluate] webhook failed ${nodeId}/${metricType}: ${err.message}`);
    return { ok: false, reason: 'exception', payload };
  }
}

// Extract evaluatable metrics from a topology node.
// Returns object with present fields only — absent = no data for that metric on this node.
function extractMetrics(node) {
  const meta = node.meta || {};
  const m = {};

  // Reachability — every node
  m.reachability = node.status === 'critical' || node.status === 'unknown';

  if (meta.k8sNodeMetrics) {
    if (meta.k8sNodeCpuM != null && meta.k8sNodeCpuTotalM > 0)
      m.cpu = (meta.k8sNodeCpuM / meta.k8sNodeCpuTotalM) * 100;
    if (meta.k8sNodeMemMiB != null && meta.k8sNodeMemTotalMiB > 0)
      m.mem = (meta.k8sNodeMemMiB / meta.k8sNodeMemTotalMiB) * 100;
    if (meta.disk != null && meta.maxdisk > 0)
      m.disk = (meta.disk / meta.maxdisk) * 100;
  } else if (meta.haMetrics) {
    if (meta.cpuPercent  != null) m.cpu  = meta.cpuPercent;
    if (meta.memPercent  != null) m.mem  = meta.memPercent;
    if (meta.diskPercent != null) m.disk = meta.diskPercent;
  } else if (meta.k8sMetrics) {
    if (meta.cpuM   != null && meta.cpuLimitM   > 0) m.cpu = (meta.cpuM   / meta.cpuLimitM)   * 100;
    if (meta.memMiB != null && meta.memLimitMiB > 0) m.mem = (meta.memMiB / meta.memLimitMiB) * 100;
  } else if (node.type === 'proxmox-host' || node.type === 'lxc' || node.type === 'vm') {
    if (meta.cpu  != null)                     m.cpu  = meta.cpu * 100;
    if (meta.mem  != null && meta.maxmem  > 0) m.mem  = (meta.mem  / meta.maxmem)  * 100;
    if (meta.disk != null && meta.maxdisk > 0) m.disk = (meta.disk / meta.maxdisk) * 100;
  } else if (node.type === 'switch') {
    // reachability is already set above from node.status (poll fail => critical).
    // ports_down counts only LINK-down ports — a port with lifetime traffic (or
    // up last poll) that is now oper-down. Empty spare ports are "not used", not
    // "down", and are excluded upstream. bps / error rates stay in meta.snmp for
    // the frontend until tuned against baseline traffic.
    const s = meta.snmp || {};
    if (s.pollOk && s.portsLinkDown != null) m.ports_down = s.portsLinkDown;
  }

  return m;
}

// Core evaluation — accepts a topology object directly.
// Tests call this with synthesised topology; production uses evaluateFromCache().
//
// Two-phase: phase 1 classifies every (node, metric) and builds the post-pass
// firing view (existing firing + everything that reaches firing THIS pass), so
// a first-time cascade — e.g. authentik plus every SSO app crossing on the same
// tick — suppresses correctly instead of every node alerting. Phase 2 decides +
// sends. Phase 3 commits all state writes in one transaction.
async function evaluate(topology) {
  const db = getDb();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const alerts = [];
  const recoveries = [];
  const suppressed = [];
  const resolvedEvents = [];
  const deliveryFailures = [];
  const maintenanceSkipped = [];
  const nodeErrors = [];

  const maintenanceMap = listMaintenanceInternal(db);
  const { byNode: firingBefore, firstAt: firstAtBefore } = firingSnapshot(db);

  const nodes = (topology.nodes || []).filter(n => n && n.id);
  const sourcesDegraded = !!(topology.degraded && topology.degraded.sources);
  // F11 (round 5): cache.getTopology() serves the last-good snapshot flagged
  // `stale` when buildTopology() throws. Metrics in a frozen snapshot must not
  // drive recoveries / resolved events, and the stale sweep must not fire off
  // frozen last_seen_at data. Alerts still pass (err toward noticing, not
  // silencing); recoveries wait for a fresh topology.
  const topoStale = !!topology.stale;

  // ---- phase 1: classify; build the post-pass firing view -----------------
  const pending = [];      // violated / clear entries to act on in phase 2
  const maintNotes = [];   // firing metrics on a node just placed in maintenance

  const firingAfter = new Map();   // nodeId -> Set(metric)
  const firstAtAfter = new Map();  // nodeId -> earliest first_over_at ms
  for (const [id, set] of firingBefore) firingAfter.set(id, new Set(set));
  for (const [id, ms] of firstAtBefore) firstAtAfter.set(id, ms);
  const noteFiring = (id, metric, ms) => {
    if (!firingAfter.has(id)) firingAfter.set(id, new Set());
    firingAfter.get(id).add(metric);
    if (ms != null) {
      const cur = firstAtAfter.get(id);
      if (cur == null || ms < cur) firstAtAfter.set(id, ms);
    }
  };

  for (const node of nodes) {
    try {
      if (maintenanceMap.has(node.id)) {
        maintenanceSkipped.push(node.id);
        for (const r of db.prepare("SELECT metric_type FROM threshold_state WHERE node_id = ? AND status = 'firing'").all(node.id)) {
          maintNotes.push({ node_id: node.id, metric_type: r.metric_type });
        }
        continue; // state reset happens in the commit phase
      }

      const nodeMetrics = extractMetrics(node);
      for (const metricType of Object.keys(DEFAULTS)) {
        const rawValue = nodeMetrics[metricType];
        if (rawValue === undefined) continue;
        const config = getConfig(db, node.id, metricType);
        if (!config || config.enabled === 0) continue;
        const state = getState(db, node.id, metricType);
        const violated = metricType === 'reachability'
          ? rawValue === true
          : (config.threshold_value != null && rawValue > config.threshold_value);

        if (!violated) {
          // F11: on a stale topology, don't trust "recovered" — leave firing
          // state as-is and wait for a fresh snapshot.
          if (!topoStale && (state.consecutive_over_count > 0 || state.status === 'firing' || state.suppressed_since)) {
            recoveries.push({ nodeId: node.id, metricType, timestamp: now });
            pending.push({
              node, metricType, kind: 'clear', state,
              // F23: only a metric that actually alerted owes a resolved webhook.
              wasAlerted: state.status === 'firing' && !!state.last_alert_sent_at,
              detectedAt: state.first_over_at || now,
            });
          }
          continue;
        }

        const newCount = state.consecutive_over_count + 1;
        const firstOverAt = state.first_over_at || now;
        if (newCount >= config.consecutive_required) noteFiring(node.id, metricType, Date.parse(firstOverAt));
        pending.push({
          node, metricType, kind: 'violated', rawValue, config, state,
          newCount, firstOverAt, crossing: newCount === config.consecutive_required,
        });
      }
    } catch (err) {
      console.error(`[evaluate] classify ${node && node.id} failed: ${err.message}`);
      nodeErrors.push({ node_id: node && node.id, phase: 'classify', error: err.message });
    }
  }

  const isFiring  = id => firingAfter.has(id) && firingAfter.get(id).size > 0;
  const inMaint   = id => maintenanceMap.has(id);
  const firstAtOf = id => firstAtAfter.get(id);

  // V5 (round 6): order phase-2 so a ROOT alert is sent before the downstream
  // 'suppressed' events it explains — otherwise, when a downstream node precedes
  // the root in topology.nodes, n8n gets the suppressed note before the root's
  // ticket exists. Cheap pre-classification (any firing/maintenance dependency)
  // is enough for ordering; the authoritative cause calc still runs below.
  const likelyDownstream = (p) => {
    if (p.kind !== 'violated') return false;
    for (const dep of dependencyLinks(topology, p.node.id)) {
      if (inMaint(dep.id) || isFiring(dep.id)) return true;
    }
    return false;
  };
  const phase2 = [...pending].sort((a, b) => {
    const rank = (p) => p.kind === 'clear' ? 0 : likelyDownstream(p) ? 2 : 1;
    return rank(a) - rank(b);
  });

  // ---- phase 2: decide + send; each metric's state is committed inline,
  // right after its own webhook(s), so a mid-pass crash replays one metric ----
  for (const p of phase2) {
    try {
      if (p.kind === 'clear') {
        // F23: send the resolved webhook BEFORE clearing state, and only fully
        // clear once it's delivered. A transient failure leaves the row in a
        // "firing + alerted, streak zeroed" state so the NEXT pass retries the
        // resolved send (it won't re-alert — the streak is 0 and the metric is
        // no longer violated).
        let resolvedOk = true;
        if (p.wasAlerted) {
          const r = await sendEvent('resolved', {
            nodeId: p.node.id, metricType: p.metricType, detectedAt: p.detectedAt || now,
            note: `${p.node.id} ${p.metricType} recovered`,
          });
          resolvedOk = r.ok;
          resolvedEvents.push({ node_id: p.node.id, metric_type: p.metricType, delivered: r.ok });
          if (!r.ok) deliveryFailures.push({ node_id: p.node.id, metric_type: p.metricType, kind: 'resolved', reason: r.reason });
        }
        setState(db, p.node.id, p.metricType, resolvedOk
          ? { consecutive_over_count: 0, first_over_at: null, last_alert_sent_at: null,
              status: 'ok', last_seen_at: now, suppressed_since: null, suppress_note_at: null }
          : { consecutive_over_count: 0, first_over_at: null,
              last_alert_sent_at: (p.state && p.state.last_alert_sent_at) || now,
              status: 'firing', last_seen_at: now, suppressed_since: null, suppress_note_at: null });
        continue;
      }

      const { node, metricType, rawValue, config, state, newCount, firstOverAt, crossing } = p;
      const wouldAlert = crossing || (state.status === 'firing' && !state.last_alert_sent_at);

      let cause = null;
      for (const dep of dependencyLinks(topology, node.id)) {
        if (inMaint(dep.id)) {
          // a maintenance upstream only excuses a downstream REACHABILITY failure
          if (metricType === 'reachability') { cause = { direct: dep.id, kind: 'maintenance' }; break; }
          continue;
        }
        const depFiring = firingAfter.get(dep.id);
        if (!depFiring || depFiring.size === 0) continue;
        if (depFiring.has('reachability')) { cause = { direct: dep.id, kind: 'reachability' }; break; }
        if (metricType === 'reachability')  { cause = { direct: dep.id, kind: 'resource' };     break; }
      }
      // Ordering / cycle break — but only for a SOFT cause (resource metric).
      // A hard cause (an upstream reachability/critical failure, or an upstream
      // in maintenance) stays causal regardless of which symptom surfaced first.
      if (cause && cause.kind === 'resource') {
        const upFirst = firstAtOf(cause.direct);
        const myFirst = Date.parse(state.first_over_at || firstOverAt);
        if (upFirst != null && Number.isFinite(myFirst) && upFirst > myFirst) cause = null;
      }

      // Resolve to the ROOT node, and pair the metric with THAT node (not the
      // direct upstream) so Batch C's [OW:root:metric] key lookup can hit.
      let rootUpstream = null;
      let upstreamMetric = null;
      if (cause) {
        const myFirst = Date.parse(state.first_over_at || firstOverAt);
        const root = rootCause(topology, cause.direct, isFiring, inMaint, firstAtOf, id => firingAfter.get(id));
        // Revalidate: if the resolved root started failing AFTER this victim
        // (stale/missing timestamps up the chain), fall back to the direct cause.
        if (root.at != null && Number.isFinite(myFirst) && root.at > myFirst) {
          rootUpstream = cause.direct;
          const set = firingAfter.get(cause.direct);
          upstreamMetric = cause.kind === 'reachability' ? 'reachability'
            : (set && set.size ? [...set][0] : null);
        } else {
          rootUpstream = root.id;
          upstreamMetric = cause.kind === 'maintenance' ? null : (root.metric || null);
        }
      }

      let upstreamCaused = !!cause;
      let suppressedSince = state.suppressed_since;
      let escaped = false;
      if (upstreamCaused && wouldAlert) {
        if (!suppressedSince) suppressedSince = now;
        const sMs = Date.parse(suppressedSince);
        if (Number.isFinite(sMs) && nowMs - sMs >= MAX_SUPPRESS_MS) { escaped = true; upstreamCaused = false; }
      } else if (!upstreamCaused) {
        suppressedSince = null;
      }

      let shouldAlert = false;
      let alertReason = null;
      if (wouldAlert && !upstreamCaused) {
        shouldAlert = true;
        alertReason = escaped ? 'max-suppression-exceeded' : crossing ? 'threshold-crossed' : 'upstream-cleared';
      } else if (state.status === 'firing' && state.last_alert_sent_at && !upstreamCaused) {
        const lastMs = Date.parse(state.last_alert_sent_at);
        if (Number.isFinite(lastMs) && nowMs - lastMs >= RESEND_MS) { shouldAlert = true; alertReason = 'six-hour-resend'; }
      }

      const nextStatus = newCount >= config.consecutive_required ? 'firing' : state.status;
      let sentAt = state.last_alert_sent_at;
      let noteAt = state.suppress_note_at;

      if (shouldAlert) {
        const note = escaped
          ? `${buildMessage(node.id, metricType, rawValue, config)} (upstream ${rootUpstream} still implicated; alerting after max suppression window)`
          : null;
        // F20 (round 5): a max-suppression-escape alert still carries the
        // structured upstream_node / upstream_metric so the ticket side can
        // correlate it to the ongoing upstream incident, not just the prose note.
        const r = await sendEvent('alert', {
          nodeId: node.id, metricType, value: rawValue, config, detectedAt: firstOverAt, note,
          ...(escaped && rootUpstream ? { upstreamNode: rootUpstream, upstreamMetric } : {}),
        });
        if (r.ok) { sentAt = now; alerts.push(r.payload); log(`[evaluate] alert ${node.id}/${metricType} (${alertReason})`); }
        else deliveryFailures.push({ node_id: node.id, metric_type: metricType, kind: 'alert', reason: r.reason });
      } else if (upstreamCaused && wouldAlert) {
        // one "suppressed — upstream X" note, retried each pass until acknowledged
        if (!noteAt) {
          const r = await sendEvent('suppressed', {
            nodeId: node.id, metricType, value: rawValue, config, detectedAt: firstOverAt,
            upstreamNode: rootUpstream, upstreamMetric,
            note: `${node.id} ${metricType} degraded — suppressed, attributed to upstream ${rootUpstream}${upstreamMetric ? '/' + upstreamMetric : ''}`,
          });
          if (r.ok) noteAt = now;
          else deliveryFailures.push({ node_id: node.id, metric_type: metricType, kind: 'suppressed-note', reason: r.reason });
        }
        suppressed.push({ node_id: node.id, metric_type: metricType, upstream_node: rootUpstream, upstream_metric: upstreamMetric, direct_upstream: cause.direct, kind: cause.kind, note_delivered: !!noteAt });
      }

      // Commit this metric's state right after its send(s) — a crash mid-pass
      // then replays only this one metric, not the whole pass.
      const finalSuppressedSince = (upstreamCaused && wouldAlert) ? suppressedSince : null;
      setState(db, node.id, metricType, {
        consecutive_over_count: newCount,
        first_over_at:          firstOverAt,
        last_alert_sent_at:     sentAt,
        status:                 nextStatus,
        last_seen_at:           now,
        suppressed_since:        finalSuppressedSince,
        suppress_note_at:       finalSuppressedSince ? noteAt : null,
      });
    } catch (err) {
      console.error(`[evaluate] decide ${p.node && p.node.id}/${p.metricType} failed: ${err.message}`);
      nodeErrors.push({ node_id: p.node && p.node.id, phase: 'decide', error: err.message });
    }
  }

  // resolved webhooks are now sent inline in the phase-2 'clear' handler (F23),
  // gated on delivery. maintenance-suppressed still fires once here.
  for (const mn of maintNotes) {
    const r = await sendEvent('maintenance-suppressed', { nodeId: mn.node_id, metricType: mn.metric_type, detectedAt: now, note: `${mn.node_id} ${mn.metric_type} incident suppressed — node entered maintenance` });
    if (!r.ok) deliveryFailures.push({ node_id: mn.node_id, metric_type: mn.metric_type, kind: 'maintenance-suppressed', reason: r.reason });
  }

  // ---- phase 3: reset state for maintenance-skipped nodes (one transaction;
  // these do no sends, so batching is safe) ----
  if (maintenanceSkipped.length) {
    db.transaction(() => {
      const reset = db.prepare(
        "UPDATE threshold_state SET consecutive_over_count = 0, first_over_at = NULL, last_alert_sent_at = NULL, " +
        "status = 'ok', suppressed_since = NULL, suppress_note_at = NULL, last_seen_at = ? WHERE node_id = ?"
      );
      for (const id of maintenanceSkipped) reset.run(now, id);
    })();
  }

  // stale sweep — skipped entirely when discovery itself is degraded OR the
  // topology snapshot is stale (F11), so a node that's only temporarily
  // undiscovered keeps its live firing state.
  let staleCleared = 0;
  if (!sourcesDegraded && !topoStale) {
    const staleCutoff = new Date(nowMs - STALE_STATE_MS).toISOString();
    // A row that actually alerted and is now being swept means the node vanished
    // while it had an open incident — emit a resolved event so the ticket gets a
    // note and isn't left dangling.
    const orphaned = db.prepare(
      "SELECT node_id, metric_type, first_over_at FROM threshold_state " +
      "WHERE status = 'firing' AND last_alert_sent_at IS NOT NULL AND (last_seen_at IS NULL OR last_seen_at < ?)"
    ).all(staleCutoff);
    for (const o of orphaned) {
      const r = await sendEvent('resolved', {
        nodeId: o.node_id, metricType: o.metric_type, detectedAt: o.first_over_at || now,
        note: `${o.node_id} ${o.metric_type} no longer discovered — incident cleared`,
      });
      resolvedEvents.push({ node_id: o.node_id, metric_type: o.metric_type, reason: 'stale-cleared', delivered: r.ok });
      if (!r.ok) deliveryFailures.push({ node_id: o.node_id, metric_type: o.metric_type, kind: 'resolved', reason: r.reason });
    }
    staleCleared = db.prepare(
      "UPDATE threshold_state SET consecutive_over_count = 0, first_over_at = NULL, last_alert_sent_at = NULL, " +
      "status = 'ok', suppressed_since = NULL, suppress_note_at = NULL " +
      "WHERE status != 'ok' AND (last_seen_at IS NULL OR last_seen_at < ?)"
    ).run(staleCutoff).changes;
  }

  // F6 (round 5): a pass where webhook delivery is failing, or discovery is
  // degraded, or the topology is stale, is NOT a healthy pass. `degraded` is
  // what the cron wrapper keys the dead-man's-switch ping on — it must reflect
  // "alerting is not working", not just "a node threw".
  // V14 (round 6): a 429 (n8n flood guard / rate limit) is "throttled", not
  // "down" — it does not make the pass degraded.
  const realDeliveryFailures = deliveryFailures.filter(f => f.reason !== 'http-429');
  const degraded = nodeErrors.length > 0 || sourcesDegraded || topoStale || realDeliveryFailures.length > 0;
  // Quiet on a routine no-op pass (every 60s from cron); log only when something
  // happened or the run is degraded.
  const notable = alerts.length || suppressed.length || recoveries.length ||
    resolvedEvents.length || deliveryFailures.length || staleCleared || degraded;
  if (notable) {
    log(`[evaluate] ${nodes.length} nodes — ${alerts.length} alerts, ${suppressed.length} suppressed, ${recoveries.length} recoveries, ${resolvedEvents.length} resolved, ${maintenanceSkipped.length} maint, ${deliveryFailures.length} delivery-fail, ${staleCleared} stale-cleared${degraded ? ' [DEGRADED]' : ''}`);
  }
  return {
    evaluated: nodes.length,
    alerts, suppressed, recoveries,
    resolved:            resolvedEvents,
    delivery_failures:   deliveryFailures,
    maintenance_skipped: maintenanceSkipped,
    node_errors:         nodeErrors,
    stale_state_cleared: staleCleared,
    stale_sweep_skipped: sourcesDegraded || topoStale,
    topology_stale:      topoStale,
    delivery_failed:     realDeliveryFailures.length > 0,
    throttled:           deliveryFailures.some(f => f.reason === 'http-429'),
    degraded,
    last_completed_at:   new Date().toISOString(),
    timestamp:           now,
  };
}

let _evaluating = false;
let _lastCompletedMs = 0;

// Production entry point — fetches topology via the shared cache. Serialised:
// an overlapping call (long pass + next cron tick) is skipped, not run concurrently.
async function evaluateFromCache() {
  if (_evaluating) {
    // V14 (round 6): an occasional skipped tick is normal. But if the last pass
    // that actually COMPLETED is older than 2 cron intervals, evaluate() has
    // been wedged for minutes — flag it degraded so the dead-man ping is
    // withheld and Kuma fires.
    const staleMs = _lastCompletedMs ? Date.now() - _lastCompletedMs : Infinity;
    const wedged = staleMs > 2 * EVAL_INTERVAL_MS;
    if (wedged) console.error(`[evaluate] wedged — no completed pass for ${Math.round(staleMs / 1000)}s`);
    else console.warn('[evaluate] previous pass still running — skipping this tick');
    return { skipped: true, degraded: wedged, stale_ms: Number.isFinite(staleMs) ? staleMs : null, timestamp: new Date().toISOString() };
  }
  _evaluating = true;
  try {
    const { getTopology } = require('./cache');
    const topology = await getTopology();
    const result = await evaluate(topology);
    _lastCompletedMs = Date.now();
    return result;
  } finally {
    _evaluating = false;
  }
}

module.exports = {
  evaluate, evaluateFromCache, resetDb, _getDb: getDb, DEFAULTS, extractMetrics,
  listMaintenance, setMaintenance, clearMaintenance, listFiringStates, recordSourceHealth,
  MaintenanceValidationError, DEP_EDGE_DIRECTION,
};
