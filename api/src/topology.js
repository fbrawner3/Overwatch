const { fetchProxmoxNodes } = require('./sources/proxmox');
const { fetchK8sNodes } = require('./sources/k8s');
const { fetchDockerNodes } = require('./sources/docker');
const { fetchAuthentikEdges } = require('./sources/authentik');
const { fetchInfisicalEdges } = require('./sources/infisical');
const { buildDbPortMap, dbTypesFromEnvKeys } = require('./sources/dbprobe');
const { fetchNonProxmoxNodes } = require('./non-proxmox-nodes');
const { fetchHomeAssistantNode } = require('./sources/homeassistant');
const { fetchOPNsenseNode, fetchDhcpLeaseMap } = require('./sources/opnsense');
const { fetchLocalProcStats } = require('./sources/localproc');
const { fetchKazuhaStats } = require('./sources/kazuha');

async function buildTopology() {
  console.log('[topology] building...');

  const [proxmox, k8s, docker, nonPve, haStats, opnStats, procStats, kazuhaStats, dhcpLeases] = await Promise.all([
    fetchProxmoxNodes(),
    fetchK8sNodes(),
    fetchDockerNodes(),
    fetchNonProxmoxNodes(),
    fetchHomeAssistantNode(),
    fetchOPNsenseNode(),
    fetchLocalProcStats(),
    fetchKazuhaStats(),
    fetchDhcpLeaseMap(),
  ]);

  // Enrich non-Proxmox nodes with live data
  const nonPveNodes = nonPve.nodes.map(n => {
    // DHCP lease overrides DNS-resolved IP with current lease IP
    const leaseIp = dhcpLeases[n.id] || dhcpLeases[n.id.toLowerCase()];

    if (n.id === 'noelle' && haStats) {
      return {
        ...n,
        ip: leaseIp || n.ip,
        status: haStats.status,
        meta: { ...n.meta, cpuPercent: haStats.cpuPercent, memMiB: haStats.memMiB, memPercent: haStats.memPercent, diskGiB: haStats.diskGiB, diskPercent: haStats.diskPercent, haMetrics: true },
      };
    }
    if (n.id === 'cyno' && opnStats) {
      return {
        ...n,
        ip: leaseIp || n.ip,
        status: opnStats.status,
        meta: { ...n.meta, ...opnStats.meta },
      };
    }
    if (n.id === 'heizou' && procStats) {
      return {
        ...n,
        ip: leaseIp || n.ip,
        status: 'healthy', // if we can read /proc we are definitely up
        meta: { ...n.meta, cpuPercent: procStats.cpuPercent, memPercent: procStats.memPercent, diskPercent: procStats.diskPercent, haMetrics: true },
      };
    }
    if (n.id === 'kazuha' && kazuhaStats) {
      return {
        ...n,
        ip: leaseIp || n.ip,
        status: kazuhaStats.status,
        meta: { ...n.meta, cpuPercent: kazuhaStats.cpuPercent, memPercent: kazuhaStats.memPercent, diskPercent: kazuhaStats.diskPercent, haMetrics: true },
      };
    }
    return { ...n, ip: leaseIp || n.ip };
  });

  // Patch null IPs on Proxmox-discovered nodes using DHCP leases (covers any remaining gaps)
  const patchedProxmoxNodes = proxmox.nodes.map(n => {
    if (n.ip) return n;
    const leaseIp = dhcpLeases[n.id] || dhcpLeases[n.name?.toLowerCase()];
    return leaseIp ? { ...n, ip: leaseIp } : n;
  });

  // Enrich navia/chiori/shenhe with real k8s node-level CPU/memory usage from metrics-server.
  // Evaluator uses k8sNodeMetrics branch for these nodes, bypassing Proxmox allocation figures.
  const K3S_VMS = new Set(['navia', 'chiori', 'shenhe']);
  const enrichedProxmoxNodes = patchedProxmoxNodes.map(n => {
    if (!K3S_VMS.has(n.id)) return n;
    const nm = k8s.nodeMetrics?.[n.id];
    const nc = k8s.nodeCapacity?.[n.id];
    if (!nm && !nc) return n;
    return {
      ...n,
      meta: {
        ...n.meta,
        k8sNodeMetrics:    true,
        ...(nm?.cpuM    != null ? { k8sNodeCpuM:        nm.cpuM    } : {}),
        ...(nm?.memMiB  != null ? { k8sNodeMemMiB:      nm.memMiB  } : {}),
        ...(nc?.cpuTotalM   != null ? { k8sNodeCpuTotalM:   nc.cpuTotalM   } : {}),
        ...(nc?.memTotalMiB != null ? { k8sNodeMemTotalMiB: nc.memTotalMiB } : {}),
      },
    };
  });

  const allNodes = [
    ...nonPveNodes,
    ...enrichedProxmoxNodes,
    ...k8s.nodes,
    ...docker.nodes,
  ];

  const baseEdges = [
    ...nonPve.edges,
    ...proxmox.edges,
    ...k8s.edges,
    ...docker.edges,
  ];

  const [authentikEdges, infisicalEdges] = await Promise.all([
    fetchAuthentikEdges(allNodes),
    fetchInfisicalEdges(allNodes),
  ]);

  // Auto-detect app→DB edges
  const dbEdges = [];
  const lxcNodes = allNodes.filter(n => n.type === 'lxc' || n.type === 'vm');
  if (lxcNodes.length && k8s.pods?.length) {
    // Port probe: discover which LXC runs which DB (runs in parallel with auth edge fetches above)
    const dbPortMap = await buildDbPortMap(lxcNodes);


    const lxcMatchers = lxcNodes.map(n => {
      const terms = [n.id, n.name, n.ip].filter(Boolean).map(s => s.toLowerCase());
      const patterns = terms.map(t => /^\d+\.\d+/.test(t) ? t.replace(/\./g, '\\.') : `\\b${t}\\b`);
      return { nodeId: n.id, regex: new RegExp(patterns.join('|')) };
    });
    const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const seenDb = new Set();
    const addDbEdge = (appId, nodeId) => {
      const edgeId = `e-db-${appId}-${nodeId}`;
      if (seenDb.has(edgeId)) return;
      seenDb.add(edgeId);
      dbEdges.push({ id: edgeId, source: appId, target: nodeId, type: 'database' });
    };

    for (const pod of k8s.pods) {
      const ns = pod.metadata?.namespace;
      if (!['homelab', 'infisical'].includes(ns)) continue;
      const ownerRef = pod.metadata?.ownerReferences?.[0];
      const rawName = ownerRef?.name || pod.metadata?.name;
      const appName = ownerRef?.kind === 'ReplicaSet' ? rawName.replace(/-[a-z0-9]{7,12}$/, '') : rawName;
      const fullAppId = `k3s-${slug(ns)}-${slug(appName)}`;
      const envVars = (pod.spec?.containers || []).flatMap(c => c.env || []);

      // Path 1: plain env values contain LXC IP/hostname
      const envStr = envVars.map(e => (e.value || '').toLowerCase()).join(' ');
      for (const { nodeId, regex } of lxcMatchers) {
        if (regex.test(envStr)) addDbEdge(fullAppId, nodeId);
      }

      // Path 2: env key names reveal DB type → resolve via port probe map
      const envKeys = envVars.map(e => e.name || '');
      for (const dbType of dbTypesFromEnvKeys(envKeys)) {
        const nodeId = dbPortMap[dbType];
        if (nodeId) addDbEdge(fullAppId, nodeId);
      }
    }
    console.log(`[topology] ${dbEdges.length} DB edges auto-detected`);
  }

  const allEdges = [...baseEdges, ...authentikEdges, ...infisicalEdges, ...dbEdges];

  console.log(`[topology] done — ${allNodes.length} nodes, ${allEdges.length} edges`);

  return {
    nodes: allNodes,
    enrichments: [],
    edges: allEdges,
    lastUpdated: new Date().toISOString(),
  };
}

module.exports = { buildTopology };
