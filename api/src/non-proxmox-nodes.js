// Non-Proxmox infrastructure — IPs resolved via DNS (hostname must be resolvable)
// Falls back to env var if DNS fails. Only 5 nodes: cyno, kazuha, heizou, zhongli, noelle.
const dns = require('dns/promises');

async function resolveIp(hostname) {
  try {
    const { address } = await dns.lookup(hostname);
    return address;
  } catch {
    const envKey = hostname.toUpperCase().replace(/-/g, '_') + '_IP';
    return process.env[envKey] || null;
  }
}

async function fetchNonProxmoxNodes() {
  const [cynoIp, kazuhaIp, heizouIp, zhongliIp, noelleIp] = await Promise.all([
    resolveIp('cyno'),
    resolveIp('kazuha'),
    resolveIp('heizou'),
    resolveIp('zhongli'),
    resolveIp('noelle'),
  ]);

  return {
    nodes: [
      { id: 'cyno',    name: 'Cyno',    type: 'firewall',  layer: 'edge', isEdge: true,  parentId: null,   column: 'cyno',    ip: cynoIp,    meta: {} },
      { id: 'kazuha',  name: 'Kazuha',  type: 'vps',       layer: 'edge', isEdge: true,  parentId: 'cyno', column: 'cyno',    ip: kazuhaIp,  meta: {} },
      { id: 'heizou',  name: 'Heizou',  type: 'baremetal', layer: 'host', isEdge: false, parentId: null,   column: 'heizou',  ip: heizouIp,  meta: {} },
      { id: 'zhongli', name: 'Zhongli', type: 'nas',       layer: 'host', isEdge: false, parentId: null,   column: 'zhongli', ip: zhongliIp, meta: { diskMountpoint: '/volume1' } },
      { id: 'noelle',  name: 'Noelle',  type: 'baremetal', layer: 'host', isEdge: false, parentId: null,   column: 'noelle',  ip: noelleIp,  meta: {} },
    ],
    edges: [
      { id: 'e-net-cyno-kazuha',  source: 'cyno',   target: 'kazuha', type: 'network' },
      { id: 'e-net-kirara-kazuha', source: 'kirara', target: 'kazuha', type: 'network' },
      { id: 'e-net-lyney-navia',   source: 'lyney',  target: 'navia',  type: 'network' },
    ],
  };
}

module.exports = { fetchNonProxmoxNodes };
