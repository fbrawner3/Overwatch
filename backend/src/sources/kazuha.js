const fetch = require('node-fetch');

const KAZUHA_STATS_URL   = process.env.KAZUHA_STATS_URL   || 'http://kazuha:9101/stats';
const KAZUHA_STATS_TOKEN = process.env.KAZUHA_STATS_TOKEN;
const KAZUHA_NODE_ID     = process.env.KAZUHA_NODE_ID     || 'kazuha';
const KAZUHA_NODE_NAME   = process.env.KAZUHA_NODE_NAME   || 'Kazuha';
const KAZUHA_PARENT_ID   = process.env.KAZUHA_PARENT_ID   || 'cyno';

function baseNode(status, meta) {
  return {
    id: KAZUHA_NODE_ID,
    name: KAZUHA_NODE_NAME,
    type: 'vps',
    layer: 'edge',
    isEdge: true,
    parentId: KAZUHA_PARENT_ID,
    column: KAZUHA_PARENT_ID,
    ip: null,
    status,
    meta: { lokiLabel: KAZUHA_NODE_ID, haMetrics: true, ...meta },
  };
}

async function fetchKazuhaStats() {
  if (!KAZUHA_STATS_URL) return null;
  try {
    const headers = KAZUHA_STATS_TOKEN ? { Authorization: `Bearer ${KAZUHA_STATS_TOKEN}` } : {};
    const res = await fetch(KAZUHA_STATS_URL, { headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`[kazuha] cpu=${data.cpuPercent}% mem=${data.memPercent}% disk=${data.diskPercent}%`);
    return {
      node: baseNode('healthy', { cpuPercent: data.cpuPercent, memPercent: data.memPercent, diskPercent: data.diskPercent }),
      edges: [
        { id: `e-net-${KAZUHA_PARENT_ID}-${KAZUHA_NODE_ID}`, source: KAZUHA_PARENT_ID, target: KAZUHA_NODE_ID, type: 'network' },
      ],
    };
  } catch (err) {
    console.warn('[kazuha] stats failed:', err.message);
    return {
      node: baseNode('critical', {}),
      edges: [
        { id: `e-net-${KAZUHA_PARENT_ID}-${KAZUHA_NODE_ID}`, source: KAZUHA_PARENT_ID, target: KAZUHA_NODE_ID, type: 'network' },
      ],
    };
  }
}

module.exports = { fetchKazuhaStats };
