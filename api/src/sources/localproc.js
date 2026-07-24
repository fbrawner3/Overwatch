const fs = require('fs');
const os = require('os');
const dns = require('dns/promises');

const LOCAL_NODE_ID   = process.env.LOCAL_NODE_ID   || 'heizou';
const LOCAL_NODE_NAME = process.env.LOCAL_NODE_NAME || 'Heizou';

// Read CPU usage from /proc/stat — takes two snapshots 500ms apart for accurate rate
async function readCpuPercent() {
  function readStat() {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  }
  const a = readStat();
  await new Promise(r => setTimeout(r, 500));
  const b = readStat();
  const idleDiff = b.idle - a.idle;
  const totalDiff = b.total - a.total;
  if (totalDiff === 0) return 0;
  return (1 - idleDiff / totalDiff) * 100;
}

function readMemPercent() {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const val = key => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1], 10) : 0;
  };
  const total = val('MemTotal');
  const available = val('MemAvailable');
  if (!total) return 0;
  return ((total - available) / total) * 100;
}

function readDiskPercent(mountpoint = '/') {
  try {
    // Use os.freemem equivalent for disk — need statvfs which Node doesn't expose natively
    // Fall back to reading /proc/mounts and df via child_process if needed
    // Simple approach: use os module for root disk
    const { execSync } = require('child_process');
    const out = execSync(`df -k ${mountpoint} 2>/dev/null | tail -1`, { timeout: 3000 }).toString();
    const parts = out.trim().split(/\s+/);
    const used = parseInt(parts[2], 10);
    const avail = parseInt(parts[3], 10);
    if (!used && !avail) return 0;
    return (used / (used + avail)) * 100;
  } catch {
    return 0;
  }
}

async function resolveIp(hostname) {
  try { return (await dns.lookup(hostname)).address; } catch { return null; }
}

async function fetchLocalProcStats() {
  if (process.platform !== 'linux') return null;

  const ip = await resolveIp(LOCAL_NODE_ID);

  try {
    const [cpuPercent, memPercent, diskPercent] = await Promise.all([
      readCpuPercent(),
      Promise.resolve(readMemPercent()),
      Promise.resolve(readDiskPercent('/')),
    ]);
    const stats = {
      cpuPercent:  Math.round(cpuPercent  * 10) / 10,
      memPercent:  Math.round(memPercent  * 10) / 10,
      diskPercent: Math.round(diskPercent * 10) / 10,
    };
    console.log(`[localproc] ${LOCAL_NODE_ID} cpu=${stats.cpuPercent}% mem=${stats.memPercent}% disk=${stats.diskPercent}%`);
    return {
      node: {
        id: LOCAL_NODE_ID,
        name: LOCAL_NODE_NAME,
        type: 'baremetal',
        layer: 'host',
        isEdge: false,
        parentId: null,
        column: LOCAL_NODE_ID,
        ip,
        status: 'healthy',
        meta: { lokiLabel: LOCAL_NODE_ID, haMetrics: true, ...stats },
      },
    };
  } catch (err) {
    console.warn('[localproc] failed:', err.message);
    return null;
  }
}

module.exports = { fetchLocalProcStats };
