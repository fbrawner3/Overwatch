import { useState } from 'react';
import { useGraphStore } from '../../store/graphStore';

const COMMANDS_BY_TYPE = {
  'proxmox-host': ['qm list', 'pct list', 'df -h', 'top', 'uptime'],
  'vm': ['kubectl get pods', 'kubectl get nodes', 'df -h', 'top', 'free -m', 'uptime'],
  'lxc': ['df -h', 'top', 'free -m', 'systemctl status', 'uptime'],
  'nas': ['df -h', 'ls /mnt', 'free -m', 'uptime'],
  'baremetal': ['top', 'df -h', 'uptime', 'free -m'],
  'cloud': ['df -h', 'top', 'uptime'],
};

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

function runCommand(cmd, node, metrics, nodes) {
  const hosted = nodes.filter(n => n.parentId === node.id);
  switch (cmd) {
    case 'kubectl get pods': {
      const pods = hosted.filter(n => n.type === 'app');
      if (!pods.length) return 'No resources found in default namespace.';
      const rows = pods.map(p => `${pad(p.name, 20)}${pad('1/1', 8)}${pad('Running', 12)}${pad('2d', 6)}${p.ip}`);
      return `${pad('NAME', 20)}${pad('READY', 8)}${pad('STATUS', 12)}${pad('AGE', 6)}IP\n${rows.join('\n')}`;
    }
    case 'kubectl get nodes': {
      const k3s = nodes.filter(n => n.type === 'vm' && n.meta?.specs?.includes('k3s'));
      const rows = k3s.map(n => `${pad(n.name, 12)}${pad(n.status === 'critical' ? 'NotReady' : 'Ready', 12)}${pad('control-plane', 16)}v1.30.4`);
      return `${pad('NAME', 12)}${pad('STATUS', 12)}${pad('ROLES', 16)}VERSION\n${rows.join('\n')}`;
    }
    case 'qm list': {
      const vms = hosted.filter(n => n.type === 'vm');
      if (!vms.length) return 'No VMs found.';
      const rows = vms.map((v, i) => `${pad(String(100 + i), 6)}${pad(v.name, 18)}${pad('running', 12)}24G`);
      return `${pad('VMID', 6)}${pad('NAME', 18)}${pad('STATUS', 12)}MEM\n${rows.join('\n')}`;
    }
    case 'pct list': {
      const lxcs = hosted.filter(n => n.type === 'lxc');
      if (!lxcs.length) return 'No containers found.';
      const rows = lxcs.map((l, i) => `${pad(String(200 + i), 6)}${pad(l.name, 18)}running`);
      return `${pad('VMID', 6)}${pad('NAME', 18)}STATUS\n${rows.join('\n')}`;
    }
    case 'df -h': {
      const used = metrics?.diskPercent ?? 42;
      const total = 250;
      const usedGb = Math.round((used / 100) * total);
      const avail = total - usedGb;
      return `Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       ${total}G  ${usedGb}G  ${avail}G  ${Math.round(used)}% /\ntmpfs           16G   0G   16G   0% /dev/shm`;
    }
    case 'top': {
      const cpu = metrics?.cpuPercent ?? 20;
      const mem = metrics?.memPercent ?? 50;
      return `top - ${new Date().toLocaleTimeString()} up 14 days\nTasks: 142 total, 2 running\n%Cpu(s): ${Math.round(cpu)} us,  2 sy\nMiB Mem: ${Math.round(mem * 240)} used, ${Math.round((100 - mem) * 240)} free`;
    }
    case 'free -m': {
      const mem = metrics?.memPercent ?? 50;
      const total = 24000;
      const used = Math.round((mem / 100) * total);
      return `              total        used        free\nMem:          ${total}        ${used}        ${total - used}\nSwap:         4096           0        4096`;
    }
    case 'uptime': {
      const cpu = metrics?.cpuPercent ?? 20;
      return ` ${new Date().toLocaleTimeString()} up 14 days,  3:21,  1 user,  load average: 0.${Math.round(cpu)}, 0.12, 0.09`;
    }
    case 'systemctl status': {
      return `\u25CF postgresql.service - PostgreSQL 16 cluster\n   Active: active (running) since 2 weeks ago\n   Main PID: 842`;
    }
    case 'ls /mnt': {
      return ['media', 'backups', 'photos', 'documents'].join('\n');
    }
    default:
      return `command not found: ${cmd}`;
  }
}

export default function CommandConsole({ node }) {
  const metrics = useGraphStore(s => s.metrics);
  const nodes = useGraphStore(s => s.nodes);
  const [output, setOutput] = useState(null);
  const [active, setActive] = useState(null);
  const cmds = COMMANDS_BY_TYPE[node.type] || [];
  const hosted = nodes.filter(n => n.parentId === node.id);

  const run = (cmd) => {
    setActive(cmd);
    setOutput(runCommand(cmd, node, metrics[node.id], nodes));
  };

  return (
    <div className="mb-4">
      {hosted.length > 0 && (
        <div className="mb-3">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-2">Hosted Pods ({hosted.length})</div>
          <div className="flex flex-wrap gap-1">
            {hosted.map(h => (
              <span key={h.id} className="text-[10px] px-2 py-0.5 rounded border border-cyan-500/20 text-cyan-300 bg-cyan-500/5">{h.name}</span>
            ))}
          </div>
        </div>
      )}
      <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-2">Shell</div>
      <div className="flex flex-wrap gap-1 mb-2">
        {cmds.map(c => (
          <button key={c} onClick={() => run(c)} className={`text-[9px] px-2 py-1 rounded border font-mono transition-colors ${active === c ? 'border-cyan-400/50 text-cyan-200 bg-cyan-500/15' : 'border-slate-600/40 text-slate-400 hover:bg-slate-700/30'}`}>{c}</button>
        ))}
      </div>
      {output !== null && (
        <div className="rounded bg-black/50 border border-slate-700/40 p-2.5">
          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-cyan-400 text-[9px]">{node.name}@{node.type}:~$</span>
            <span className="text-slate-300 text-[9px]">{active}</span>
          </div>
          <pre className="text-[9px] text-green-300/90 font-mono whitespace-pre-wrap leading-relaxed">{output}</pre>
        </div>
      )}
    </div>
  );
}