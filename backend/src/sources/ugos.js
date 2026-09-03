const fetch = require('node-fetch');
const crypto = require('crypto');
const dns = require('dns/promises');

const UGOS_URL       = process.env.UGOS_URL       || 'http://192.168.7.10:9999';
const UGOS_USERNAME  = process.env.UGOS_USERNAME;
const UGOS_PASSWORD  = process.env.UGOS_PASSWORD;
const UGOS_NODE_ID   = process.env.UGOS_NODE_ID   || 'zhongli';
const UGOS_NODE_NAME = process.env.UGOS_NODE_NAME || 'Zhongli';
const UGOS_DISK_MOUNT = process.env.UGOS_DISK_MOUNT || '/volume1';

async function resolveIp(hostname) {
  try { return (await dns.lookup(hostname)).address; } catch { return null; }
}

function baseNode(ip, status, meta) {
  return {
    id: UGOS_NODE_ID,
    name: UGOS_NODE_NAME,
    type: 'nas',
    layer: 'host',
    isEdge: false,
    parentId: null,
    column: UGOS_NODE_ID,
    ip,
    status,
    meta: { lokiLabel: UGOS_NODE_ID, diskMountpoint: UGOS_DISK_MOUNT, haMetrics: true, ...meta },
  };
}

// UGOS uses RSA-encrypted login:
// 1. POST /ugreen/v1/verify/check?token= with {username} → response header x-rsa-token is base64 DER RSA public key
// 2. Encrypt password with PKCS1 v1.5, base64-encode result
// 3. POST /ugreen/v1/verify/login with {username, password: encryptedB64, is_simple: true, keepalive: true, otp: false} → data.token
// 4. All subsequent calls: append ?token={token}
async function ugosLogin() {
  const checkRes = await fetch(`${UGOS_URL}/ugreen/v1/verify/check?token=`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: UGOS_USERNAME }),
    signal: AbortSignal.timeout(8000),
  });
  if (!checkRes.ok) throw new Error(`UGOS check ${checkRes.status}`);

  const rsaB64 = checkRes.headers.get('x-rsa-token');
  if (!rsaB64) throw new Error('UGOS: no x-rsa-token in check response');

  const keyBuf = Buffer.from(rsaB64, 'base64');
  const keyStr = keyBuf.toString('utf8');

  let encryptedPassword;
  // UGOS uses -----BEGIN RSA PUBLIC KEY----- header but the body is SPKI DER (wrong header).
  // Strip headers and decode the body as DER SPKI.
  const pemBody = keyStr.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const spkiDer = Buffer.from(pemBody, 'base64');
  encryptedPassword = crypto.publicEncrypt(
    { key: spkiDer, format: 'der', type: 'spki', padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(UGOS_PASSWORD)
  ).toString('base64');

  const loginRes = await fetch(`${UGOS_URL}/ugreen/v1/verify/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: UGOS_USERNAME, password: encryptedPassword, is_simple: true, keepalive: true, otp: false }),
    signal: AbortSignal.timeout(8000),
  });
  if (!loginRes.ok) throw new Error(`UGOS login ${loginRes.status}`);
  const data = await loginRes.json();
  const token = data.data?.token;
  if (!token) throw new Error('UGOS: no token in login response');
  return token;
}

async function ugosGet(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${UGOS_URL}${path}${sep}token=${token}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`UGOS API ${res.status}: ${path}`);
  return res.json();
}

async function fetchUGOSNode() {
  if (!UGOS_USERNAME || !UGOS_PASSWORD) { console.warn('[ugos] no credentials'); return null; }

  const hostname = new URL(UGOS_URL).hostname;
  const ip = await resolveIp(hostname) || hostname;

  try {
    const token = await ugosLogin();

    const [statData, storageData, volumeData] = await Promise.all([
      ugosGet('/ugreen/v1/taskmgr/stat/get_all', token).catch(() => null),
      ugosGet('/ugreen/v1/storage/pool/list', token).catch(() => null),
      ugosGet('/ugreen/v1/storage/volume/list', token).catch(() => null),
    ]);

    const meta = {};

    if (statData) {
      const d = statData.data || statData;
      const cpuUsed = d.overview?.cpu?.[0]?.used_percent ?? d.cpu_usage;
      if (cpuUsed != null) meta.cpuPercent = cpuUsed;

      const memTotal = d.mem?.structure?.total ?? d.mem_total;
      const memUsed  = d.mem?.structure?.used  ?? d.mem_used;
      if (memTotal && memUsed != null) {
        meta.memTotalGiB = memTotal / (1024 ** 3);
        meta.memUsedGiB  = memUsed  / (1024 ** 3);
        meta.memPercent  = (memUsed / memTotal) * 100;
      }
    }

    // Prefer volume-level data (filesystem usage) over pool-level (raw RAID allocation).
    // Pool total/used reflect raw space allocated to RAID, not actual file usage.
    const storageSrc = volumeData || storageData;
    if (storageSrc) {
      const items = storageSrc.data?.result || storageSrc.data?.list || storageSrc.data?.volumes || [];
      const item = Array.isArray(items) ? items[0] : null;
      if (item) {
        const totalBytes = item.total ?? item.total_size ?? item.totalSize ?? item.size;
        const freeBytes  = item.free  ?? item.available  ?? item.free_size ?? 0;
        const usedBytes  = (item.used != null && item.used !== totalBytes)
          ? item.used
          : (totalBytes != null ? totalBytes - freeBytes : null);
        if (totalBytes && usedBytes != null) {
          meta.diskTotalTiB = totalBytes / (1024 ** 4);
          meta.diskUsedTiB  = usedBytes  / (1024 ** 4);
          meta.diskPercent  = (usedBytes / totalBytes) * 100;
        }
      }
    }

    console.log(`[ugos] ${UGOS_NODE_ID} cpu=${meta.cpuPercent?.toFixed(1)}% mem=${meta.memPercent?.toFixed(1)}% disk=${meta.diskUsedTiB?.toFixed(1)}/${meta.diskTotalTiB?.toFixed(1)} TiB`);
    return { node: baseNode(ip, 'healthy', meta) };
  } catch (err) {
    console.warn('[ugos] failed:', err.message);
    return { node: baseNode(ip, 'unknown', {}) };
  }
}

module.exports = { fetchUGOSNode };
