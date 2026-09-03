const fetch = require('node-fetch');
const https = require('https');

const K8S_URL = process.env.K8S_API_URL || 'https://192.168.7.53:6443';
const K8S_TOKEN = process.env.VITE_K8S_TOKEN;

const agent = new https.Agent({ rejectUnauthorized: false });

async function k8s(path) {
  const res = await fetch(`${K8S_URL}${path}`, {
    headers: { Authorization: `Bearer ${K8S_TOKEN}` },
    agent,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`k8s API ${res.status}: ${path}`);
  return res.json();
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Stable pod-name prefix for Loki's `pod` label. A Deployment pod's owner is a
// ReplicaSet named "<deployment>-<pod-template-hash>"; k8s stamps that hash on
// the pod as a label, so strip it exactly rather than guessing with a regex.
// StatefulSet / DaemonSet owner names are already the stable prefix.
function podPrefix(ownerName, pod) {
  const n = String(ownerName || '');
  const hash = pod?.metadata?.labels?.['pod-template-hash'];
  if (hash && n.endsWith('-' + hash)) return n.slice(0, -(hash.length + 1));
  return n;
}

// Display name — podPrefix plus de-duplication of repeated segments
// (infisical-infisical-standalone-infisical -> infisical-standalone).
function cleanAppName(ownerName, pod) {
  const n = podPrefix(ownerName, pod);
  const seen = new Set(), out = [];
  for (const p of n.split('-')) { if (p && !seen.has(p)) { seen.add(p); out.push(p); } }
  return out.join('-') || n;
}

function parseCpuM(str) {
  if (!str) return null;
  if (str.endsWith('n')) return Math.round(parseInt(str, 10) / 1e6); // nanocores → millicores
  if (str.endsWith('u')) return Math.round(parseInt(str, 10) / 1e3); // microcores → millicores
  if (str.endsWith('m')) return parseInt(str, 10);
  return Math.round(parseFloat(str) * 1000); // whole cores
}

function parseMemMiB(str) {
  if (!str) return null;
  if (str.endsWith('Ki')) return parseInt(str, 10) / 1024;
  if (str.endsWith('Mi')) return parseInt(str, 10);
  if (str.endsWith('Gi')) return parseFloat(str) * 1024;
  if (str.endsWith('Ti')) return parseFloat(str) * 1024 * 1024;
  return parseInt(str, 10) / (1024 * 1024);
}

const USER_NAMESPACES = ['homelab', 'infisical'];

const K3S_NODE_PLACEMENT = {
  navia:  { parentId: 'navia',  column: 'venti'  },
  chiori: { parentId: 'chiori', column: 'furina' },
  shenhe: { parentId: 'shenhe', column: 'nahida' },
};

async function fetchK8sNodes() {
  if (!K8S_TOKEN) { console.warn('[k8s] no K8S_TOKEN'); return { nodes: [], edges: [] }; }

  try {
    const podsData = await k8s('/api/v1/pods');
    const pods = podsData.items || [];

    const seen = new Map();

    for (const pod of pods) {
      const ns = pod.metadata?.namespace;
      if (!USER_NAMESPACES.includes(ns)) continue;

      const ownerRef = pod.metadata?.ownerReferences?.[0];
      const ownerKind = ownerRef?.kind;
      if (ownerKind === 'Job') continue;
      if (pod.status?.phase === 'Succeeded') continue;

      const podName = pod.metadata?.name;
      const nodeName = pod.spec?.nodeName;
      const rawName = ownerRef?.name || podName;
      const appName = cleanAppName(rawName, pod);                 // display
      const lokiPrefix = podPrefix(rawName, pod);                 // Loki `pod` label prefix
      const key = `${ns}/${appName}`;

      const running = pod.status?.containerStatuses?.some(c => c.state?.running);

      if (!seen.has(key)) {
        seen.set(key, { ns, nodeName, appName, lokiPrefix, ownerKind, podDown: !running, pod });
      } else if (running) {
        seen.get(key).podDown = false;
      }
    }

    // Map pod names → appName key for metrics matching
    const podToApp = {};
    for (const pod of pods) {
      const ns = pod.metadata?.namespace;
      if (!USER_NAMESPACES.includes(ns)) continue;
      const ownerRef = pod.metadata?.ownerReferences?.[0];
      const podName = pod.metadata?.name;
      const appName = cleanAppName(ownerRef?.name || podName, pod);
      podToApp[`${ns}/${podName}`] = `${ns}/${appName}`;
    }

    // Fetch pod metrics from metrics-server
    const appMetrics = {};
    try {
      for (const ns of USER_NAMESPACES) {
        const data = await k8s(`/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`);
        for (const pm of (data.items || [])) {
          const podKey = `${ns}/${pm.metadata.name}`;
          const appKey = podToApp[podKey];
          if (!appKey) continue;
          let cpuM = 0, memMiB = 0;
          for (const c of pm.containers || []) {
            cpuM += parseCpuM(c.usage?.cpu) || 0;
            memMiB += parseMemMiB(c.usage?.memory) || 0;
          }
          if (!appMetrics[appKey]) appMetrics[appKey] = { cpuM: 0, memMiB: 0 };
          appMetrics[appKey].cpuM += cpuM;
          appMetrics[appKey].memMiB += memMiB;
        }
      }
      const sample = Object.values(appMetrics)[0];
      console.log(`[k8s] metrics fetched for ${Object.keys(appMetrics).length} apps — sample: cpu=${sample?.cpuM}m mem=${sample?.memMiB}MiB`);
    } catch (e) {
      console.warn('[k8s] metrics fetch failed:', e.message);
    }

    // Node-level metrics for navia/chiori/shenhe — real OS usage, not Proxmox allocation
    const k8sNodeMetrics = {};
    const k8sNodeCapacity = {};
    try {
      const [usageData, capacityData] = await Promise.all([
        k8s('/apis/metrics.k8s.io/v1beta1/nodes'),
        k8s('/api/v1/nodes'),
      ]);
      for (const nm of (usageData.items || [])) {
        k8sNodeMetrics[nm.metadata.name] = {
          cpuM:   parseCpuM(nm.usage?.cpu),
          memMiB: parseMemMiB(nm.usage?.memory),
        };
      }
      for (const n of (capacityData.items || [])) {
        k8sNodeCapacity[n.metadata.name] = {
          cpuTotalM:   parseCpuM(n.status?.capacity?.cpu),
          memTotalMiB: parseMemMiB(n.status?.capacity?.memory),
        };
      }
      console.log(`[k8s] node-level metrics: ${Object.keys(k8sNodeMetrics).join(', ')}`);
    } catch (e) {
      console.warn('[k8s] node-level metrics failed:', e.message);
    }

    const nodes = [...seen.values()].map(({ ns, nodeName, appName, lokiPrefix, ownerKind, podDown, pod }) => {
      const placement = K3S_NODE_PLACEMENT[nodeName] || K3S_NODE_PLACEMENT.navia;
      const metrics = appMetrics[`${ns}/${appName}`];

      // Sum resource limits from pod spec containers
      let cpuLimitM = null, memLimitMiB = null;
      for (const c of pod?.spec?.containers || []) {
        const cpuL = parseCpuM(c.resources?.limits?.cpu);
        const memL = parseMemMiB(c.resources?.limits?.memory);
        if (cpuL) cpuLimitM = (cpuLimitM || 0) + cpuL;
        if (memL) memLimitMiB = (memLimitMiB || 0) + memL;
      }

      return {
        id: `k3s-${slugify(ns)}-${slugify(appName)}`,
        name: appName,
        type: 'k3s-service',
        status: podDown ? 'critical' : 'healthy',
        ip: null,
        parentId: placement.parentId,
        column: placement.column,
        layer: 'service',
        discovered: true,
        meta: {
          namespace: ns,
          createdByKind: ownerKind,
          lokiLabel: lokiPrefix || appName,
          podDown,
          ...(metrics ? {
            k8sMetrics: true,
            cpuM: Math.round(metrics.cpuM),
            memMiB: Math.round(metrics.memMiB),
            cpuLimitM,
            memLimitMiB,
          } : {}),
        },
      };
    });

    // Detect NFS volumes pointing to zhongli — inline volumes + PV fallback
    const nfsEdges = [];
    try {
      const ZHONGLI = ['192.168.7.10', 'zhongli'];
      let nfsPvcNames = new Set();
      try {
        const pvsData = await k8s('/api/v1/persistentvolumes');
        for (const pv of (pvsData.items || [])) {
          const nfsServer = pv.spec?.nfs?.server || '';
          if (!ZHONGLI.some(z => nfsServer.includes(z))) continue;
          const claimRef = pv.spec?.claimRef;
          if (claimRef) nfsPvcNames.add(`${claimRef.namespace}/${claimRef.name}`);
        }
      } catch { /* 403 — fall through to inline detection */ }

      const seenEdges = new Set();
      for (const pod of pods) {
        const ns = pod.metadata?.namespace;
        if (!USER_NAMESPACES.includes(ns)) continue;
        const vols = pod.spec?.volumes || [];

        const usesNfs = vols.some(v =>
          (v.nfs && ZHONGLI.some(z => (v.nfs.server || '').includes(z))) ||
          (v.persistentVolumeClaim && nfsPvcNames.has(`${ns}/${v.persistentVolumeClaim.claimName}`))
        );
        if (!usesNfs) continue;

        const ownerRef = pod.metadata?.ownerReferences?.[0];
        const appName = cleanAppName(ownerRef?.name || pod.metadata?.name, pod);
        // Always use k3s ID format — static normIdx would give 'nextcloud' but frontend has 'k3s-homelab-nextcloud'
        const targetId = `k3s-${slugify(ns)}-${slugify(appName)}`;
        if (seenEdges.has(targetId)) continue;
        seenEdges.add(targetId);
        nfsEdges.push({ id: `e-nfs-${targetId}`, source: targetId, target: 'zhongli', type: 'storage' });
      }
      console.log(`[k8s] ${nfsEdges.length} NFS edges to zhongli (${nfsPvcNames.size} PVCs: ${[...nfsPvcNames].join(', ')})`);
      console.log(`[k8s] NFS apps: ${[...seenEdges].join(', ')}`);
    } catch (e) {
      console.warn('[k8s] NFS detection failed:', e.message);
    }

    return { nodes, edges: nfsEdges, pods, nodeMetrics: k8sNodeMetrics, nodeCapacity: k8sNodeCapacity };
  } catch (err) {
    console.error('[k8s] failed:', err.message);
    return { nodes: [], edges: [], pods: [], nodeMetrics: {}, nodeCapacity: {} };
  }
}

module.exports = { fetchK8sNodes };
