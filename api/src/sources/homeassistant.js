const fetch = require('node-fetch');
const dns = require('dns/promises');

const HA_URL      = process.env.HA_URL       || 'http://noelle:8123';
const HA_TOKEN    = process.env.HA_TOKEN;
const HA_NODE_ID  = process.env.HA_NODE_ID   || 'noelle';
const HA_NODE_NAME = process.env.HA_NODE_NAME || 'Noelle';

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

async function resolveIp(hostname) {
  try { return (await dns.lookup(hostname)).address; } catch { return null; }
}

function baseNode(ip, status, meta) {
  return {
    id: HA_NODE_ID,
    name: HA_NODE_NAME,
    type: 'baremetal',
    layer: 'host',
    isEdge: false,
    parentId: null,
    column: HA_NODE_ID,
    ip,
    status,
    meta: { lokiLabel: HA_NODE_ID, haMetrics: true, ...meta },
  };
}

async function fetchHomeAssistantNode() {
  if (!HA_TOKEN) { console.warn('[ha] no HA_TOKEN'); return null; }

  const hostname = new URL(HA_URL).hostname;
  const ip = await resolveIp(hostname);

  try {
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

    console.log(`[ha] ${HA_NODE_ID} cpu=${cpuPercent}% mem=${memUseMiB}MiB(${memPercent}%) disk=${diskUseGiB}GiB(${diskPercent}%)`);

    return { node: baseNode(ip, 'healthy', { cpuPercent, memMiB: memUseMiB, memPercent, diskGiB: diskUseGiB, diskPercent }) };
  } catch (err) {
    console.warn('[ha] failed:', err.message);
    return { node: baseNode(ip, 'critical', {}) };
  }
}

module.exports = { fetchHomeAssistantNode, HA_URL };
