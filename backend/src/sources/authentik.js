const fetch = require('node-fetch');

const AUTHENTIK_URL = process.env.VITE_AUTHENTIK_URL || 'https://auth.brawnandmoore.com';
const AUTHENTIK_TOKEN = process.env.VITE_AUTHENTIK_TOKEN;

async function authentikFetch(path) {
  const res = await fetch(`${AUTHENTIK_URL}/api/v3${path}`, {
    headers: { Authorization: `Bearer ${AUTHENTIK_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Authentik API ${res.status}: ${path}`);
  return res.json();
}

function norm(s) {
  return String(s).toLowerCase().replace(/[-_\s]/g, '');
}

async function fetchAuthentikEdges(nodes) {
  if (!AUTHENTIK_TOKEN) { console.warn('[authentik] no token'); return []; }

  try {
    let apps = [];
    let url = '/core/applications/?page_size=100';
    while (url) {
      const data = await authentikFetch(url);
      apps = apps.concat(data.results || []);
      const next = data.pagination?.next;
      url = next ? `/core/applications/?page_size=100&page=${next}` : null;
    }

    const byNorm = {};
    for (const n of nodes) {
      byNorm[norm(n.id)] = n;
      byNorm[norm(n.name)] = n;
      if (n.meta?.lokiLabel) byNorm[norm(n.meta.lokiLabel)] = n;
      if (n.meta?.authentikSlug) byNorm[norm(n.meta.authentikSlug)] = n;
    }

    // Find actual Authentik k3s node; fall back to static 'authentik' id
    const authentikSourceNode = nodes.find(n => n.type === 'k3s-service' && n.meta?.lokiLabel === 'authentik-server')
      || nodes.find(n => n.type === 'k3s-service' && (n.name === 'authentik-server' || n.name === 'authentik'))
      || nodes.find(n => n.id === 'authentik');
    const sourceId = authentikSourceNode?.id || 'authentik';

    const edges = [];
    const seen = new Set();

    for (const app of apps) {
      const slug = app.slug || '';
      const appName = app.name || '';
      const target = byNorm[norm(slug)] || byNorm[norm(appName)];
      if (!target || target.id === sourceId) continue;

      const edgeId = `e-sso-${target.id}`;
      if (!seen.has(edgeId)) {
        seen.add(edgeId);
        // Convention: sso edge is app -> Authentik (the app is the consumer).
        // DEP_EDGE_DIRECTION.sso = 'out' => source is the consumer.
        edges.push({ id: edgeId, source: target.id, target: sourceId, type: 'sso' });
      }
    }

    console.log(`[authentik] ${edges.length} SSO edges`);
    return edges;
  } catch (err) {
    console.error('[authentik] failed:', err.message);
    return [];
  }
}

module.exports = { fetchAuthentikEdges };
