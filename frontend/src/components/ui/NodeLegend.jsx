const STROKE = '#6a8a9a';

const SHAPES = [
  { label: 'Firewall (OPNsense)', kind: 'octahedron' },
  { label: 'VPS / Cloud', kind: 'sphere' },
  { label: 'Proxmox Host', kind: 'hex' },
  { label: 'NAS / Bare Metal', kind: 'diamond' },
  { label: 'VM', kind: 'octagon' },
  { label: 'LXC Container', kind: 'disc' },
  { label: 'Docker App', kind: 'rect' },
  { label: 'k3s Service', kind: 'triangle' },
];

function poly(sides, rot = -Math.PI / 2, r = 6, cx = 8, cy = 8) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI / sides) * i + rot;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

export default function NodeLegend() {
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '9px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', fontFamily: 'monospace' }}>Node Types</div>
      <div>
        {SHAPES.map(s => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <svg width="16" height="16" style={{ flexShrink: 0 }}>
              {s.kind === 'hex'        && <polygon points={poly(6)} fill="none" stroke={STROKE} strokeWidth="1.2" />}
              {s.kind === 'diamond'    && <polygon points={poly(4)} fill="none" stroke={STROKE} strokeWidth="1.2" />}
              {s.kind === 'octagon'    && <polygon points={poly(8, Math.PI / 8)} fill="none" stroke={STROKE} strokeWidth="1.2" />}
              {s.kind === 'triangle'   && <polygon points={poly(3)} fill="none" stroke={STROKE} strokeWidth="1.2" />}
              {s.kind === 'octahedron' && <polygon points={poly(4, 0)} fill="none" stroke={STROKE} strokeWidth="1.2" />}
              {s.kind === 'sphere'     && <><circle cx="8" cy="8" r="6" fill="none" stroke={STROKE} strokeWidth="1.2" /><ellipse cx="8" cy="8" rx="6" ry="2.5" fill="none" stroke={STROKE} strokeWidth="0.8" /></>}
              {s.kind === 'disc'       && <ellipse cx="8" cy="8" rx="6" ry="3" fill="none" stroke={STROKE} strokeWidth="1.2" />}
              {s.kind === 'rect'       && <rect x="2" y="4" width="12" height="8" rx="2" fill="none" stroke={STROKE} strokeWidth="1.2" />}
            </svg>
            <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' }}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
