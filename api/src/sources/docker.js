const fetch = require('node-fetch');
const http = require('http');
const net = require('net');

const HEIZOU_SOCKET = '/var/run/docker.sock';
const ZHONGLI_URL = process.env.DOCKER_ZHONGLI_URL || 'http://10.0.0.10:2375';

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Fetch from Docker Unix socket
function fetchSocket(path) {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath: HEIZOU_SOCKET,
      path,
      method: 'GET',
      headers: { Host: 'localhost' },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('socket timeout')); });
    req.end();
  });
}

// Fetch from Docker TCP proxy
async function fetchTCP(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Docker API ${res.status}: ${path}`);
  return res.json();
}

function containerToNode(c, host, ip, parentId, column) {
  const name = (c.Names?.[0] || c.Name || '').replace(/^\//, '');
  if (!name) return null;
  const image = c.Image || '';
  const running = c.State === 'running' || c.Status?.startsWith('Up');
  return {
    id: `docker-${host}-${slugify(name)}`,
    name,
    type: 'app',
    status: running ? 'healthy' : 'critical',
    ip,
    parentId,
    column,
    layer: 'service',
    discovered: true,
    meta: {
      image,
      lokiLabel: name,
      dockerHost: host,
      dockerState: c.State,
      ports: c.Ports?.map(p => p.PublicPort).filter(Boolean) || [],
    },
  };
}

async function detectNfsEdges(containers, fetchFn, host) {
  try {
    const volumeData = await fetchFn('/volumes');
    const volumes = volumeData.Volumes || [];
    const ZHONGLI = ['10.0.0.10', 'zhongli'];

    const nfsVolumeNames = new Set(
      volumes
        .filter(v => {
          const opts = v.Options || {};
          return opts.type?.startsWith('nfs') &&
            ZHONGLI.some(z => (opts.o || '').includes(z) || (opts.device || '').includes(z));
        })
        .map(v => v.Name)
    );

    if (nfsVolumeNames.size === 0) return [];

    const edges = [];
    const seen = new Set();
    for (const c of containers) {
      const usesNfs = (c.Mounts || []).some(m => m.Type === 'volume' && nfsVolumeNames.has(m.Name));
      if (!usesNfs) continue;
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      if (!name) continue;
      const targetId = `docker-${host}-${slugify(name)}`;
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      edges.push({ id: `e-nfs-${targetId}`, source: targetId, target: 'zhongli', type: 'storage' });
    }
    console.log(`[docker] ${edges.length} NFS edges to zhongli`);
    return edges;
  } catch (err) {
    console.warn('[docker] NFS detection failed:', err.message);
    return [];
  }
}

function calcDockerCpuPercent(stats) {
  const cpu = stats.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const preCpu = stats.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const sys = stats.cpu_stats?.system_cpu_usage ?? 0;
  const preSys = stats.precpu_stats?.system_cpu_usage ?? 0;
  const numCpu = stats.cpu_stats?.online_cpus || 1;
  const cpuDelta = cpu - preCpu;
  const sysDelta = sys - preSys;
  if (sysDelta <= 0 || cpuDelta < 0) return 0;
  return (cpuDelta / sysDelta) * numCpu * 100;
}

function calcDockerMemMiB(stats) {
  const usage = stats.memory_stats?.usage ?? 0;
  const cache = stats.memory_stats?.stats?.cache ?? 0;
  return (usage - cache) / (1024 * 1024);
}

function calcDockerMemLimitMiB(stats) {
  const limit = stats.memory_stats?.limit ?? 0;
  return limit / (1024 * 1024);
}

async function fetchContainerMetrics(containers, fetchFn) {
  const results = await Promise.allSettled(
    containers.map(async c => {
      const id = c.Id || c.ID;
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const stats = await fetchFn(`/containers/${id}/stats?stream=false`);
      return {
        name,
        cpuPercent: calcDockerCpuPercent(stats),
        memMiB: calcDockerMemMiB(stats),
        memLimitMiB: calcDockerMemLimitMiB(stats),
      };
    })
  );
  const map = {};
  for (const r of results) {
    if (r.status === 'fulfilled') map[r.value.name] = r.value;
  }
  return map;
}

async function fetchDockerNodes() {
  const nodes = [];
  const edges = [];
  // Heizou — via socket
  let heizouContainers = [];
  try {
    heizouContainers = await fetchSocket('/containers/json?all=false');
    const heizouMetrics = await fetchContainerMetrics(heizouContainers, fetchSocket).catch(() => ({}));
    for (const c of heizouContainers) {
      const node = containerToNode(c, 'heizou', '10.0.0.20', 'heizou', 'heizou');
      if (node) {
        const m = heizouMetrics[node.name];
        if (m) {
          node.meta.dockerMetrics = true;
          node.meta.cpuPercent = Math.round(m.cpuPercent * 10) / 10;
          node.meta.memMiB = Math.round(m.memMiB);
          node.meta.memLimitMiB = Math.round(m.memLimitMiB);
        }
        nodes.push(node);
        edges.push({ id: `e-host-${node.id}`, source: 'heizou', target: node.id, type: 'hosts' });
      }
    }
    console.log(`[docker] heizou: ${heizouContainers.length} containers, ${Object.keys(heizouMetrics).length} with metrics`);
    const nfsEdges = await detectNfsEdges(heizouContainers, fetchSocket, 'heizou');
    edges.push(...nfsEdges);
  } catch (err) {
    console.error('[docker] heizou socket failed:', err.message);
  }

  // Zhongli — via TCP proxy
  const zhongliStart = nodes.length;
  try {
    const containers = await fetchTCP(ZHONGLI_URL, '/containers/json?all=false');
    const zhongliMetrics = await fetchContainerMetrics(
      containers,
      path => fetchTCP(ZHONGLI_URL, path)
    ).catch(() => ({}));
    for (const c of containers) {
      const node = containerToNode(c, 'zhongli', '10.0.0.10', 'zhongli', 'zhongli');
      if (node) {
        const m = zhongliMetrics[node.name];
        if (m) {
          node.meta.dockerMetrics = true;
          node.meta.cpuPercent = Math.round(m.cpuPercent * 10) / 10;
          node.meta.memMiB = Math.round(m.memMiB);
          node.meta.memLimitMiB = Math.round(m.memLimitMiB);
        }
        nodes.push(node);
        edges.push({ id: `e-host-${node.id}`, source: 'zhongli', target: node.id, type: 'hosts' });
      }
    }
    console.log(`[docker] zhongli: ${nodes.length - zhongliStart} containers, ${Object.keys(zhongliMetrics).length} with metrics`);
  } catch (err) {
    console.error('[docker] zhongli TCP failed:', err.message);
  }

  return { nodes, edges };
}

module.exports = { fetchDockerNodes };
