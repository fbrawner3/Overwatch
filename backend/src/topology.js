const { fetchProxmoxNodes } = require('./sources/proxmox');
const { fetchK8sNodes } = require('./sources/k8s');
const { fetchDockerNodes } = require('./sources/docker');
const { fetchAuthentikEdges } = require('./sources/authentik');
const { fetchInfisicalEdges } = require('./sources/infisical');
const { buildDbPortMap, dbTypesFromEnvKeys } = require('./sources/dbprobe');
const { fetchHomeAssistantNode } = require('./sources/homeassistant');
const { fetchOPNsenseNode, fetchDhcpLeaseMap } = require('./sources/opnsense');
const { fetchLocalProcStats } = require('./sources/localproc');
const { fetchKazuhaStats } = require('./sources/kazuha');
const { fetchUGOSNode } = require('./sources/ugos');
const { fetchSnmpNodes } = require('./sources/snmp');
const { listMaintenance, listFiringStates, recordSourceHealth, DEP_EDGE_DIRECTION } = require('./evaluate');

// Run a discovery fetch, never throw. Returns fallback on failure.
async function safe(name, fn, fallback) {
  try {
    const v = await fn();
    return v == null ? fallback : v;
  } catch (err) {
    console.warn(`[topology] source ${name} failed: ${err.message}`);
    return fallback;
  }
}

async function buildTopology() {
  console.log('[topology] building...');

  const [proxmox, k8s, docker, haResult, opnResult, procResult, kazuhaResult, ugosResult, snmpResult, dhcpLeases] = await Promise.all([
    safe('proxmox',      fetchProxmoxNodes,      { nodes: [], edges: [] }),
    safe('k8s',          fetchK8sNodes,          { nodes: [], edges: [], pods: [] }),
    safe('docker',       fetchDockerNodes,       { nodes: [], edges: [] }),
    safe('homeassistant', fetchHomeAssistantNode, null),
    safe('opnsense',     fetchOPNsenseNode,      null),
    safe('localproc',    fetchLocalProcStats,    null),
    safe('kazuha',       fetchKazuhaStats,       null),
    safe('ugos',         fetchUGOSNode,          null),
    safe('snmp',         fetchSnmpNodes,         { nodes: [] }),
    safe('dhcp',         fetchDhcpLeaseMap,      {}),
  ]);

  // Per-source health: a source that produced rows before and produces none now
  // is degraded — emit a synthetic critical node so reachability alerting has a
  // target, and (via the flag on the response) hold the evaluate stale sweep.
  const sourceCounts = {
    proxmox:       proxmox.nodes?.length || 0,
    k8s:           k8s.nodes?.length || 0,
    docker:        docker.nodes?.length || 0,
    homeassistant: haResult ? 1 : 0,
    opnsense:      opnResult ? 1 : 0,
    localproc:     procResult ? 1 : 0,
    kazuha:        kazuhaResult ? 1 : 0,
    ugos:          ugosResult ? 1 : 0,
    snmp:          snmpResult.nodes?.length || 0,
  };
  let sourceHealth = { degraded: false, sources: sourceCounts, downSources: [] };
  try { sourceHealth = recordSourceHealth(sourceCounts); } catch (e) { console.warn('[topology] source_health record failed:', e.message); }
  const syntheticNodes = sourceHealth.downSources.map(s => ({
    id: `source:${s}`, name: `${s} discovery`, type: 'source', status: 'critical',
    meta: { sourceDown: true },
  }));

  // Each non-Proxmox connector returns { node, edges? } or null.
  // Patch IPs from DHCP leases where the connector resolved via DNS.
  const nonPveConnectors = [haResult, opnResult, procResult, kazuhaResult, ugosResult].filter(Boolean);
  const nonPveNodes = nonPveConnectors.map(c => {
    const n = c.node;
    const leaseIp = dhcpLeases[n.id] || dhcpLeases[n.id.toLowerCase()];
    return leaseIp ? { ...n, ip: leaseIp } : n;
  });
  const nonPveEdges = nonPveConnectors.flatMap(c => c.edges || []);

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
    ...snmpResult.nodes,
    ...syntheticNodes,
  ];


  const baseEdges = [
    ...nonPveEdges,
    ...proxmox.edges,
    ...k8s.edges,
    ...docker.edges,
  ];

  const [authentikEdges, infisicalEdges] = await Promise.all([
    safe('authentik', () => fetchAuthentikEdges(allNodes), []),
    safe('infisical', () => fetchInfisicalEdges(allNodes), []),
  ]);

  // Edge-only sources — track their health too (no synthetic node, they don't
  // create graph nodes), and fold any degradation into the response flag.
  try {
    const edgeHealth = recordSourceHealth({
      authentik: authentikEdges.length,
      infisical: infisicalEdges.length,
    });
    if (edgeHealth.degraded) {
      sourceHealth = {
        degraded: true,
        sources: { ...sourceHealth.sources, ...edgeHealth.sources },
        downSources: [...sourceHealth.downSources, ...edgeHealth.downSources],
      };
    } else {
      sourceHealth.sources = { ...sourceHealth.sources, ...edgeHealth.sources };
    }
  } catch (e) { console.warn('[topology] edge source_health record failed:', e.message); }

  // Auto-detect app→DB edges
  const dbEdges = [];
  const lxcNodes = allNodes.filter(n => n.type === 'lxc' || n.type === 'vm');
  if (lxcNodes.length && k8s.pods?.length) {
    // Port probe: discover which LXC runs which DB (runs in parallel with auth edge fetches above)
    const dbPortMap = await safe('dbprobe', () => buildDbPortMap(lxcNodes), {});


    const lxcMatchers = lxcNodes.map(n => {
      const terms = [n.id, n.name, n.ip].filter(Boolean).map(s => s.toLowerCase());
      const patterns = terms.map(t => /^\d+\.\d+/.test(t) ? t.replace(/\./g, '\\.') : `\\b${t}\\b`);
      return { nodeId: n.id, regex: new RegExp(patterns.join('|')) };
    });
    const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const seenDb = new Set();
    // type: 'database' only when we actually confirmed a DB (env key names a DB
    // type + a port probe found it). A bare hostname/IP match in env is just a
    // dependency — geekygramps-mcp referencing katheryne is SSH/API, not a DB.
    const addDbEdge = (appId, nodeId, type = 'database') => {
      const edgeId = `e-db-${appId}-${nodeId}`;
      if (seenDb.has(edgeId)) return;
      seenDb.add(edgeId);
      dbEdges.push({ id: edgeId, source: appId, target: nodeId, type });
    };

    // In-cluster service matchers — an app that references another k3s service
    // by name in its env (REDIS_HOST=redis-master, DB_HOST=postgres, ...).
    const DATASTORE_RE = /redis|valkey|postgres|pgsql|mysql|maria|mongo|rabbitmq|memcache|nats|clickhouse|elastic|meilisearch|qdrant|typesense/i;
    const svcMatchers = (k8s.nodes || [])
      .filter(n => n.type === 'k3s-service')
      .map(n => {
        const nm = String(n.name || n.id).toLowerCase();
        if (nm.length < 4) return null;
        const rx = new RegExp(`(^|[^a-z0-9])${nm.replace(/[^a-z0-9]+/g, '[-_.]?')}([^a-z0-9]|$)`, 'i');
        return { nodeId: n.id, name: nm, rx };
      })
      .filter(Boolean);
    const seenSvc = new Set();
    const addSvcEdge = (appId, nodeId, isStore) => {
      if (appId === nodeId) return;
      const edgeId = `e-svc-${appId}-${nodeId}`;
      if (seenSvc.has(edgeId)) return;
      seenSvc.add(edgeId);
      dbEdges.push({ id: edgeId, source: appId, target: nodeId, type: isStore ? 'database' : 'depends_on' });
    };

    for (const pod of k8s.pods) {
      const ns = pod.metadata?.namespace;
      if (!['homelab', 'infisical'].includes(ns)) continue;
      const ownerRef = pod.metadata?.ownerReferences?.[0];
      const rawName = ownerRef?.name || pod.metadata?.name;
      const appName = ownerRef?.kind === 'ReplicaSet' ? rawName.replace(/-[a-z0-9]{7,12}$/, '') : rawName;
      const fullAppId = `k3s-${slug(ns)}-${slug(appName)}`;
      const envVars = (pod.spec?.containers || []).flatMap(c => c.env || []);

      const envStr = envVars.map(e => (e.value || '').toLowerCase()).join(' ');

      // Path 2 first: env key names reveal a DB type → confirmed via port probe →
      // a real 'database' edge (and dedup then keeps Path 1 from downgrading it).
      const envKeys = envVars.map(e => e.name || '');
      for (const dbType of dbTypesFromEnvKeys(envKeys)) {
        const nodeId = dbPortMap[dbType];
        if (nodeId) addDbEdge(fullAppId, nodeId, 'database');
      }

      // Path 1: a bare LXC IP/hostname in an env value — generic dependency only.
      for (const { nodeId, regex } of lxcMatchers) {
        if (regex.test(envStr)) addDbEdge(fullAppId, nodeId, 'depends_on');
      }

      // Path 3: env values name another in-cluster service (redis-master, etc.)
      for (const { nodeId, name, rx } of svcMatchers) {
        if (nodeId === fullAppId) continue;
        if (rx.test(envStr)) addSvcEdge(fullAppId, nodeId, DATASTORE_RE.test(name));
      }
    }
    console.log(`[topology] ${dbEdges.length} DB/service edges auto-detected`);
  }

  // Static semantic edges — cross-cutting relationships no single connector owns.
  // These represent known infrastructure wiring (tunnels, DNS dependencies).
  const semanticEdges = [
    { id: 'e-net-kirara-kazuha', source: 'kirara', target: 'kazuha', type: 'network' },
    { id: 'e-net-lyney-navia',   source: 'lyney',  target: 'navia',  type: 'network' },
    // SNMP switches hang off their uplink (default: the OPNsense firewall).
    ...snmpResult.nodes.map(n => ({
      id: `e-net-${n.id}-${n.uplink}`, source: n.id, target: n.uplink, type: 'network',
    })),
  ].filter(e => allNodes.some(n => n.id === e.source) && allNodes.some(n => n.id === e.target));

  // Keep only well-formed edges, and dedup by id OR by (source|target|type) so
  // that id-less edges from a connector don't all collapse into one.
  const seenEdge = new Set();
  const allEdges = [...baseEdges, ...authentikEdges, ...infisicalEdges, ...dbEdges, ...semanticEdges]
    .filter(e => {
      if (!e || typeof e.type !== 'string' || !e.source || !e.target) return false;
      const key = e.id || `${e.source}|${e.target}|${e.type}`;
      if (seenEdge.has(key)) return false;
      seenEdge.add(key);
      return true;
    });

  // Per-node relationship summary + health rollup, merged into meta so the
  // frontend renders directional dependency info and node state without
  // re-deriving anything from the full edge list or running its own thresholds.
  // Direction is per edge type — the consumer is not always e.source.
  const dependsOnByNode = new Map();
  const dependentsByNode = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const e of allEdges) {
    const dir = DEP_EDGE_DIRECTION[e.type];
    if (!dir) continue;
    const consumer = dir === 'out' ? e.source : e.target;
    const provider = dir === 'out' ? e.target : e.source;
    push(dependsOnByNode, consumer, { id: provider, type: e.type });
    push(dependentsByNode, provider, { id: consumer, type: e.type });
  }

  // topology used to have zero DB dependency; these two calls add one. If the
  // threshold DB is unreachable, degrade (no maintenance flags, no warning
  // rollup) and flag it, rather than failing the whole /topology response.
  let maintenanceMap = new Map();
  let firing = new Set();
  let dbDegraded = false;
  try {
    maintenanceMap = listMaintenance();
    firing = listFiringStates();
  } catch (err) {
    dbDegraded = true;
    console.warn('[topology] threshold DB unavailable — maintenance/health degraded:', err.message);
  }

  const enrichedNodes = allNodes.map(n => {
    const inMaintenance = maintenanceMap.has(n.id);
    // health reflects the real state; maintenance is a separate flag so it can
    // never mask a genuine critical.
    const health = (n.status === 'critical' || n.status === 'unknown') ? 'critical'
      : firing.has(n.id) ? 'warning'
      : 'healthy';
    return {
      ...n,
      meta: {
        ...n.meta,
        dependsOn:   dependsOnByNode.get(n.id)  || [],
        dependents:  dependentsByNode.get(n.id) || [],
        maintenance: inMaintenance,
        ...(inMaintenance ? { maintenanceInfo: maintenanceMap.get(n.id) } : {}),
        health,
        ...(dbDegraded ? { healthDegraded: true } : {}),
      },
    };
  });

  console.log(`[topology] done — ${enrichedNodes.length} nodes, ${allEdges.length} edges, ${maintenanceMap.size} in maintenance${dbDegraded ? ' (DB DEGRADED)' : ''}`);

  const degraded = {};
  if (dbDegraded)            degraded.threshold_db = true;
  if (sourceHealth.degraded) degraded.sources = sourceHealth.downSources;

  return {
    nodes: enrichedNodes,
    enrichments: [],
    edges: allEdges,
    sources: sourceHealth.sources,
    lastUpdated: new Date().toISOString(),
    ...(Object.keys(degraded).length ? { degraded } : {}),
  };
}

module.exports = { buildTopology };
