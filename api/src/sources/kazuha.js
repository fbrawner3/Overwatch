const fetch = require('node-fetch');

const KAZUHA_STATS_URL = process.env.KAZUHA_STATS_URL || 'http://kazuha:9101/stats';
const KAZUHA_STATS_TOKEN = process.env.KAZUHA_STATS_TOKEN;

async function fetchKazuhaStats() {
  try {
    const headers = KAZUHA_STATS_TOKEN ? { Authorization: `Bearer ${KAZUHA_STATS_TOKEN}` } : {};
    const res = await fetch(KAZUHA_STATS_URL, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`[kazuha] cpu=${data.cpuPercent}% mem=${data.memPercent}% disk=${data.diskPercent}%`);
    return { cpuPercent: data.cpuPercent, memPercent: data.memPercent, diskPercent: data.diskPercent, status: 'healthy' };
  } catch (err) {
    console.warn('[kazuha] stats failed:', err.message);
    return { status: 'critical', cpuPercent: null, memPercent: null, diskPercent: null };
  }
}

module.exports = { fetchKazuhaStats };
