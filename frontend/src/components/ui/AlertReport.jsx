import { useGraphStore } from '../../store/graphStore';
import { getAlarmingSpokes, SPOKE_META } from '../../data/alerts';

function findAlertSource(node, nodes) {
  const nodeById = {};
  for (const n of nodes) nodeById[n.id] = n;
  if (node.status === 'critical' || node.status === 'warning') return node;
  let cur = node;
  while (cur?.parentId) {
    const parent = nodeById[cur.parentId];
    if (parent && (parent.status === 'critical' || parent.status === 'warning')) return parent;
    cur = parent;
  }
  for (const depId of (node.dependsOn || [])) {
    const dep = nodeById[depId];
    if (dep && (dep.status === 'critical' || dep.status === 'warning')) return dep;
  }
  return null;
}

function buildReport(node, source) {
  const isSelf = source.id === node.id;
  const isParent = source.id === node.parentId;
  const isDep = (node.dependsOn || []).includes(source.id);

  if (isSelf) {
    return {
      headline: 'Probe failed — endpoint unreachable',
      detail: `Last poll against ${node.ip} did not return a healthy status within the 10s timeout. The polling agent marked this target ${source.status.toUpperCase()}.`,
      logs: [
        `WARN  probe=${node.meta?.lokiLabel ?? node.id} status=${source.status.toUpperCase()}`,
        `ERROR connection refused — ${node.ip}:${node.meta?.nodePort || '443'}`,
        `INFO  next retry in 30s`,
      ],
    };
  }
  if (isParent) {
    return {
      headline: `Host node ${source.name} is NotReady — pod cannot be scheduled`,
      detail: `The k3s control-plane node hosting this pod is reporting ${source.status.toUpperCase()}. The kubelet is not accepting workloads, so this pod is Pending.`,
      logs: [
        `WARN  node=${source.name} status=${source.status.toUpperCase()}`,
        `ERROR pod ${node.name}: node ${source.name} NotReady`,
        `INFO  pod marked Pending — awaiting healthy node`,
      ],
    };
  }
  if (isDep) {
    return {
      headline: `Dependency ${source.name} is ${source.status.toUpperCase()} — readiness probe failing`,
      detail: `The readiness probe is failing because ${source.name} (${source.ip}) is not responding. The pod cannot serve traffic until the dependency recovers.`,
      logs: [
        `WARN  dependency=${source.name} status=${source.status.toUpperCase()}`,
        `ERROR readiness probe failed: dial ${source.ip}: connection refused`,
        `INFO  backoff: retry in 5s`,
      ],
    };
  }
  return {
    headline: `Upstream ${source.name} is ${source.status.toUpperCase()}`,
    detail: `An upstream component is degraded, impacting this pod.`,
    logs: [`WARN upstream=${source.name} status=${source.status.toUpperCase()}`],
  };
}

export default function AlertReport({ node }) {
  const nodes = useGraphStore(s => s.nodes);
  const metrics = useGraphStore(s => s.metrics);
  if (!node) return null;

  const source = findAlertSource(node, nodes);

  if (source) {
    const report = buildReport(node, source);
    const sevColor = source.status === 'critical' ? '#ff2200' : '#ff8800';
    return (
      <div className="mb-4">
        <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-2">Polling Agent Report</div>
        <div className="rounded border p-2.5" style={{ borderColor: sevColor + '55', background: sevColor + '0d' }}>
          <div className="flex items-center gap-1.5 mb-2">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: sevColor, boxShadow: `0 0 8px ${sevColor}` }} />
            <span className="text-[10px] font-bold tracking-wide" style={{ color: sevColor }}>{source.status.toUpperCase()}</span>
            <span className="text-[9px] text-slate-500 ml-auto">src: {source.name}</span>
          </div>
          <div className="text-[11px] text-slate-200 font-semibold mb-1.5 leading-snug">{report.headline}</div>
          <div className="text-[10px] text-slate-400 leading-snug mb-2">{report.detail}</div>
          <div className="text-[8px] text-slate-600 mb-1">LAST POLL: {new Date().toLocaleTimeString()}</div>
          <div className="rounded bg-black/40 border border-slate-700/40 p-2 mt-1.5">
            <div className="text-[8px] text-slate-500 mb-1 uppercase tracking-wider">agent log</div>
            {report.logs.map((l, i) => (
              <div key={i} className="text-[9px] font-mono leading-relaxed" style={{ color: l.startsWith('ERROR') ? sevColor : l.startsWith('WARN') ? '#ffcc66' : '#6a9a8a' }}>
                {l}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const spokes = getAlarmingSpokes(node.id, metrics, nodes);
  if (spokes.length > 0) {
    const topSev = spokes.some(s => s.severity === 'critical') ? 'critical' : 'warning';
    const color = topSev === 'critical' ? '#ff2200' : '#ff8800';
    return (
      <div className="mb-4">
        <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-2">Polling Agent Report</div>
        <div className="rounded border p-2.5" style={{ borderColor: color + '55', background: color + '0d' }}>
          <div className="flex items-center gap-1.5 mb-2">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
            <span className="text-[10px] font-bold tracking-wide" style={{ color }}>{topSev.toUpperCase()}</span>
          </div>
          <div className="text-[11px] text-slate-200 font-semibold mb-1.5 leading-snug">Resource threshold breached on {node.name}</div>
          <div className="text-[10px] text-slate-400 leading-snug mb-2">The polling agent reports the following resources outside healthy bounds. Tap a spoke for details.</div>
          <div className="space-y-1">
            {spokes.map(sp => {
              const meta = SPOKE_META[sp.key];
              const sc = sp.severity === 'critical' ? '#ff2200' : '#ff8800';
              const displayVal = typeof sp.value === 'number' ? `${sp.value.toFixed(0)}${meta.unit.trim()}` : String(sp.value).toUpperCase();
              return (
                <div key={sp.key} className="flex items-center justify-between text-[10px]">
                  <span style={{ color: sc }}>{meta.label}</span>
                  <span className="font-mono text-slate-300">{displayVal}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
