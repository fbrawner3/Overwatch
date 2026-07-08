export const TOPO_NODES = [
  // Edge
  { id: 'cyno', name: 'Cyno', type: 'firewall', status: 'healthy', ip: '10.0.1.1', parentId: null, column: 'cyno', isEdge: true, layer: 'edge', meta: { prometheusInstance: 'cyno', notes: 'Firewall - network gateway - OPNsense' } },
  { id: 'kazuha', name: 'Kazuha', type: 'vps', status: 'healthy', ip: 'AWS', parentId: 'cyno', column: 'cyno', isEdge: true, layer: 'edge', meta: { notes: 'AWS instance - Pangolin server - external tunnel endpoint' } },

  // Proxmox hosts and freestanding hosts
  { id: 'venti', name: 'Venti', type: 'proxmox-host', status: 'healthy', ip: '10.0.0.200', parentId: null, column: 'venti', layer: 'host', meta: { specs: 'Ryzen 5 7640HS - 27GB RAM - Ceph OSD 0', pveId: 'node/venti', lokiLabel: 'venti' } },
  { id: 'nahida', name: 'Nahida', type: 'proxmox-host', status: 'healthy', ip: '10.0.0.220', parentId: null, column: 'nahida', layer: 'host', meta: { specs: 'Ryzen 5 7640HS - 28GB RAM - Ceph OSD 2', pveId: 'node/nahida', lokiLabel: 'nahida' } },
  { id: 'furina', name: 'Furina', type: 'proxmox-host', status: 'healthy', ip: '10.0.0.230', parentId: null, column: 'furina', layer: 'host', meta: { specs: 'Ryzen 5 7640HS - 28GB RAM - Ceph OSD 1', pveId: 'node/furina', lokiLabel: 'furina' } },
  { id: 'raiden', name: 'Raiden', type: 'proxmox-host', status: 'healthy', ip: '10.0.0.210', parentId: null, column: 'raiden', layer: 'host', meta: { specs: 'Intel N150 - 12GB RAM - PBS + DBs', pveId: 'node/raiden', lokiLabel: 'raiden' } },
  { id: 'heizou', name: 'Heizou', type: 'baremetal', status: 'healthy', ip: '10.0.0.20', parentId: null, column: 'heizou', layer: 'host', meta: { notes: 'Monitoring host - Uptime Kuma', prometheusInstance: 'heizou', lokiLabel: 'heizou' } },
  { id: 'zhongli', name: 'Zhongli', type: 'nas', status: 'healthy', ip: '10.0.0.10', parentId: null, column: 'zhongli', layer: 'host', meta: { notes: 'NAS - NFS exports + Backrest - never migrate', prometheusInstance: '10.0.0.10:9100', lokiLabel: 'zhongli', diskMountpoint: '/volume1' } },
  { id: 'noelle', name: 'Noelle', type: 'baremetal', status: 'healthy', ip: '10.0.0.15', parentId: null, column: 'noelle', layer: 'host', meta: { notes: 'Home Assistant appliance', lokiLabel: 'noelle' } },

  // VMs and LXCs (proxmox-discovered, kept for layout anchoring)
  { id: 'navia', name: 'Navia', type: 'vm', status: 'healthy', ip: '10.0.0.53', parentId: 'venti', column: 'venti', layer: 'vm', meta: { specs: 'Debian VM - k3s control plane + worker - 4vCPU / 24GB', pveId: 'qemu/106', lokiLabel: 'navia', k3sWorker: true } },
  { id: 'kirara', name: 'Kirara', type: 'lxc', status: 'healthy', ip: '10.0.0.56', parentId: 'venti', column: 'venti', isAmbient: true, layer: 'vm', meta: { notes: 'LXC - Newt (Pangolin tunnel connector)', pveId: 'lxc/103', lokiLabel: 'kirara' } },
  { id: 'chiori', name: 'Chiori', type: 'vm', status: 'healthy', ip: '10.0.0.54', parentId: 'furina', column: 'furina', layer: 'vm', meta: { specs: 'Debian VM - k3s control plane + worker - 4vCPU / 24GB', pveId: 'qemu/107', lokiLabel: 'chiori', k3sWorker: true } },
  { id: 'shenhe', name: 'Shenhe', type: 'vm', status: 'healthy', ip: '10.0.0.55', parentId: 'nahida', column: 'nahida', layer: 'vm', meta: { specs: 'Debian VM - k3s control plane + worker - 4vCPU / 24GB', pveId: 'qemu/108', lokiLabel: 'shenhe', k3sWorker: true } },
  { id: 'lyney', name: 'Lyney', type: 'lxc', status: 'healthy', ip: '10.0.1.10', parentId: 'nahida', column: 'nahida', isAmbient: true, layer: 'vm', meta: { notes: 'LXC - Technitium DNS primary', pveId: 'lxc/104', lokiLabel: 'lyney' } },
  { id: 'lynette', name: 'Lynette', type: 'lxc', status: 'healthy', ip: '10.0.1.15', parentId: 'furina', column: 'furina', isAmbient: true, layer: 'vm', meta: { notes: 'LXC - Technitium DNS secondary', pveId: 'lxc/105', lokiLabel: 'lynette' } },
  { id: 'neuvillette', name: 'Neuvillette', type: 'vm', status: 'healthy', ip: '10.0.0.50', parentId: 'raiden', column: 'raiden', layer: 'vm', meta: { notes: 'VM - Proxmox Backup Server', pveId: 'qemu/100', lokiLabel: 'neuvillette' } },
  { id: 'ningguang', name: 'Ningguang', type: 'lxc', status: 'healthy', ip: '10.0.0.51', parentId: 'raiden', column: 'raiden', layer: 'vm', meta: { notes: 'LXC - PostgreSQL - permanent external DB', pveId: 'lxc/200', lokiLabel: 'ningguang' } },
  { id: 'yelan', name: 'Yelan', type: 'lxc', status: 'healthy', ip: '10.0.0.52', parentId: 'raiden', column: 'raiden', layer: 'vm', meta: { notes: 'LXC - MariaDB - permanent external DB', pveId: 'lxc/201', lokiLabel: 'yelan' } },
];

const MANUAL_EDGES = [
  // Physical hosting
  { id: 'e-cyno-kazuha', source: 'cyno', target: 'kazuha', type: 'network' },
  { id: 'e-venti-navia', source: 'venti', target: 'navia', type: 'hosts' },
  { id: 'e-venti-kirara', source: 'venti', target: 'kirara', type: 'hosts' },
  { id: 'e-furina-chiori', source: 'furina', target: 'chiori', type: 'hosts' },
  { id: 'e-furina-lynette', source: 'furina', target: 'lynette', type: 'hosts' },
  { id: 'e-nahida-shenhe', source: 'nahida', target: 'shenhe', type: 'hosts' },
  { id: 'e-nahida-lyney', source: 'nahida', target: 'lyney', type: 'hosts' },
  { id: 'e-raiden-ningguang', source: 'raiden', target: 'ningguang', type: 'hosts' },
  { id: 'e-raiden-yelan', source: 'raiden', target: 'yelan', type: 'hosts' },
  { id: 'e-raiden-neuvillette', source: 'raiden', target: 'neuvillette', type: 'hosts' },

  // Network
  { id: 'e-dns-lyney', source: 'lyney', target: 'navia', type: 'network' },
  { id: 'e-tun-kirara', source: 'kirara', target: 'kazuha', type: 'network' },
];

const explicitPairs = new Set(MANUAL_EDGES.map(e => [e.source, e.target].sort().join('|')));

const PARENT_EDGES = TOPO_NODES
  .filter(n => n.parentId && !explicitPairs.has([n.parentId, n.id].sort().join('|')))
  .map(n => ({ id: `e-host-${n.id}`, source: n.parentId, target: n.id, type: 'hosts' }));

export const TOPO_EDGES = [...MANUAL_EDGES, ...PARENT_EDGES];

export const COLUMN_X = {
  zhongli: -32,
  venti: -18,
  nahida: -6,
  raiden: 6,
  furina: 18,
  heizou: 32,
  kazuha: 0,
};

export const GLOBAL_SHARED_DEPS = ['ningguang', 'yelan', 'redis', 'infisical', 'authentik'];
