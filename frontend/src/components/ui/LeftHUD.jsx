import { useEffect, useRef } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { EDGE_COLORS, EDGE_LABELS, EDGE_DASHED } from '../../data/visualStyles';
import { getEffectiveStatus } from '../../data/alerts';
import NodeLegend from './NodeLegend';

const S = {
  sectionHeader: { fontSize: '9px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', fontFamily: 'monospace' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' },
  label: { fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' },
  value: { fontSize: '11px', color: '#e2e8f0', fontFamily: 'monospace', fontWeight: 600 },
  divider: { borderTop: '1px solid rgba(0,229,255,0.08)', margin: '12px 0' },
};

function Sparkline({ value, color, label }) {
  const canvasRef = useRef(null);
  const dataRef = useRef(null);
  if (!dataRef.current) dataRef.current = Array(30).fill(value > 0 ? value : 50);

  useEffect(() => {
    const interval = setInterval(() => {
      const data = dataRef.current;
      const last = data[data.length - 1];
      const next = Math.max(0, Math.min(100, last + (Math.random() - 0.5) * 8));
      data.push(next);
      data.shift();

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - (v / 100) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = color + '20';
      ctx.fill();
    }, 2000);
    return () => clearInterval(interval);
  }, [color]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
      <span style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: 'monospace' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '11px', color: '#67e8f9', fontFamily: 'monospace', fontWeight: 600 }}>{value.toFixed(0)}%</span>
        <canvas ref={canvasRef} width={60} height={20} style={{ opacity: 0.8 }} />
      </div>
    </div>
  );
}

export default function LeftHUD() {
  const nodes = useGraphStore(s => s.nodes);
  const metrics = useGraphStore(s => s.metrics);
  const lastUpdated = useGraphStore(s => s.lastUpdated);
  const live = true;

  const counts = {
    healthy: nodes.filter(n => getEffectiveStatus(n, metrics) === 'healthy').length,
    warning: nodes.filter(n => getEffectiveStatus(n, metrics) === 'warning').length,
    critical: nodes.filter(n => getEffectiveStatus(n, metrics) === 'critical').length,
  };

  const hostCount = nodes.filter(n => n.type === 'proxmox-host' || n.type === 'nas').length;
  const k3sNodes = nodes.filter(n => n.type === 'vm' && n.meta?.specs?.includes('k3s')).length;
  const serviceCount = nodes.filter(n => n.type === 'app' || n.type === 'k3s-service').length;

  const metricValues = Object.values(metrics);
  const cpuAvg = metricValues.length > 0 ? metricValues.reduce((s, m) => s + m.cpuPercent, 0) / metricValues.length : 0;
  const memAvg = metricValues.length > 0 ? metricValues.reduce((s, m) => s + m.memPercent, 0) / metricValues.length : 0;
  const netTotal = metricValues.reduce((s, m) => s + m.networkMbps, 0);

  const statusDots = [
    { label: 'Healthy', count: counts.healthy, color: '#00e5ff', glow: '#00e5ff' },
    { label: 'Warning', count: counts.warning, color: '#ff8800', glow: '#ff8800' },
    { label: 'Critical', count: counts.critical, color: '#ff2200', glow: '#ff2200' },
  ];

  return (
    <div style={{
      position: 'fixed',
      left: 0,
      top: 0,
      height: '100vh',
      width: '220px',
      background: 'rgba(4, 8, 18, 0.88)',
      borderRight: '1px solid rgba(0, 229, 255, 0.1)',
      fontFamily: 'monospace',
      zIndex: 50,
      overflowY: 'auto',
      overflowX: 'hidden',
      backdropFilter: 'blur(8px)',
      padding: '12px',
      boxSizing: 'border-box',
    }}>
      {/* Header */}
      <div style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid rgba(0,229,255,0.08)' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#67e8f9', letterSpacing: '0.06em', lineHeight: 1.2, fontFamily: 'monospace' }}>HOMELAB</div>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#67e8f9', letterSpacing: '0.06em', lineHeight: 1.2, fontFamily: 'monospace' }}>INFRASTRUCTURE</div>
        <div style={{ fontSize: '9px', color: '#475569', marginTop: '4px', letterSpacing: '0.12em', fontFamily: 'monospace' }}>REAL-TIME TOPOLOGY VIEW</div>
      </div>

      {/* System Status */}
      <div style={{ marginBottom: '16px' }}>
        <div style={S.sectionHeader}>System Status</div>
        {statusDots.map(({ label, count, color, glow }) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color, boxShadow: `0 0 6px ${glow}`, flexShrink: 0 }} />
              <span style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>{label}</span>
            </div>
            <span style={{ fontSize: '12px', color, fontWeight: 700, fontFamily: 'monospace' }}>{count}</span>
          </div>
        ))}
      </div>

      <div style={S.divider} />

      {/* Infrastructure */}
      <div style={{ marginBottom: '16px' }}>
        <div style={S.sectionHeader}>Infrastructure</div>
        {[['Hosts', hostCount], ['k3s Nodes', k3sNodes], ['Services', serviceCount], ['Volumes', 14]].map(([label, val]) => (
          <div key={label} style={S.row}>
            <span style={S.label}>{label}</span>
            <span style={S.value}>{val}</span>
          </div>
        ))}
      </div>

      <div style={S.divider} />

      {/* Live Metrics */}
      <div style={{ marginBottom: '16px' }}>
        <div style={S.sectionHeader}>Live Metrics</div>
        <Sparkline value={cpuAvg} color="#00e5ff" label="CPU Avg" />
        <Sparkline value={memAvg} color="#4488ff" label="Mem Avg" />
        <div style={S.row}>
          <span style={S.label}>Storage</span>
          <span style={{ fontSize: '11px', color: '#67e8f9', fontFamily: 'monospace', fontWeight: 600 }}>
            {(() => {
              const z = metrics['zhongli'];
              if (!z || !z.diskPercent) return '? / 12 TB';
              return `${(z.diskPercent / 100 * 12).toFixed(1)} / 12 TB`;
            })()}
          </span>
        </div>
        <div style={S.row}>
          <span style={S.label}>Network I/O</span>
          <span style={{ fontSize: '11px', color: '#67e8f9', fontFamily: 'monospace', fontWeight: 600 }}>{netTotal.toFixed(0)} Mbps</span>
        </div>
      </div>

      <div style={S.divider} />

      {/* Data Source */}
      <div style={{ marginBottom: '16px' }}>
        <div style={S.sectionHeader}>Data Source</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: live ? '#00e5ff' : '#ff8800', boxShadow: `0 0 8px ${live ? '#00e5ff' : '#ff8800'}` }} />
          <span style={{ fontSize: '10px', color: live ? '#67e8f9' : '#fb923c', fontFamily: 'monospace', fontWeight: 600 }}>{live ? 'LIVE' : 'MOCK'}</span>
        </div>
      </div>

      <div style={S.divider} />

      <NodeLegend />

      <div style={S.divider} />

      {/* Connections Legend */}
      <div style={{ marginBottom: '12px' }}>
        <div style={S.sectionHeader}>Connections</div>
        {Object.entries(EDGE_LABELS).map(([key, label]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            {EDGE_DASHED.has(key) ? (
              <svg width="20" height="6" style={{ flexShrink: 0 }}>
                <line x1="0" y1="3" x2="20" y2="3" stroke={EDGE_COLORS[key]} strokeWidth="2" strokeDasharray="4 3" />
              </svg>
            ) : (
              <span style={{ display: 'inline-block', height: '2px', width: '20px', borderRadius: '1px', background: EDGE_COLORS[key], flexShrink: 0 }} />
            )}
            <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Timestamp */}
      <div style={{ fontSize: '8px', color: '#334155', letterSpacing: '0.08em', fontFamily: 'monospace' }}>
        {lastUpdated ? `UPDATED ${new Date(lastUpdated).toLocaleTimeString()}` : 'AWAITING DATA'}
      </div>
    </div>
  );
}
