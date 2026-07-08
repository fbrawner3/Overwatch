const fetch = require('node-fetch');
const https = require('https');

const INFISICAL_TOKEN = process.env.VITE_INFISICAL_TOKEN;
const agent = new https.Agent({ rejectUnauthorized: false });

async function infisicalFetch(path) {
  const res = await fetch(`https://infisical.fndhome/api${path}`, {
    headers: { Authorization: `Bearer ${INFISICAL_TOKEN}` },
    agent,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Infisical API ${res.status}: ${path}`);
  return res.json();
}

function norm(s) {
  return String(s).toLowerCase().replace(/[-_\s]/g, '');
}

async function fetchInfisicalEdges(nodes) {
  if (!INFISICAL_TOKEN) { console.warn('[infisical] no token'); return []; }

  try {
    const data = await infisicalFetch('/v1/workspace');
    const workspaces = data.workspaces || [];

    const byNorm = {};
    for (const n of nodes) {
      byNorm[norm(n.id)] = n;
      byNorm[norm(n.name)] = n;
      if (n.meta?.lokiLabel) byNorm[norm(n.meta.lokiLabel)] = n;
    }

    // Find actual Infisical k3s node; fall back to static 'infisical' id
    const infisicalSourceNode = nodes.find(n => n.type === 'k3s-service' && n.name === 'infisical')
      || nodes.find(n => n.type === 'k3s-service' && n.meta?.lokiLabel && n.meta.lokiLabel.includes('infisical') && !n.meta.lokiLabel.includes('operator') && !n.meta.lokiLabel.includes('redis'))
      || nodes.find(n => n.id === 'infisical');
    const sourceId = infisicalSourceNode?.id || 'infisical';

    const edges = [];
    const seen = new Set();

    // LXC nodes with IPs — scan secret values for their IPs to detect DB connections
    // IPs never appear in passwords, so no false positives
    const lxcWithIp = nodes.filter(n => (n.type === 'lxc' || n.type === 'vm') && n.ip);

    for (const ws of workspaces) {
      const envSlug = ws.environments?.[0]?.slug || 'prod';
      const folderData = await infisicalFetch(`/v1/folders?workspaceId=${ws.id}&environment=${envSlug}`);
      const folders = folderData.folders || [];

      for (const folder of folders) {
        const target = byNorm[norm(folder.name)];
        if (!target || target.id === sourceId) continue;
        const edgeId = `e-secret-${target.id}`;
        if (!seen.has(edgeId)) {
          seen.add(edgeId);
          edges.push({ id: edgeId, source: sourceId, target: target.id, type: 'secrets_for' });
        }

        // Scan secret values for LXC IPs → draw database edge
        if (lxcWithIp.length) {
          try {
            const secretData = await infisicalFetch(`/v1/secrets?workspaceId=${ws.id}&environment=${envSlug}&secretPath=/${folder.name}`);
            const allValues = (secretData.secrets || []).map(s => s.secretValue || s.value || '').join(' ');
            for (const lxc of lxcWithIp) {
              if (!allValues.includes(lxc.ip)) continue;
              const dbEdgeId = `e-db-${target.id}-${lxc.id}`;
              if (!seen.has(dbEdgeId)) {
                seen.add(dbEdgeId);
                edges.push({ id: dbEdgeId, source: target.id, target: lxc.id, type: 'database' });
                console.log(`[infisical] DB edge: ${target.id} → ${lxc.id} (${lxc.ip})`);
              }
            }
          } catch { /* secrets fetch failed for this folder */ }
        }
      }
    }

    console.log(`[infisical] ${edges.length} secret edges`);
    return edges;
  } catch (err) {
    console.error('[infisical] failed:', err.message);
    return [];
  }
}

module.exports = { fetchInfisicalEdges };
