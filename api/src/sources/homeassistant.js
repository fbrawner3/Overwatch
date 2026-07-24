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
    // Fetch system monitor entities in parallel — percent variants may not exist on all HA setups
    const [cpu, memUse, memUsePct, diskUse, diskUsePct] = await Promise.all([
      haGet('/api/states/sensor.system_monitor_processor_use').catch(() => null),
      haGet('/api/states/sensor.system_monitor_memory_use').catch(() => null),
      haGet('/api/states/sensor.system_monitor_memory_use_percent').catch(() => null),
      haGet('/api/states/sensor.system_monitor_disk_use').catch(() => null),
      haGet('/api/states/sensor.system_monitor_disk_use_percent').catch(() => null),
    ]);

    const cpuPercent  = entityValue(cpu);
    const memUseMiB   = entityValue(memUse);
    const memPercent  = entityValue(memUsePct);
    const diskUseGiB  = entityValue(diskUse);
    const diskPercent = entityValue(diskUsePct);

    console.log(`[ha] noelle cpu=${cpuPercent}% mem=${memUseMiB}MiB(${memPercent}%) disk=${diskUseGiB}GiB(${diskPercent}%)`);

    return {
      cpuPercent,
      memMiB: memUseMiB,
      memPercent,
      diskGiB: diskUseGiB,
      diskPercent,
      status: 'healthy',
    };
  } catch (err) {
    console.warn('[ha] failed:', err.message);
    return { status: 'critical', cpuPercent: null, memPercent: null, diskPercent: null };
  }
}

module.exports = { fetchHomeAssistantNode, HA_URL };
