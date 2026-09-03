const fetch = require('node-fetch');
const https = require('https');
const dns = require('dns/promises');

const OPN_URL       = process.env.OPNSENSE_URL  || 'https://cyno';
const OPN_KEY       = process.env.OPNSENSE_KEY;
const OPN_SECRET    = process.env.OPNSENSE_SECRET;
const OPN_NODE_ID   = process.env.OPN_NODE_ID   || 'cyno';
const OPN_NODE_NAME = process.env.OPN_NODE_NAME || 'Cyno';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function authHeader() {
  const creds = Buffer.from(`${OPN_KEY}:${OPN_SECRET}`).toString('base64');
  return { Authorization: `Basic ${creds}` };
}

async function opn(path) {
  const url = `${OPN_URL}${path}`;
  const isHttps = url.startsWith('https:');
  const res = await fetch(url, {
    headers: authHeader(),
    agent: isHttps ? httpsAgent : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`OPNsense API ${res.status}: ${path}`);
  return res.json();
}

// Returns { hostname -> ip } for all current DHCP leases
async function fetchDhcpLeaseMap() {
  if (!OPN_KEY || !OPN_SECRET) return {};
  try {
    const data = await opn('/api/dhcpv4/leases/searchLease');
    const leases = data.rows || [];
    const map = {};
    for (const lease of leases) {
      const hostname = (lease.hostname || '').toLowerCase().trim();
      const ip = (lease.address || '').trim();
      if (hostname && ip) map[hostname] = ip;
    }
    console.log(`[opnsense] ${leases.length} DHCP leases, ${Object.keys(map).length} with hostnames`);
    return map;
  } catch (err) {
    console.warn('[opnsense] DHCP lease fetch failed:', err.message);
    return {};
  }
}

async function resolveIp(hostname) {
  try { return (await dns.lookup(hostname)).address; } catch { return null; }
}

function baseNode(ip, status, meta) {
  return {
    id: OPN_NODE_ID,
    name: OPN_NODE_NAME,
    type: 'firewall',
    layer: 'edge',
    isEdge: true,
    parentId: null,
    column: OPN_NODE_ID,
    ip,
    status,
    meta,
  };
}

async function fetchOPNsenseNode() {
  if (!OPN_KEY || !OPN_SECRET) { console.warn('[opnsense] no credentials'); return null; }

  const hostname = new URL(OPN_URL).hostname;
  const ip = await resolveIp(hostname);

  try {
    const [firmware, interfaces] = await Promise.all([
      opn('/api/core/firmware/status').catch(() => null),
      opn('/api/diagnostics/interface/getInterfaceStatistics').catch(() => null),
    ]);

    const version = firmware?.product_version || null;
    console.log(`[opnsense] ${OPN_NODE_ID} up, version=${version}`);

    return { node: baseNode(ip, 'healthy', { lokiLabel: OPN_NODE_ID, version }) };
  } catch (err) {
    console.warn('[opnsense] status fetch failed:', err.message);
    return { node: baseNode(ip, 'critical', { lokiLabel: OPN_NODE_ID }) };
  }
}

module.exports = { fetchOPNsenseNode, fetchDhcpLeaseMap };
