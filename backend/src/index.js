const express = require('express');
const { getTopology, bustCache, patchMaintenance } = require('./cache');
const {
  evaluateFromCache, listMaintenance, setMaintenance, clearMaintenance,
  MaintenanceValidationError,
} = require('./evaluate');

const app = express();
app.use(express.json({ limit: '64kb' }));
const PORT = process.env.PORT || 3010;
// OVERWATCH_SHARED_SECRET is the post-rename name; HEXMAP_SHARED_SECRET is
// accepted during the transition.
const SHARED_SECRET = process.env.OVERWATCH_SHARED_SECRET || process.env.HEXMAP_SHARED_SECRET;

function requireSecret(req, res, next) {
  if (!SHARED_SECRET) {
    console.warn('[hexmap-api] HEXMAP_SHARED_SECRET not set — rejecting all requests to protected routes');
    return res.status(403).json({ error: 'forbidden' });
  }
  const provided = req.headers['x-hexmap-secret'];
  if (!provided || provided !== SHARED_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// A direct loopback request (the heizou cron running `docker exec ... wget
// 127.0.0.1:3010/evaluate` inside the container netns) is inside the trust
// boundary — no shared secret required. Anything with a proxy hop
// (X-Forwarded-For present) is not treated as local. NOTE: this only holds for
// a single-process container; host networking is unsupported.
function isLoopback(req) {
  if (req.headers['x-forwarded-for']) return false;
  const ip = req.socket.remoteAddress;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireSecretOrLoopback(req, res, next) {
  if (isLoopback(req)) return next();
  return requireSecret(req, res, next);
}

async function runEvaluate(_req, res) {
  try {
    const result = await evaluateFromCache();
    // F6 (round 5): a degraded pass (webhook delivery failing / discovery down /
    // stale topology / node errors) returns 503 so the cron wrapper withholds
    // its dead-man ping to Uptime Kuma and Kuma's "no push in N min" alarm
    // fires. The full result body is still returned for inspection. A skipped
    // tick (overlapping run) is not unhealthy and stays 200.
    res.status(result && result.degraded ? 503 : 200).json(result);
  } catch (err) {
    console.error('[hexmap-api] /evaluate error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function knownNodeIds() {
  try {
    const topo = await getTopology();
    return new Set(topo.nodes.map(n => n.id));
  } catch {
    return null; // topology unavailable — can't judge membership
  }
}

app.get('/topology', requireSecret, async (req, res) => {
  try {
    const topo = await getTopology(req.query.force === '1');
    res.json(topo);
  } catch (err) {
    console.error('[hexmap-api] /topology error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Threshold watcher. POST is the canonical (mutating) verb and always requires
// the shared secret. GET keeps the loopback exemption for the in-container cron.
app.post('/evaluate', requireSecret, runEvaluate);
app.get('/evaluate', requireSecretOrLoopback, runEvaluate);

// --- maintenance mode ----------------------------------------------------
// Per-node alert pause. The frontend pill toggle and (later) Armory patch runs
// both write here; evaluate() skips any node with an active row.
app.get('/maintenance', requireSecret, async (_req, res) => {
  const ids = await knownNodeIds();
  const nodes = [...listMaintenance().values()].map(r => ({
    ...r,
    known: ids ? ids.has(r.node_id) : null,
  }));
  res.json({ nodes });
});

app.post('/maintenance/:nodeId', requireSecret, async (req, res) => {
  const { nodeId } = req.params;
  // If a request body is sent it MUST be application/json and parse to a plain
  // object. A no-body POST is fine — nodeId is in the URL, defaults apply.
  const hasBody = Number(req.headers['content-length'] || 0) > 0;
  if (hasBody && !req.is('application/json')) {
    return res.status(415).json({ error: 'body must be application/json' });
  }
  if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body))) {
    return res.status(400).json({ error: 'body must be a JSON object' });
  }
  const { reason = null, set_by = null, expires_at = null } = req.body || {};
  const allowUnknown = req.query.allow_unknown === '1';

  // Reject an unknown node id by default so a stale Armory mapping gets a hard
  // signal instead of silently creating an orphan row. ?allow_unknown=1 opts in.
  const ids = await knownNodeIds();
  if (ids && !ids.has(nodeId) && !allowUnknown) {
    return res.status(409).json({
      error: 'unknown node id — not present in current topology',
      node_id: nodeId,
      hint: 'retry with ?allow_unknown=1 to force',
    });
  }

  try {
    const row = setMaintenance(nodeId, { reason, set_by, expires_at });
    // in-place cache patch — a toggle doesn't force a full rediscovery
    patchMaintenance(nodeId, row);
    res.json({
      node_id: nodeId,
      maintenance: !!row,
      known: ids ? ids.has(nodeId) : null,
      clamped: row ? !!row.clamped : false,
      ...(row || {}),
    });
  } catch (err) {
    if (err instanceof MaintenanceValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[hexmap-api] POST /maintenance error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/maintenance/:nodeId', requireSecret, async (req, res) => {
  const { nodeId } = req.params;
  const deleted = clearMaintenance(nodeId) > 0;
  patchMaintenance(nodeId, null);
  const ids = await knownNodeIds();
  res.json({ node_id: nodeId, maintenance: false, deleted, known: ids ? ids.has(nodeId) : null });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Malformed JSON body etc.
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body too large' });
  }
  console.error('[hexmap-api] unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`hexmap-api listening on :${PORT}`);
  getTopology().then(() => console.log('[hexmap-api] cache warmed')).catch(console.error);
});
