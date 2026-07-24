'use strict';

// Must set DB path before requiring evaluate so getDb() uses :memory:
process.env.THRESHOLD_DB_PATH = ':memory:';

const { test, describe, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { evaluate, resetDb, _getDb, DEFAULTS, extractMetrics } = require('../src/evaluate');

// ---------------------------------------------------------------------------
// Webhook capture server — starts once, records every POST for inspection
// ---------------------------------------------------------------------------
let capturePort;
let captured = [];

const captureServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    captured.push({ headers: { ...req.headers }, body: JSON.parse(body) });
    res.writeHead(200).end('ok');
  });
});

before(() => new Promise(resolve => captureServer.listen(0, () => {
  capturePort = captureServer.address().port;
  process.env.N8N_THRESHOLD_WEBHOOK_URL = `http://127.0.0.1:${capturePort}`;
  process.env.ALERT_WEBHOOK_SECRET = 'test-secret-abc';
  resolve();
})));

after(() => new Promise(resolve => captureServer.close(resolve)));

beforeEach(() => {
  captured = [];
  resetDb(); // fresh in-memory SQLite for every test
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function topo(...nodes) {
  return { nodes };
}

function proxmoxNode(overrides = {}) {
  return {
    id: 'venti', name: 'Venti', type: 'proxmox-host', status: 'healthy',
    meta: { cpu: 0.1, mem: 2e9, maxmem: 16e9, disk: 50e9, maxdisk: 800e9 },
    ...overrides,
  };
}

function haNode(overrides = {}) {
  return {
    id: 'heizou', name: 'Heizou', type: 'host', status: 'healthy',
    meta: { haMetrics: true, cpuPercent: 10, memPercent: 30, diskPercent: 20 },
    ...overrides,
  };
}

function noelleNode(overrides = {}) {
  return {
    id: 'noelle', name: 'Noelle', type: 'host', status: 'healthy',
    meta: { haMetrics: true, cpuPercent: 10, memMiB: 4000, diskGiB: 50 },
    ...overrides,
  };
}

function k8sVmNode(overrides = {}) {
  return {
    id: 'navia', name: 'Navia', type: 'vm', status: 'healthy',
    meta: {
      // Proxmox values — low, should NOT be used when k8sNodeMetrics is set
      cpu: 0.05, mem: 1e9, maxmem: 16e9,
      // Real node-level metrics
      k8sNodeMetrics: true,
      k8sNodeCpuM: 3600, k8sNodeCpuTotalM: 4000,
      k8sNodeMemMiB: 15000, k8sNodeMemTotalMiB: 16384,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Threshold streak — alert fires at exactly consecutive_required
// ---------------------------------------------------------------------------
describe('threshold streak', () => {
  test('no alert before consecutive_required', async () => {
    const node = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 14e9, maxmem: 16e9, disk: 0, maxdisk: 1 } });
    // cpu = 95% > 90%, consecutive_required = 3
    await evaluate(topo(node)); // count 1
    await evaluate(topo(node)); // count 2
    assert.equal(captured.length, 0, 'no alert before count reaches 3');
  });

  test('alert fires on exactly consecutive_required tick', async () => {
    const node = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 14e9, maxmem: 16e9, disk: 0, maxdisk: 1 } });
    await evaluate(topo(node)); // 1
    await evaluate(topo(node)); // 2
    await evaluate(topo(node)); // 3 — should fire
    assert.equal(captured.length, 1, 'exactly one alert at count=3');
    assert.equal(captured[0].body.status, 'firing');
    assert.equal(captured[0].body.source, 'hexmap-watcher');
  });

  test('no repeat alert on next tick after firing (within 6h)', async () => {
    const node = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 14e9, maxmem: 16e9, disk: 0, maxdisk: 1 } });
    await evaluate(topo(node)); // 1
    await evaluate(topo(node)); // 2
    await evaluate(topo(node)); // 3 — fires
    await evaluate(topo(node)); // 4 — must NOT re-fire (< 6h)
    assert.equal(captured.length, 1, 'still only one alert after 4th consecutive tick');
  });
});

// ---------------------------------------------------------------------------
// 2. Recovery reset — streak resets, no recovery webhook
// ---------------------------------------------------------------------------
describe('recovery reset', () => {
  test('count resets to 0 on recovery', async () => {
    const over = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    const ok   = proxmoxNode({ meta: { cpu: 0.05, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(over)); // count 1
    await evaluate(topo(over)); // count 2
    await evaluate(topo(ok));   // recovery — reset

    const db = _getDb();
    const row = db.prepare("SELECT * FROM threshold_state WHERE node_id = 'venti' AND metric_type = 'cpu'").get();
    assert.equal(row.consecutive_over_count, 0);
    assert.equal(row.status, 'ok');
    assert.equal(row.first_over_at, null);
  });

  test('no recovery webhook fired', async () => {
    const over = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    const ok   = proxmoxNode({ meta: { cpu: 0.05, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(over)); // 1
    await evaluate(topo(over)); // 2
    await evaluate(topo(over)); // 3 — fires alert
    await evaluate(topo(ok));   // recovery
    assert.equal(captured.length, 1, 'only the firing alert; no recovery webhook');
  });

  test('new streak starts from zero after recovery', async () => {
    const over = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    const ok   = proxmoxNode({ meta: { cpu: 0.05, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(over)); // 1
    await evaluate(topo(over)); // 2
    await evaluate(topo(over)); // 3 — fires
    await evaluate(topo(ok));   // recovery
    await evaluate(topo(over)); // new streak: count 1
    await evaluate(topo(over)); // count 2
    assert.equal(captured.length, 1, 'no second alert — new streak not yet at 3');
    await evaluate(topo(over)); // count 3 — fires again
    assert.equal(captured.length, 2, 'second alert after full new streak');
  });
});

// ---------------------------------------------------------------------------
// 3. Six-hour re-alert
// ---------------------------------------------------------------------------
describe('six-hour resend', () => {
  test('re-alerts after 6h, not before', async () => {
    const node = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(node)); // 1
    await evaluate(topo(node)); // 2
    await evaluate(topo(node)); // 3 — first alert

    assert.equal(captured.length, 1);

    // Simulate 7 hours passing by back-dating last_alert_sent_at in the DB
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const db = _getDb();
    db.prepare("UPDATE threshold_state SET last_alert_sent_at = ? WHERE node_id = 'venti' AND metric_type = 'cpu'").run(sevenHoursAgo);

    await evaluate(topo(node)); // should re-alert
    assert.equal(captured.length, 2, 're-alert fired after 6h window');
    assert.equal(captured[1].body.status, 'firing');
    assert.equal(captured[1].body.source, 'hexmap-watcher');
  });
});

// ---------------------------------------------------------------------------
// 4. enabled=false skips node/metric
// ---------------------------------------------------------------------------
describe('enabled=false', () => {
  test('no alert when config row has enabled=0', async () => {
    const db = _getDb();
    db.prepare(`
      INSERT INTO threshold_config (node_id, metric_type, enabled, threshold_value, consecutive_required)
      VALUES ('venti', 'cpu', 0, 90, 1)
    `).run();

    const node = proxmoxNode({ meta: { cpu: 0.99, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(node)); // cpu 99% — would fire immediately with consecutive_required=1
    await evaluate(topo(node));
    assert.equal(captured.length, 0, 'no alert when enabled=0');
  });
});

// ---------------------------------------------------------------------------
// 5. Per-node config override
// ---------------------------------------------------------------------------
describe('per-node override', () => {
  test('custom threshold and consecutive_required respected', async () => {
    const db = _getDb();
    // Override venti/cpu: threshold=70, consecutive=2 (lower threshold, fewer ticks needed)
    db.prepare(`
      INSERT INTO threshold_config (node_id, metric_type, enabled, threshold_value, consecutive_required)
      VALUES ('venti', 'cpu', 1, 70, 2)
    `).run();

    // cpu at 75% — above custom 70% threshold
    const node = proxmoxNode({ meta: { cpu: 0.75, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(node)); // count 1 — no alert (need 2)
    assert.equal(captured.length, 0);
    await evaluate(topo(node)); // count 2 — alert
    assert.equal(captured.length, 1, 'alert at count=2 per custom consecutive_required');

    // cpu at 65% — below custom 70% threshold (but above global 90%): should NOT alert with global defaults
    // This confirms the override is in effect, not the global default
    resetDb();
    captured = [];
    // Fresh DB — use global defaults: threshold=90, consecutive=3
    const okNode = proxmoxNode({ meta: { cpu: 0.75, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(okNode)); // 75% < 90% global threshold — no violation
    await evaluate(topo(okNode));
    await evaluate(topo(okNode));
    assert.equal(captured.length, 0, '75% does not violate global 90% threshold');
  });
});

// ---------------------------------------------------------------------------
// 6. Outbound payload and header
// ---------------------------------------------------------------------------
describe('outbound webhook contract', () => {
  test('correct payload shape and X-Alert-Webhook-Secret header', async () => {
    const node = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(node)); // 1
    await evaluate(topo(node)); // 2
    await evaluate(topo(node)); // 3 — fires

    assert.equal(captured.length, 1);
    const { headers, body } = captured[0];

    // Header
    assert.equal(headers['x-alert-webhook-secret'], 'test-secret-abc');
    assert.equal(headers['content-type'], 'application/json');

    // Body shape per AI IT Agents contract
    assert.equal(body.source, 'hexmap-watcher');
    assert.equal(body.hexmap_node, 'venti');
    assert.equal(body.status, 'firing');
    assert.ok(typeof body.message === 'string' && body.message.length > 0, 'message is non-empty string');
    assert.ok(body.detected_at, 'detected_at present');
    assert.ok(!body.nodeType,  'no legacy nodeType field');
    assert.ok(!body.metric,    'no legacy metric field');
    assert.ok(!body.threshold, 'no legacy threshold field');
  });

  test('detected_at is set to first_over_at, not re-alert time', async () => {
    const node = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(node)); // 1
    await evaluate(topo(node)); // 2
    const before = new Date().toISOString();
    await evaluate(topo(node)); // 3 — fires

    // Back-date and re-alert
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const db = _getDb();
    // Also back-date first_over_at to simulate it was set earlier
    db.prepare("UPDATE threshold_state SET last_alert_sent_at = ?, first_over_at = ? WHERE node_id = 'venti' AND metric_type = 'cpu'")
      .run(sevenHoursAgo, sevenHoursAgo);

    await evaluate(topo(node)); // re-alert
    assert.equal(captured.length, 2);
    // Re-alert detected_at should equal first_over_at (the original detection), not now
    assert.equal(captured[1].body.detected_at, sevenHoursAgo,
      'detected_at on re-alert uses original first_over_at');
  });
});

// ---------------------------------------------------------------------------
// 7. Noelle haMetrics handling
// ---------------------------------------------------------------------------
describe('noelle haMetrics', () => {
  test('evaluates percent fields when present', async () => {
    // noelle with memPercent + diskPercent from HA percent entities
    const node = noelleNode({
      meta: { haMetrics: true, cpuPercent: 95, memPercent: 92, diskPercent: 88, memMiB: 7500, diskGiB: 400 },
    });
    await evaluate(topo(node)); // 1
    await evaluate(topo(node)); // 2
    await evaluate(topo(node)); // 3 — cpu + mem fire (disk needs 2 so it also fires)

    const nodes = captured.map(c => `${c.body.hexmap_node}/${c.body.message}`);
    const cpuAlert  = captured.some(c => c.body.message.includes('cpu'));
    const memAlert  = captured.some(c => c.body.message.includes('mem'));
    const diskAlert = captured.some(c => c.body.message.includes('disk'));
    assert.ok(cpuAlert,  'cpu alert fired for noelle');
    assert.ok(memAlert,  'mem alert fired for noelle');
    assert.ok(diskAlert, 'disk alert fired for noelle — disk at 88% >= 85% threshold for 2 ticks');
  });

  test('skips mem/disk when only raw MiB/GiB present (no percent)', async () => {
    // noelle without percent entities — only raw values
    const node = noelleNode({
      meta: { haMetrics: true, cpuPercent: 10, memMiB: 99999, diskGiB: 99999 },
    });
    await evaluate(topo(node));
    await evaluate(topo(node));
    await evaluate(topo(node));
    assert.equal(captured.length, 0, 'no alert — raw MiB/GiB without percent means mem/disk not evaluable');
  });

  test('extractMetrics produces correct fields for noelle with percent', () => {
    const node = noelleNode({
      meta: { haMetrics: true, cpuPercent: 55, memPercent: 60, diskPercent: 70, memMiB: 4000, diskGiB: 50 },
    });
    const m = extractMetrics(node);
    assert.equal(m.cpu,  55);
    assert.equal(m.mem,  60);
    assert.equal(m.disk, 70);
  });

  test('extractMetrics omits mem/disk when percent absent', () => {
    const node = noelleNode();  // no memPercent/diskPercent
    const m = extractMetrics(node);
    assert.equal(m.cpu, 10);
    assert.ok(!('mem' in m),  'no mem field — no memPercent');
    assert.ok(!('disk' in m), 'no disk field — no diskPercent');
  });
});

// ---------------------------------------------------------------------------
// 8. navia/chiori/shenhe use k8s node-level memory, not Proxmox allocation
// ---------------------------------------------------------------------------
describe('navia/chiori/shenhe node-level metrics override', () => {
  test('uses k8sNodeMetrics branch, not Proxmox mem/maxmem', async () => {
    // Proxmox says 6% mem use — would never trigger
    // k8s node metrics say 93% — should trigger at count=3
    const node = k8sVmNode({
      meta: {
        // Proxmox low values
        cpu: 0.06, mem: 1e9, maxmem: 16e9,
        // k8s node-level high values: 93.75% memory
        k8sNodeMetrics: true,
        k8sNodeMemMiB: 15360, k8sNodeMemTotalMiB: 16384,
        k8sNodeCpuM: 200,     k8sNodeCpuTotalM: 4000,
      },
    });
    await evaluate(topo(node)); // 1
    await evaluate(topo(node)); // 2
    await evaluate(topo(node)); // 3 — should fire on mem (93.75% > 90%)
    const memAlert = captured.some(c => c.body.message.includes('mem'));
    assert.ok(memAlert, 'mem alert fired using k8s node memory, not Proxmox allocation');
  });

  test('Proxmox mem alone would NOT trigger (confirming override path used)', () => {
    const node = k8sVmNode({
      meta: {
        cpu: 0.06, mem: 1e9, maxmem: 16e9,        // ~6% — way under 90%
        k8sNodeMetrics: true,
        k8sNodeMemMiB: 15360, k8sNodeMemTotalMiB: 16384,
        k8sNodeCpuM: 200,     k8sNodeCpuTotalM: 4000,
      },
    });
    const m = extractMetrics(node);
    // Proxmox mem = 1e9/16e9 = 6.25% — NOT what extractMetrics returns when k8sNodeMetrics=true
    assert.ok(m.mem > 90, `extractMetrics returns k8s mem ${m.mem.toFixed(1)}% not Proxmox 6.25%`);
  });

  test('disk falls back to Proxmox when k8sNodeMetrics set (no k8s disk metric)', () => {
    const node = {
      id: 'navia', type: 'vm', status: 'healthy',
      meta: {
        k8sNodeMetrics: true,
        k8sNodeMemMiB: 1000, k8sNodeMemTotalMiB: 16384,
        k8sNodeCpuM: 100,    k8sNodeCpuTotalM: 4000,
        disk: 700e9, maxdisk: 800e9,  // 87.5% — above 85% disk threshold
      },
    };
    const m = extractMetrics(node);
    assert.ok('disk' in m, 'disk present via Proxmox fallback');
    assert.ok(m.disk > 85, `disk ${m.disk.toFixed(1)}% from Proxmox fallback`);
  });
});
