const path = require('path');

const DB_PATH = process.env.THRESHOLD_DB_PATH || '/data/threshold.db';
const RESEND_MS = 6 * 60 * 60 * 1000;

// Global defaults — threshold_config rows override per node+metric_type.
const DEFAULTS = {
  cpu:          { threshold_value: 90,   consecutive_required: 3 },
  mem:          { threshold_value: 90,   consecutive_required: 3 },
  disk:         { threshold_value: 85,   consecutive_required: 2 },
  reachability: { threshold_value: null, consecutive_required: 2 },
};

let _db = null;

function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  if (DB_PATH !== ':memory:') {
    require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  _db = new Database(DB_PATH);
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
      PRIMARY KEY (node_id, metric_type)
    );
  `);
  return _db;
}

// Close and null the db — call between tests to get a clean in-memory db.
function resetDb() {
  if (_db) { try { _db.close(); } catch {} }
  _db = null;
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
    'SELECT consecutive_over_count, first_over_at, last_alert_sent_at, status FROM threshold_state WHERE node_id = ? AND metric_type = ?'
  ).get(nodeId, metricType)
    || { consecutive_over_count: 0, first_over_at: null, last_alert_sent_at: null, status: 'ok' };
}

function setState(db, nodeId, metricType, fields) {
  db.prepare(`
    INSERT INTO threshold_state (node_id, metric_type, consecutive_over_count, first_over_at, last_alert_sent_at, status)
    VALUES (@nodeId, @metricType, @consecutive_over_count, @first_over_at, @last_alert_sent_at, @status)
    ON CONFLICT(node_id, metric_type) DO UPDATE SET
      consecutive_over_count = excluded.consecutive_over_count,
      first_over_at          = excluded.first_over_at,
      last_alert_sent_at     = excluded.last_alert_sent_at,
      status                 = excluded.status
  `).run({ nodeId, metricType, ...fields });
}

function buildMessage(nodeId, metricType, value, config) {
  if (metricType === 'reachability') {
    return `${nodeId} reachability critical for ${config.consecutive_required} consecutive evaluations`;
  }
  return `${nodeId} ${metricType} at ${Math.round(value * 10) / 10}% exceeds ${config.threshold_value}% threshold for ${config.consecutive_required} consecutive evaluations`;
}

async function sendAlert(nodeId, metricType, value, config, detectedAt) {
  const url = process.env.N8N_THRESHOLD_WEBHOOK_URL;
  const secret = process.env.ALERT_WEBHOOK_SECRET;
  if (!url) return null;

  const payload = {
    source:       'hexmap-watcher',
    hexmap_node:  nodeId,
    status:       'firing',
    message:      buildMessage(nodeId, metricType, value, config),
    detected_at:  detectedAt,
  };

  try {
    const fetch = require('node-fetch');
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Alert-Webhook-Secret'] = secret;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[evaluate] alert sent ${nodeId}/${metricType}: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[evaluate] webhook failed ${nodeId}/${metricType}:`, err.message);
  }

  return payload;
}

// Extract evaluatable metrics from a topology node.
// Returns object with present fields only — absent = no data for that metric on this node.
function extractMetrics(node) {
  const meta = node.meta || {};
  const m = {};

  // Reachability — every node
  m.reachability = node.status === 'critical' || node.status === 'unknown';

  if (meta.k8sNodeMetrics) {
    // navia/chiori/shenhe: use real k8s node-level metrics, not Proxmox allocation
    if (meta.k8sNodeCpuM != null && meta.k8sNodeCpuTotalM > 0)
      m.cpu = (meta.k8sNodeCpuM / meta.k8sNodeCpuTotalM) * 100;
    if (meta.k8sNodeMemMiB != null && meta.k8sNodeMemTotalMiB > 0)
      m.mem = (meta.k8sNodeMemMiB / meta.k8sNodeMemTotalMiB) * 100;
    // Disk not in k8s node metrics — fall through to Proxmox disk
    if (meta.disk != null && meta.maxdisk > 0)
      m.disk = (meta.disk / meta.maxdisk) * 100;
  } else if (meta.haMetrics) {
    // heizou, kazuha: percent-based. noelle: cpuPercent always + memPercent/diskPercent when HA exposes them.
    if (meta.cpuPercent  != null) m.cpu  = meta.cpuPercent;
    if (meta.memPercent  != null) m.mem  = meta.memPercent;
    if (meta.diskPercent != null) m.disk = meta.diskPercent;
  } else if (meta.k8sMetrics) {
    // k3s service pods: usage vs declared limits
    if (meta.cpuM   != null && meta.cpuLimitM   > 0) m.cpu = (meta.cpuM   / meta.cpuLimitM)   * 100;
    if (meta.memMiB != null && meta.memLimitMiB > 0) m.mem = (meta.memMiB / meta.memLimitMiB) * 100;
  } else if (node.type === 'proxmox-host' || node.type === 'lxc' || node.type === 'vm') {
    if (meta.cpu  != null)                     m.cpu  = meta.cpu * 100;
    if (meta.mem  != null && meta.maxmem  > 0) m.mem  = (meta.mem  / meta.maxmem)  * 100;
    if (meta.disk != null && meta.maxdisk > 0) m.disk = (meta.disk / meta.maxdisk) * 100;
  }

  return m;
}

// Core evaluation — accepts a topology object directly.
// Tests call this with synthesised topology; production uses evaluateFromCache().
async function evaluate(topology) {
  const db = getDb();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const alerts = [];
  const recoveries = [];

  for (const node of (topology.nodes || [])) {
    if (!node.id) continue;

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

      if (violated) {
        const newCount = state.consecutive_over_count + 1;
        const firstOverAt = state.first_over_at || now;

        let shouldAlert = false;
        if (newCount === config.consecutive_required) {
          // Initial threshold crossing
          shouldAlert = true;
        } else if (state.status === 'firing' && state.last_alert_sent_at) {
          // Persistent violation — re-alert after 6 hours
          const lastMs = new Date(state.last_alert_sent_at).getTime();
          if (nowMs - lastMs >= RESEND_MS) shouldAlert = true;
        }

        setState(db, node.id, metricType, {
          consecutive_over_count: newCount,
          first_over_at:          firstOverAt,
          last_alert_sent_at:     shouldAlert ? now : state.last_alert_sent_at,
          status:                 newCount >= config.consecutive_required ? 'firing' : state.status,
        });

        if (shouldAlert) {
          const payload = await sendAlert(node.id, metricType, rawValue, config, firstOverAt);
          if (payload) alerts.push(payload);
        }
      } else {
        // Recovery — reset streak, no webhook
        if (state.consecutive_over_count > 0 || state.status === 'firing') {
          setState(db, node.id, metricType, {
            consecutive_over_count: 0,
            first_over_at:          null,
            last_alert_sent_at:     null,
            status:                 'ok',
          });
          recoveries.push({ nodeId: node.id, metricType, timestamp: now });
        }
      }
    }
  }

  console.log(`[evaluate] ${topology.nodes?.length || 0} nodes — ${alerts.length} alerts, ${recoveries.length} recoveries`);
  return { evaluated: topology.nodes?.length || 0, alerts, recoveries, timestamp: now };
}

// Production entry point — fetches and refreshes topology via shared cache.
// /evaluate endpoint calls this; no HTTP call to /topology.
async function evaluateFromCache() {
  const { getTopology } = require('./cache');
  const topology = await getTopology();
  return evaluate(topology);
}

module.exports = { evaluate, evaluateFromCache, resetDb, _getDb: getDb, DEFAULTS, extractMetrics };
