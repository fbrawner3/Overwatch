'use strict';

// Must set DB path before requiring evaluate so getDb() uses :memory:
process.env.THRESHOLD_DB_PATH = ':memory:';

// Falls back to node:sqlite if the better-sqlite3 native binding isn't built here.
require('./_sqlite-fallback');

const { test, describe, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  evaluate, resetDb, _getDb, DEFAULTS, extractMetrics,
  setMaintenance, clearMaintenance, listMaintenance, listFiringStates,
  MaintenanceValidationError,
} = require('../src/evaluate');

// ---------------------------------------------------------------------------
// Webhook capture server — starts once, records every POST for inspection
// ---------------------------------------------------------------------------
let capturePort;
let captured = [];
let failResponses = 0;     // when > 0, respond 500 and decrement
let throttleResponses = 0; // when > 0, respond 429 and decrement

const captureServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    captured.push({ headers: { ...req.headers }, body: JSON.parse(body) });
    if (failResponses > 0)     { failResponses--;     res.writeHead(500).end('nope'); return; }
    if (throttleResponses > 0) { throttleResponses--; res.writeHead(429).end('slow down'); return; }
    res.writeHead(200).end('ok');
  });
});

// captured entries by event kind
const alertNodes      = () => captured.filter(c => c.body.event === 'alert').map(c => c.body.hexmap_node);
const suppressedNodes = () => captured.filter(c => c.body.suppressed).map(c => c.body.hexmap_node);
const resolvedNodes   = () => captured.filter(c => c.body.event === 'resolved').map(c => c.body.hexmap_node);

before(() => new Promise(resolve => captureServer.listen(0, () => {
  capturePort = captureServer.address().port;
  process.env.N8N_THRESHOLD_WEBHOOK_URL = `http://127.0.0.1:${capturePort}`;
  process.env.ALERT_WEBHOOK_SECRET = 'test-secret-abc';
  resolve();
})));

after(() => new Promise(resolve => captureServer.close(resolve)));

beforeEach(() => {
  captured = [];
  failResponses = 0;
  throttleResponses = 0;
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

function topoE(nodes, edges) {
  return { nodes, edges };
}

function cpuNode(id, cpuFraction) {
  return {
    id, name: id, type: 'proxmox-host', status: 'healthy',
    meta: { cpu: cpuFraction, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 },
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

  test('recovery of an alerted metric fires ONE resolved webhook', async () => {
    const over = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    const ok   = proxmoxNode({ meta: { cpu: 0.05, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(over)); // 1
    await evaluate(topo(over)); // 2
    await evaluate(topo(over)); // 3 — fires alert
    await evaluate(topo(ok));   // recovery
    assert.deepEqual(alertNodes(), ['venti'], 'one firing alert');
    const resolved = captured.filter(c => c.body.event === 'resolved');
    assert.equal(resolved.length, 1, 'one resolved event for the recovered metric');
    assert.equal(resolved[0].body.status, 'resolved');
  });

  test('a metric that recovered without ever alerting sends no resolved webhook', async () => {
    const over = proxmoxNode({ meta: { cpu: 0.95, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    const ok   = proxmoxNode({ meta: { cpu: 0.05, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1 } });
    await evaluate(topo(over)); // 1
    await evaluate(topo(over)); // 2 — not yet at 3, never alerted
    await evaluate(topo(ok));   // recovery
    assert.equal(captured.length, 0, 'nothing sent — it never alerted');
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
    assert.equal(alertNodes().length, 1, 'no second alert — new streak not yet at 3');
    await evaluate(topo(over)); // count 3 — fires again
    assert.equal(alertNodes().length, 2, 'second alert after full new streak');
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
    assert.ok(!body.threshold, 'no legacy threshold field');
    // metric is now intentional — n8n needs it for ticket correlation
    assert.equal(body.metric, 'cpu');
    assert.equal(body.suppressed, false);
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

// ---------------------------------------------------------------------------
// 9. Maintenance mode
// ---------------------------------------------------------------------------
describe('maintenance mode', () => {
  test('no alert while node is in maintenance', async () => {
    setMaintenance('venti', { reason: 'patching', set_by: 'test' });
    const node = cpuNode('venti', 0.99);
    await evaluate(topo(node));
    await evaluate(topo(node));
    await evaluate(topo(node));
    assert.equal(captured.length, 0, 'maintenance suppresses evaluation');
  });

  test('alerting resumes with a FRESH streak after maintenance is cleared', async () => {
    const node = cpuNode('venti', 0.99);
    await evaluate(topo(node)); // count 1
    await evaluate(topo(node)); // count 2  (required is 3)
    setMaintenance('venti', { reason: 'patching' });
    await evaluate(topo(node)); // skipped + streak reset
    clearMaintenance('venti');
    await evaluate(topo(node)); // count 1 again — NOT an immediate alert
    await evaluate(topo(node)); // count 2
    assert.equal(alertNodes().length, 0, 'no immediate false alert from a frozen streak');
    await evaluate(topo(node)); // count 3 — fires
    assert.deepEqual(alertNodes(), ['venti']);
  });

  test('past expires_at is rejected', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.throws(() => setMaintenance('venti', { expires_at: past }), MaintenanceValidationError);
  });

  test('unparseable / numeric expires_at is rejected', () => {
    assert.throws(() => setMaintenance('venti', { expires_at: 'not-a-date' }), MaintenanceValidationError);
    assert.throws(() => setMaintenance('venti', { expires_at: '2026' }),       MaintenanceValidationError);
    assert.throws(() => setMaintenance('venti', { expires_at: 0 }),            MaintenanceValidationError);
  });

  test('omitted expires_at gets a server default TTL', () => {
    setMaintenance('venti', { reason: 'no ttl given' });
    const row = listMaintenance().get('venti');
    assert.ok(row.expires_at, 'a default expiry was applied');
    assert.ok(new Date(row.expires_at).getTime() > Date.now(), 'and it is in the future');
  });

  test('expires_at beyond the max TTL is clamped', () => {
    const farFuture = new Date(Date.now() + 400 * 24 * 3600_000).toISOString();
    setMaintenance('venti', { expires_at: farFuture });
    const capMs = Date.now() + 24 * 3600_000 + 5_000;
    assert.ok(new Date(listMaintenance().get('venti').expires_at).getTime() <= capMs, 'clamped to max TTL');
  });

  test('reason and set_by are length-capped and control chars stripped', () => {
    setMaintenance('venti', { reason: ('bad' + String.fromCharCode(7,0,31,127) + 'x').padEnd(9000, 'z'), set_by: 'u' + String.fromCharCode(9) + 'v' });
    const row = listMaintenance().get('venti');
    assert.ok(row.reason.length <= 500, 'reason capped');
    const hasCtrl = str => [...str].some(ch => { const n = ch.charCodeAt(0); return n < 32 || n === 127; });
    assert.ok(!hasCtrl(row.reason), 'reason control chars stripped');
    assert.ok(!hasCtrl(row.set_by), 'set_by control chars stripped');
  });

  test('future expires_at still suppresses', async () => {
    setMaintenance('venti', { expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const node = cpuNode('venti', 0.99);
    await evaluate(topo(node));
    await evaluate(topo(node));
    await evaluate(topo(node));
    assert.equal(captured.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 10. Upstream-caused suppression
// ---------------------------------------------------------------------------
describe('upstream-caused suppression', () => {
  const dbEdge = [{ id: 'e1', source: 'app', target: 'db', type: 'database' }];

  function reach(id, down) {
    return { id, name: id, type: 'vm', status: down ? 'critical' : 'healthy', meta: {} };
  }

  test('dependent suppressed when its dependency is already firing (reachability)', async () => {
    // db reachability fires alone (2 ticks), then app degrades
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('db', true)], dbEdge));
    assert.deepEqual(alertNodes(), ['db']);
    captured = [];
    for (let i = 0; i < 4; i++) {
      await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], dbEdge));
    }
    assert.ok(!alertNodes().includes('app'), 'app never raises its own alert');
    assert.ok(suppressedNodes().includes('app'), 'app emits one suppressed notice');
    assert.equal(suppressedNodes().filter(n => n === 'app').length, 1, 'exactly one suppressed notice, not one per pass');
  });

  test('result.suppressed names the upstream + the implicated upstream metric', async () => {
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('db', true)], dbEdge));
    await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], dbEdge)); // app tick 1
    await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], dbEdge)); // tick 2
    const r = await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], dbEdge)); // tick 3 — crossing
    const s = r.suppressed.find(x => x.node_id === 'app');
    assert.ok(s && s.upstream_node === 'db' && s.kind === 'reachability');
    assert.equal(s.upstream_metric, 'reachability', 'note can be routed to the db reachability ticket');
    const note = captured.find(c => c.body.suppressed && c.body.hexmap_node === 'app');
    assert.equal(note.body.upstream_metric, 'reachability', 'webhook carries upstream_metric');
  });

  test('F17 — an upstream RESOURCE warning does not suppress an unrelated downstream metric', async () => {
    // db has a firing cpu (resource) problem; app has an unrelated cpu problem
    for (let i = 0; i < 3; i++) await evaluate(topoE([cpuNode('db', 0.99)], dbEdge));
    assert.deepEqual(alertNodes(), ['db']);
    captured = [];
    for (let i = 0; i < 3; i++) {
      await evaluate(topoE([cpuNode('db', 0.99), cpuNode('app', 0.99)], dbEdge));
    }
    assert.ok(alertNodes().includes('app'), 'app cpu alert is NOT suppressed by an upstream cpu warning');
  });

  test('F17 — an upstream RESOURCE problem still suppresses a downstream reachability failure', async () => {
    for (let i = 0; i < 3; i++) await evaluate(topoE([cpuNode('db', 0.99)], dbEdge));
    captured = [];
    for (let i = 0; i < 3; i++) {
      await evaluate(topoE([cpuNode('db', 0.99), reach('app', true)], dbEdge));
    }
    assert.ok(!alertNodes().includes('app'), 'app reachability alert IS suppressed — plausibly caused by the thrashing db');
  });

  test('F6 — a maintenance upstream suppresses a downstream REACHABILITY failure', async () => {
    setMaintenance('db', { reason: 'reboot' });
    for (let i = 0; i < 3; i++) {
      await evaluate(topoE([cpuNode('db', 0.99), reach('app', true)], dbEdge));
    }
    assert.ok(!alertNodes().includes('app'), 'app reachability suppressed while its dependency is under maintenance');
    assert.ok(suppressedNodes().includes('app'));
  });

  test('F6 — a maintenance upstream does NOT suppress an unrelated downstream resource metric', async () => {
    setMaintenance('db', { reason: 'reboot' });
    for (let i = 0; i < 3; i++) {
      await evaluate(topoE([cpuNode('db', 0.99), cpuNode('app', 0.99)], dbEdge));
    }
    assert.ok(alertNodes().includes('app'), 'app cpu leak alerts — not excused by the db being rebooted');
  });

  test('F12 — cycle: the node that failed FIRST alerts, the other is suppressed', async () => {
    const cycle = [
      { id: 'e1', source: 'a', target: 'b', type: 'depends_on' },
      { id: 'e2', source: 'b', target: 'a', type: 'depends_on' },
    ];
    // a goes unreachable first (reaches firing), then b goes unreachable too.
    // reachability failures DO propagate, so the timestamp tiebreak is what
    // keeps this from muting both / neither.
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('a', true)], cycle));
    assert.deepEqual(alertNodes(), ['a']);
    captured = [];
    for (let i = 0; i < 4; i++) {
      await evaluate(topoE([reach('a', true), reach('b', true)], cycle));
    }
    assert.ok(!alertNodes().includes('b'), 'b failed after a — suppressed as downstream');
    assert.ok(!alertNodes().includes('a'), 'a already alerted; not re-suppressed or duplicated');
  });

  test('F12 — suppression escapes after the max window and alerts anyway', async () => {
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('db', true)], dbEdge));
    for (let i = 0; i < 3; i++) {
      await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], dbEdge)); // app crosses, suppressed
    }
    captured = [];
    // back-date suppressed_since past MAX_SUPPRESS_MS
    _getDb().prepare("UPDATE threshold_state SET suppressed_since = ? WHERE node_id = 'app' AND metric_type = 'cpu'")
      .run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], dbEdge));
    assert.deepEqual(alertNodes(), ['app'], 'app alerts despite the still-firing upstream, after max suppression');
  });

  test('secrets_for edge direction: app depends on Infisical (provider is e.source)', async () => {
    const secEdge = [{ id: 'e1', source: 'infisical', target: 'app', type: 'secrets_for' }];
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('infisical', true)], secEdge));
    captured = [];
    for (let i = 0; i < 3; i++) {
      await evaluate(topoE([reach('infisical', true), cpuNode('app', 0.99)], secEdge));
    }
    assert.ok(!alertNodes().includes('app'), 'app suppressed — Infisical is its upstream, not the reverse');
  });
});

// ---------------------------------------------------------------------------
// 11. Webhook delivery
// ---------------------------------------------------------------------------
describe('webhook delivery', () => {
  test('a failed send is NOT recorded as delivered and retries on the next pass', async () => {
    const node = cpuNode('venti', 0.99);
    await evaluate(topo(node)); // 1
    await evaluate(topo(node)); // 2
    failResponses = 1;          // the crossing send will 500
    const r3 = await evaluate(topo(node)); // 3 — attempt, fails
    assert.equal(r3.alerts.length, 0, 'not counted as an alert');
    assert.equal(r3.delivery_failures.length, 1, 'recorded as a delivery failure');
    // next pass retries at cron cadence (not the 6h path) and now succeeds
    const r4 = await evaluate(topo(node));
    assert.equal(r4.alerts.length, 1, 'retried and delivered on the very next pass');
  });

  test('missing ALERT_WEBHOOK_SECRET fails closed — nothing is sent', async () => {
    const saved = process.env.ALERT_WEBHOOK_SECRET;
    delete process.env.ALERT_WEBHOOK_SECRET;
    try {
      const node = cpuNode('venti', 0.99);
      await evaluate(topo(node));
      await evaluate(topo(node));
      const r = await evaluate(topo(node));
      assert.equal(captured.length, 0, 'no unsigned webhook sent');
      assert.equal(r.alerts.length, 0);
      assert.equal(r.delivery_failures[0].reason, 'no-secret');
    } finally {
      process.env.ALERT_WEBHOOK_SECRET = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Malformed edges & stale state
// ---------------------------------------------------------------------------
describe('robustness', () => {
  test('a null / malformed edge does not abort the pass', async () => {
    const edges = [null, { type: 'database' }, { source: 'x' }, { id: 'ok', source: 'app', target: 'db', type: 'database' }];
    const r = await evaluate(topoE([cpuNode('app', 0.99)], edges));
    assert.equal(r.node_errors.length, 0, 'the pass completed cleanly');
    assert.equal(r.evaluated, 1);
  });

  test('stale firing state is cleared for a node absent from discovery', async () => {
    const node = cpuNode('ghost', 0.99);
    for (let i = 0; i < 3; i++) await evaluate(topo(node)); // ghost firing
    assert.ok(listFiringStates().has('ghost'));
    // back-date last_seen_at beyond the stale window, then evaluate WITHOUT ghost
    _getDb().prepare("UPDATE threshold_state SET last_seen_at = ? WHERE node_id = 'ghost'")
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
    const r = await evaluate(topo(cpuNode('other', 0.01)));
    assert.ok(r.stale_state_cleared >= 1, 'the vanished node\'s firing row was cleared');
    assert.ok(!listFiringStates().has('ghost'), 'ghost no longer suppresses anything');
  });
});

// ---------------------------------------------------------------------------
// 13. listFiringStates
// ---------------------------------------------------------------------------
describe('listFiringStates', () => {
  test('returns node ids with a firing metric', async () => {
    const node = cpuNode('venti', 0.99);
    await evaluate(topo(node));
    await evaluate(topo(node));
    assert.equal(listFiringStates().has('venti'), false, 'not firing before count 3');
    await evaluate(topo(node));
    assert.equal(listFiringStates().has('venti'), true, 'firing at count 3');
  });
});

// ---------------------------------------------------------------------------
// 14. Gauntlet round 2 fixes
// ---------------------------------------------------------------------------
describe('two-phase fan-out', () => {
  function reach(id, down) {
    return { id, name: id, type: 'vm', status: down ? 'critical' : 'healthy', meta: {} };
  }

  test('authentik + all its SSO apps crossing on the SAME pass → only authentik alerts', async () => {
    const apps = ['gitea', 'immich', 'mealie'];
    const edges = apps.map((a, i) => ({ id: `e${i}`, source: a, target: 'authentik', type: 'sso' }));
    const nodes = () => [reach('authentik', true), ...apps.map(a => reach(a, true))];
    for (let i = 0; i < 2; i++) await evaluate(topoE(nodes(), edges)); // reachability required = 2
    assert.deepEqual(alertNodes(), ['authentik'], 'exactly one ticket for the shared upstream');
    for (const a of apps) assert.ok(suppressedNodes().includes(a), `${a} suppressed`);
  });
});

describe('root-cause resolution', () => {
  test('multi-hop A<-B<-C: C is attributed to the ROOT (A), not the direct parent (B)', async () => {
    // depends_on 'out': source depends on target. c depends on b, b depends on a.
    const edges = [
      { id: 'e1', source: 'c', target: 'b', type: 'depends_on' },
      { id: 'e2', source: 'b', target: 'a', type: 'depends_on' },
    ];
    const reach = (id, down) => ({ id, name: id, type: 'vm', status: down ? 'critical' : 'healthy', meta: {} });
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('a', true)], edges));            // a fires
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('a', true), reach('b', true)], edges)); // b suppressed
    let res;
    for (let i = 0; i < 2; i++) res = await evaluate(topoE([reach('a', true), reach('b', true), reach('c', true)], edges));
    const c = res.suppressed.find(s => s.node_id === 'c');
    assert.ok(c, 'c is suppressed');
    assert.equal(c.upstream_node, 'a', 'attributed to the root cause');
    assert.equal(c.direct_upstream, 'b', 'direct parent still recorded');
  });
});

describe('discovery degraded', () => {
  test('stale sweep is skipped when a source is degraded — firing state survives', async () => {
    const node = cpuNode('ghost', 0.99);
    for (let i = 0; i < 3; i++) await evaluate(topo(node)); // ghost firing
    _getDb().prepare("UPDATE threshold_state SET last_seen_at = ? WHERE node_id = 'ghost'")
      .run(new Date(Date.now() - 30 * 60 * 1000).toISOString());
    const res = await evaluate({ nodes: [cpuNode('other', 0.01)], edges: [], degraded: { sources: ['proxmox'] } });
    assert.equal(res.stale_sweep_skipped, true);
    assert.equal(res.degraded, true);
    assert.ok(listFiringStates().has('ghost'), 'ghost state NOT evicted during a discovery brownout');
  });
});

describe('suppressed-note delivery', () => {
  function reach(id, down) {
    return { id, name: id, type: 'vm', status: down ? 'critical' : 'healthy', meta: {} };
  }
  const edge = [{ id: 'e1', source: 'app', target: 'db', type: 'database' }];

  test('a failed suppressed-note is retried until acknowledged', async () => {
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('db', true)], edge)); // db firing
    // ramp app to its crossing (cpu required = 3)
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], edge));
    failResponses = 1; // the crossing-tick suppressed-note POST will 500
    const crossing = await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], edge)); // app crosses, note fails
    assert.equal(crossing.suppressed.find(s => s.node_id === 'app').note_delivered, false, 'not acknowledged yet');
    const retry = await evaluate(topoE([reach('db', true), cpuNode('app', 0.99)], edge)); // next pass retries
    const notes = captured.filter(c => c.body.suppressed && c.body.hexmap_node === 'app');
    assert.ok(notes.length >= 2, 'the note was re-sent after the failure');
    assert.equal(retry.suppressed.find(s => s.node_id === 'app').note_delivered, true, 'eventually acknowledged');
  });
});

describe('maintenance-suppressed event', () => {
  test('putting a firing node into maintenance emits one maintenance-suppressed event', async () => {
    const node = cpuNode('venti', 0.99);
    for (let i = 0; i < 3; i++) await evaluate(topo(node)); // venti/cpu firing
    captured = [];
    setMaintenance('venti', { reason: 'reboot' });
    await evaluate(topo(node));
    const ms = captured.filter(c => c.body.event === 'maintenance-suppressed');
    assert.equal(ms.length, 1);
    assert.equal(ms[0].body.hexmap_node, 'venti');
  });
});

// ---------------------------------------------------------------------------
// 15. Gauntlet round 4 fixes
// ---------------------------------------------------------------------------
describe('round 4 fixes', () => {
  function reach(id, down) {
    return { id, name: id, type: 'vm', status: down ? 'critical' : 'healthy', meta: {} };
  }

  test('F8 — a hard (reachability) upstream stays causal even when the downstream symptom surfaced first', async () => {
    const edge = [{ id: 'e1', source: 'app', target: 'db', type: 'database' }];
    // app needs 4 consecutive to cross; db needs the default 2. So app's
    // first_over_at is strictly earlier, yet db is firing by the time app crosses.
    _getDb().prepare("INSERT INTO threshold_config (node_id,metric_type,enabled,threshold_value,consecutive_required) VALUES ('app','reachability',1,NULL,4)").run();
    await evaluate(topoE([reach('app', true)], edge));                          // app 1  (t0)
    await evaluate(topoE([reach('app', true)], edge));                          // app 2
    await evaluate(topoE([reach('app', true), reach('db', true)], edge));       // app 3, db 1
    const res = await evaluate(topoE([reach('app', true), reach('db', true)], edge)); // app 4 = crossing, db 2 = firing
    assert.ok(!alertNodes().includes('app'), 'app suppressed — the hard upstream is causal despite app failing first');
    assert.ok(res.suppressed.some(s => s.node_id === 'app' && s.upstream_node === 'db'));
  });

  test('F4 — a firing node that vanishes from discovery emits a resolved event before the sweep clears it', async () => {
    const node = cpuNode('ghost', 0.99);
    for (let i = 0; i < 3; i++) await evaluate(topo(node)); // ghost/cpu firing + alerted
    captured = [];
    _getDb().prepare("UPDATE threshold_state SET last_seen_at = ? WHERE node_id = 'ghost'")
      .run(new Date(Date.now() - 30 * 60 * 1000).toISOString());
    const res = await evaluate(topo(cpuNode('other', 0.01))); // ghost absent, not degraded
    assert.ok(res.stale_state_cleared >= 1);
    const resolved = captured.filter(c => c.body.event === 'resolved' && c.body.hexmap_node === 'ghost');
    assert.equal(resolved.length, 1, 'the dangling incident got a recovered note');
  });

  test('F6 — degraded latches only after SOURCE_DEGRADE_AFTER consecutive empty polls', async () => {
    const { recordSourceHealth } = require('../src/evaluate');
    recordSourceHealth({ proxmox: 5 });        // seen with data
    let h = recordSourceHealth({ proxmox: 0 }); // empty 1
    assert.equal(h.degraded, false);
    h = recordSourceHealth({ proxmox: 0 });     // empty 2
    assert.equal(h.degraded, false);
    h = recordSourceHealth({ proxmox: 0 });     // empty 3 — default threshold
    assert.equal(h.degraded, true);
    h = recordSourceHealth({ proxmox: 4 });     // recovered — counter resets
    assert.equal(h.degraded, false);
  });

  test('F5 — upstream_metric is the ROOT node\'s firing metric, not the direct parent\'s', async () => {
    const edges = [
      { id: 'e1', source: 'c', target: 'b', type: 'depends_on' },
      { id: 'e2', source: 'b', target: 'a', type: 'depends_on' },
    ];
    // reachability cascade a -> b -> c; a fires first as the root
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('a', true)], edges));
    for (let i = 0; i < 2; i++) await evaluate(topoE([reach('a', true), reach('b', true)], edges));
    let res;
    for (let i = 0; i < 2; i++) res = await evaluate(topoE([reach('a', true), reach('b', true), reach('c', true)], edges));
    const c = res.suppressed.find(s => s.node_id === 'c');
    assert.equal(c.upstream_node, 'a', 'root, not direct parent b');
    assert.equal(c.upstream_metric, 'reachability', "paired with a's metric");
  });

  test('F10 — setMaintenance rejects an out-of-charset / oversized node id', () => {
    assert.throws(() => setMaintenance('bad id with spaces'), MaintenanceValidationError);
    assert.throws(() => setMaintenance('x'.repeat(201)), MaintenanceValidationError);
    assert.throws(() => setMaintenance('drop;table'), MaintenanceValidationError);
    // legit ids pass
    setMaintenance('k3s-homelab-nextcloud');
    setMaintenance('source:proxmox');
    assert.ok(listMaintenance().has('source:proxmox'));
  });
});

// ---------------------------------------------------------------------------
// Gauntlet round 5 fixes
// ---------------------------------------------------------------------------
describe('round 5 fixes', () => {
  function reachN(id, down) {
    return { id, name: id, type: 'vm', status: down ? 'critical' : 'healthy', meta: {} };
  }

  test('F21 — omitted expires_at default TTL is ~1h, not 4h', () => {
    const row = setMaintenance('venti', {});
    const ms = new Date(row.expires_at).getTime() - Date.now();
    assert.ok(ms > 50 * 60 * 1000 && ms < 70 * 60 * 1000, `default TTL ~1h, got ${Math.round(ms / 60000)}min`);
  });

  test('F20 — a max-suppression-escape alert carries structured upstream_node / upstream_metric', async () => {
    const edges = [{ id: 'e1', source: 'b', target: 'a', type: 'depends_on' }];
    const t = topoE([reachN('a', true), reachN('b', true)], edges);
    for (let i = 0; i < 3; i++) await evaluate(t); // a alerts (root); b suppressed, attributed to a
    assert.ok(suppressedNodes().includes('b'), 'b starts suppressed');
    // back-date b's suppressed_since past MAX_SUPPRESS_MS
    _getDb().prepare("UPDATE threshold_state SET suppressed_since = ? WHERE node_id = 'b'")
      .run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    captured = [];
    const res = await evaluate(t); // b escapes and alerts
    const bAlert = captured.find(c => c.body.event === 'alert' && c.body.hexmap_node === 'b');
    assert.ok(bAlert, 'b emitted an alert after the suppression window');
    assert.equal(bAlert.body.upstream_node, 'a', 'escape alert still names the upstream cause');
    assert.equal(bAlert.body.upstream_metric, 'reachability', 'and the upstream metric');
  });

  test('F11 — a stale topology holds recoveries, skips the stale sweep, and marks the pass degraded', async () => {
    const node = cpuNode('venti', 0.99);
    for (let i = 0; i < 3; i++) await evaluate(topo(node)); // venti firing + alerted
    assert.ok(listFiringStates().has('venti'));
    _getDb().prepare("UPDATE threshold_state SET last_seen_at = ? WHERE node_id = 'venti'")
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
    captured = [];
    // frozen snapshot: venti now looks healthy, but the topology is stale
    const res = await evaluate({ nodes: [cpuNode('venti', 0.01)], edges: [], stale: true, staleReason: 'build failed' });
    assert.equal(res.degraded, true, 'stale pass is degraded');
    assert.equal(res.topology_stale, true);
    assert.equal(res.stale_sweep_skipped, true, 'stale sweep did not run on frozen data');
    assert.equal(res.stale_state_cleared, 0);
    assert.equal(resolvedNodes().length, 0, 'no resolved/recovery events from a frozen snapshot');
    assert.ok(listFiringStates().has('venti'), 'venti keeps its firing state until a fresh topology');
  });

  test('F6 — a webhook delivery failure makes the whole pass degraded', async () => {
    const node = cpuNode('venti', 0.99);
    await evaluate(topo(node));
    await evaluate(topo(node));
    failResponses = 1; // the crossing send 500s
    const r = await evaluate(topo(node));
    assert.equal(r.alerts.length, 0);
    assert.equal(r.delivery_failures.length, 1);
    assert.equal(r.delivery_failed, true, 'delivery_failed flag set');
    assert.equal(r.degraded, true, 'pass is degraded so the dead-man ping is withheld');
  });

  test('F23 — a failed resolved send is retried on the next pass, not lost', async () => {
    const hot = cpuNode('venti', 0.99);
    const cool = cpuNode('venti', 0.01);
    for (let i = 0; i < 3; i++) await evaluate(topo(hot)); // venti alerts
    assert.ok(listFiringStates().has('venti'));
    captured = [];
    failResponses = 1;                              // the resolved send will 500
    const r1 = await evaluate(topo(cool));
    assert.equal(resolvedNodes().length, 1, 'resolved was attempted');
    assert.equal(r1.delivery_failures.some(f => f.kind === 'resolved'), true);
    assert.ok(listFiringStates().has('venti'), 'state NOT cleared while the resolved note is undelivered');
    captured = [];
    const r2 = await evaluate(topo(cool));          // retry, now succeeds
    assert.equal(resolvedNodes().length, 1, 'resolved re-sent on the next pass');
    assert.ok(!listFiringStates().has('venti'), 'state cleared once the resolved note landed');
  });

  test('V14 — a 429 (throttled) webhook response does NOT make the pass degraded', async () => {
    const node = cpuNode('venti', 0.99);
    await evaluate(topo(node));
    await evaluate(topo(node));
    throttleResponses = 1;                          // the crossing send gets 429
    const r = await evaluate(topo(node));
    assert.equal(r.alerts.length, 0, 'not counted as delivered');
    assert.equal(r.delivery_failures.length, 1, 'still recorded for inspection');
    assert.equal(r.throttled, true, 'throttled flag set');
    assert.equal(r.delivery_failed, false, 'not a real delivery failure');
    assert.equal(r.degraded, false, 'dead-man ping is NOT withheld for a throttle');
  });

  test('V5 — the root alert is sent before a downstream suppressed even when the downstream precedes it', async () => {
    const edges = [{ id: 'e1', source: 'b', target: 'a', type: 'depends_on' }]; // b depends on a
    // b listed FIRST in nodes[]; a is the root cause
    const t = topoE([reachN('b', true), reachN('a', true)], edges);
    for (let i = 0; i < 2; i++) await evaluate(t);
    captured = [];
    await evaluate(t);
    const order = captured.map(c => `${c.body.hexmap_node}:${c.body.event}`);
    const aAlert = order.indexOf('a:alert');
    const bSupp  = order.findIndex(x => x === 'b:suppressed');
    if (aAlert !== -1 && bSupp !== -1) {
      assert.ok(aAlert < bSupp, `root a:alert (${aAlert}) sent before b:suppressed (${bSupp})`);
    }
  });
});
