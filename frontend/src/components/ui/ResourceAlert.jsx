import { useGraphStore } from '../../store/graphStore';
import { ALERT_THRESHOLDS, SPOKE_META, SPOKE_DESCRIPTIONS, isNetworkUp } from '../../data/alerts';

export default function ResourceAlert() {
  const selectedId = useGraphStore(s => s.selectedId);
  const selectedSpoke = useGraphStore(s => s.selectedSpoke);
  const metrics = useGraphStore(s => s.metrics);
  const nodes = useGraphStore(s => s.nodes);

  if (!selectedId || !selectedSpoke) return null;
  const m = metrics[selectedId];
  const node = nodes.find(n => n.id === selectedId);
  if (!node) return null;

  const meta = SPOKE_META[selectedSpoke];
  if (!meta) return null;

  const isLink = meta.kind === 'link';
  const isStatus = meta.kind === 'status';

  let severity, displayVal;
  if (isStatus) {
    const down = node?.meta?.[meta.field] === true;
    severity = down ? 'critical' : 'healthy';
    displayVal = down ? 'DOWN' : 'UP';
  } else if (isLink) {
    if (!m) return null;
    const up = isNetworkUp(m);
    severity = up ? 'healthy' : 'critical';
    displayVal = up ? 'UP' : 'DOWN';
  } else {
    if (!m) return null;
    const t = ALERT_THRESHOLDS[selectedSpoke];
    const val = m[meta.field];
    severity = val >= t.crit ? 'critical' : val >= t.warn ? 'warning' : 'healthy';
    displayVal = `${val.toFixed(0)}${meta.unit.trim()}`;
  }
  const color = severity === 'critical' ? '#ff2200' : severity === 'warning' ? '#ff8800' : '#00e5ff';

  return (
    <div className="mb-4">
      <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-2">Resource Probe — {meta.label}</div>
      <div className="rounded border p-2.5" style={{ borderColor: color + '55', background: color + '0d' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-bold tracking-wide" style={{ color }}>{severity.toUpperCase()}</span>
          <span className="text-lg font-bold font-mono" style={{ color }}>{displayVal}</span>
        </div>
        <div className="text-[10px] text-slate-400 leading-snug mb-2">
          {severity === 'healthy'
            ? `${meta.label} on ${node.name} is within healthy bounds.`
            : SPOKE_DESCRIPTIONS[selectedSpoke]}
        </div>
        {isStatus || isLink ? (
          <div className="text-[8px] text-slate-600">{isStatus ? 'k3s pod state · running/down' : 'SNMP link state · up/down only'}</div>
        ) : (
          <div className="text-[8px] text-slate-600 flex justify-between">
            <span>warn ≥ {ALERT_THRESHOLDS[selectedSpoke].warn}{meta.unit.trim()}</span>
            <span>crit ≥ {ALERT_THRESHOLDS[selectedSpoke].crit}{meta.unit.trim()}</span>
          </div>
        )}
      </div>
    </div>
  );
}