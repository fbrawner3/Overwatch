const fetch = require('node-fetch');
const https = require('https');
const dns = require('dns/promises');

const PVE_URL = process.env.PVE_URL || 'https://10.0.0.200:8006';
const PVE_TOKEN = process.env.PVE_TOKEN;

const agent = new https.Agent({ rejectUnauthorized: false });

async function pve(path) {
  const res = await fetch(`${PVE_URL}/api2/json${path}`, {
    headers: { Authorization: `PVEAPIToken=${PVE_TOKEN}` },
    agent,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Proxmox API ${res.status}: ${path}`);
  const json = await res.json();
  return json.data;
}

async function resolveIp(hostname) {
  try {
    const { address } = await dns.lookup(hostname);
    return address;
  } catch {
    const envKey = hostname.toUpperCase().replace(/-/g, '_') + '_IP';
    return process.env[envKey] || null;
  }
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function baseName(name) {
  return name.replace(/-(vm|ct)$/, '');
}

async function fetchProxmoxNodes() {
  if (!PVE_TOKEN) { console.warn('[proxmox] no PVE_TOKEN'); return { nodes: [], edges: [] }; }

  try {
    const pveNodes = await pve('/nodes');
    const nodes = [];
    const edges = [];
    const ZHONGLI = ['10.0.0.10', 'zhongli'];

    for (const pveNode of pveNodes) {
      const nodeName = pveNode.node;
      const nodeId = slugify(nodeName); // 'venti', 'nahida', etc. — column = nodeId
      const nodeIp = await resolveIp(nodeName);

      nodes.push({
        id: nodeId,
        name: nodeName.charAt(0).toUpperCase() + nodeName.slice(1),
        type: 'proxmox-host',
        layer: 'host',
        status: pveNode.status === 'online' ? 'healthy' : 'critical',
        ip: nodeIp,
        parentId: null,
        column: nodeId,
        discovered: true,
        meta: {
          lokiLabel: nodeName,
          cpu: pveNode.cpu,
          maxcpu: pveNode.maxcpu,
          mem: pveNode.mem,
          maxmem: pveNode.maxmem,
          uptime: pveNode.uptime,
        },
      });

      const [vms, lxcs] = await Promise.all([
        pve(`/nodes/${nodeName}/qemu`).catch(e => { console.warn(`[proxmox] ${nodeName}/qemu failed:`, e.message); return []; }),
        pve(`/nodes/${nodeName}/lxc`).catch(e => { console.warn(`[proxmox] ${nodeName}/lxc failed:`, e.message); return []; }),
      ]);

      console.log(`[proxmox] ${nodeName}: ${vms.length} VMs, ${lxcs.length} LXCs`);

      for (const vm of vms) {
        const pveId = `qemu/${vm.vmid}`;
        const base = baseName(vm.name || `vm-${vm.vmid}`);
        const vmId = slugify(base); // 'navia', 'albedo', etc. — no pve- prefix
        nodes.push({
          id: vmId,
          name: base,
          type: 'vm',
          status: vm.status === 'running' ? 'healthy' : 'critical',
          ip: null,
          parentId: nodeId,
          column: nodeId,
          layer: 'vm',
          discovered: true,
          meta: { pveId, pveNode: nodeName, lokiLabel: base, cpu: vm.cpu, maxcpu: vm.cpus, mem: vm.mem, maxmem: vm.maxmem, uptime: vm.uptime, disk: vm.disk, maxdisk: vm.maxdisk },
        });
        edges.push({ id: `e-host-${vmId}`, source: nodeId, target: vmId, type: 'hosts' });

        if (vm.status === 'running') {
          try {
            const netinfo = await pve(`/nodes/${nodeName}/qemu/${vm.vmid}/agent/network-get-interfaces`);
            const ifaces = netinfo?.result || [];
            for (const iface of ifaces) {
              if (iface.name === 'lo') continue;
              const ipv4 = (iface['ip-addresses'] || []).find(a =>
                a['ip-address-type'] === 'ipv4' && !a['ip-address'].startsWith('127.')
              );
              if (ipv4) { nodes[nodes.length - 1].ip = ipv4['ip-address']; break; }
            }
          } catch {
            // guest agent not available — try DNS
            const dnsIp = await resolveIp(base);
            if (dnsIp) nodes[nodes.length - 1].ip = dnsIp;
          }
          try {
            const fsinfo = await pve(`/nodes/${nodeName}/qemu/${vm.vmid}/agent/fsinfo`);
            const filesystems = fsinfo?.result || [];
            const hasZhongli = filesystems.some(fs =>
              fs.type === 'nfs' && ZHONGLI.some(z => (fs.name || '').includes(z))
            );
            if (hasZhongli) {
              console.log(`[proxmox] VM ${base} (${vm.vmid}) mounts zhongli NFS`);
              edges.push({ id: `e-nfs-${vmId}`, source: vmId, target: 'zhongli', type: 'storage' });
            }
          } catch { /* guest agent not running */ }
        }
      }

      for (const lxc of lxcs) {
        const pveId = `lxc/${lxc.vmid}`;
        const base = baseName(lxc.name || `ct-${lxc.vmid}`);
        const lxcId = slugify(base); // 'kirara', 'lyney', etc. — no pve- prefix
        nodes.push({
          id: lxcId,
          name: base,
          type: 'lxc',
          status: lxc.status === 'running' ? 'healthy' : 'critical',
          ip: null,
          parentId: nodeId,
          column: nodeId,
          layer: 'vm',
          discovered: true,
          meta: { pveId, pveNode: nodeName, lokiLabel: base, cpu: lxc.cpu, maxcpu: lxc.cpus, mem: lxc.mem, maxmem: lxc.maxmem, uptime: lxc.uptime, disk: lxc.disk, maxdisk: lxc.maxdisk },
        });
        edges.push({ id: `e-host-${lxcId}`, source: nodeId, target: lxcId, type: 'hosts' });

        try {
          const config = await pve(`/nodes/${nodeName}/lxc/${lxc.vmid}/config`);
          const net0 = config.net0 || '';
          const ipMatch = net0.match(/ip=([0-9.]+)/);
          if (ipMatch) {
            nodes[nodes.length - 1].ip = ipMatch[1];
          } else if (lxc.status === 'running') {
            // net0 uses dhcp or static set inside OS — read actual runtime interfaces
            try {
              const ifaces = await pve(`/nodes/${nodeName}/lxc/${lxc.vmid}/interfaces`);
              for (const iface of (Array.isArray(ifaces) ? ifaces : [])) {
                const addr = (iface['inet'] || iface['ip-address'] || '').split('/')[0];
                if (addr && !addr.startsWith('127.')) {
                  nodes[nodes.length - 1].ip = addr;
                  console.log(`[proxmox] ${base} IP from interfaces: ${addr}`);
                  break;
                }
              }
            } catch (e) { console.warn(`[proxmox] ${base} interfaces failed:`, e.message); }
          }
          const mpKeys = Object.keys(config).filter(k => /^mp\d+$/.test(k));
          const hasZhongliMount =
            mpKeys.some(k => ZHONGLI.some(z => String(config[k]).includes(z))) ||
            (config.description || '').includes('nfs:zhongli');
          if (hasZhongliMount) {
            console.log(`[proxmox] LXC ${base} (${lxc.vmid}) → zhongli NFS`);
            edges.push({ id: `e-nfs-${lxcId}`, source: lxcId, target: 'zhongli', type: 'storage' });
          }
        } catch (e) {
          console.warn(`[proxmox] config fetch failed for LXC ${lxc.vmid}:`, e.message);
        }
      }
    }

    // Detect NFS storage backends pointing to zhongli — add edge for each Proxmox host
    try {
      const storages = await pve('/storage');
      const nfsStorages = storages.filter(s =>
        s.type === 'nfs' && ZHONGLI.some(z => (s.server || '').includes(z))
      );
      if (nfsStorages.length > 0) {
        const hostNodes = nodes.filter(n => n.type === 'proxmox-host');
        for (const hostNode of hostNodes) {
          const edgeId = `e-nfs-pve-${hostNode.id}`;
          if (!edges.find(e => e.id === edgeId)) {
            edges.push({ id: edgeId, source: hostNode.id, target: 'zhongli', type: 'storage' });
          }
        }
        console.log(`[proxmox] ${nfsStorages.length} NFS storage(s) → ${hostNodes.length} host→zhongli edges`);
      }
    } catch (e) {
      console.warn('[proxmox] storage check failed:', e.message);
    }

    return { nodes, edges };
  } catch (err) {
    console.error('[proxmox] failed:', err.message);
    return { nodes: [], edges: [] };
  }
}

module.exports = { fetchProxmoxNodes };
