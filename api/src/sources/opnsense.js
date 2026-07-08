const fetch = require('node-fetch');
const https = require('https');

const OPN_URL = process.env.OPNSENSE_URL || 'https://cyno';
const OPN_KEY = process.env.OPNSENSE_KEY;
const OPN_SECRET = process.env.OPNSENSE_SECRET;

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

async function fetchOPNsenseNode(leaseMap) {
  if (!OPN_KEY || !OPN_SECRET) { console.warn('[opnsense] no credentials'); return null; }

  try {
    const [firmware, interfaces] = await Promise.all([
      opn('/api/core/firmware/status').catch(() => null),
      opn('/api/diagnostics/interface/getInterfaceStatistics').catch(() => null),
    ]);

    const version = firmware?.product_version || null;

    // Find WAN rx/tx bytes for network throughput indicator
    let networkMbps = null;
    if (interfaces?.statistics) {
      const stats = Object.values(interfaces.statistics);
      const wan = stats.find(s => s.flags?.includes('up') && !s.flags?.includes('loopback') && s['bytes in'] > 0);
      if (wan) {
        // bytes in/out are totals — snapshot only, no rate calculation possible in single poll
        networkMbps = 0;
      }
    }

    console.log(`[opnsense] cyno up, version=${version}`);

    return {
      status: 'healthy',
      meta: {
        version,
        ...(networkMbps !== null ? { networkMbps } : {}),
      },
    };
  } catch (err) {
    console.warn('[opnsense] status fetch failed:', err.message);
    return { status: 'critical', meta: {} };
  }
}

module.exports = { fetchOPNsenseNode, fetchDhcpLeaseMap };
