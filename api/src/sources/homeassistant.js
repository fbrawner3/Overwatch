const fetch = require('node-fetch');

const HA_URL = process.env.HA_URL || 'http://noelle:8123';
const HA_TOKEN = process.env.HA_TOKEN;

async function haGet(path) {
  const res = await fetch(`${HA_URL}${path}`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HA API ${res.status}: ${path}`);
  return res.json();
}

function entityValue(state) {
  const v = parseFloat(state?.state);
  return Number.isFinite(v) ? v : null;
}

async function fetchHomeAssistantNode() {
  if (!HA_TOKEN) { console.warn('[ha] no HA_TOKEN'); return null; }

  try {
    // Fetch system monitor entities in parallel
    const [cpu, memUse, diskUse] = await Promise.all([
      haGet('/api/states/sensor.system_monitor_processor_use').catch(() => null),
      haGet('/api/states/sensor.system_monitor_memory_use').catch(() => null),
      haGet('/api/states/sensor.system_monitor_disk_use').catch(() => null),
    ]);

    const cpuPercent = entityValue(cpu);

    const memUseMiB = entityValue(memUse);
    const diskUseGiB = entityValue(diskUse);

    console.log(`[ha] noelle cpu=${cpuPercent}% mem=${memUseMiB}MiB disk=${diskUseGiB}GiB`);

    return {
      cpuPercent,
      memMiB: memUseMiB,
      diskGiB: diskUseGiB,
      status: 'healthy',
    };
  } catch (err) {
    console.warn('[ha] failed:', err.message);
    return { status: 'critical', cpuPercent: null, memPercent: null, diskPercent: null };
  }
}

module.exports = { fetchHomeAssistantNode, HA_URL };
