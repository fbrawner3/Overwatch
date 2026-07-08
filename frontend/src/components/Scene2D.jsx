import { useMemo, useRef, useState, useEffect } from 'react';
import { useGraphStore } from '../store/graphStore';
import { compute2DLayout, LEVELS } from '../data/layout2D';
import { STATUS_COLORS, EDGE_COLORS } from '../data/visualStyles';
import { getAlarmingSpokes, getEffectiveStatus } from '../data/alerts';
import { Cpu, MemoryStick, HardDrive, Wifi } from 'lucide-react';

const SHAPES = {
  'proxmox-host': { kind: 'hex', r: 44 },
  'nas':          { kind: 'diamond', r: 42 },
  'baremetal':    { kind: 'diamond', r: 42 },
  'vm':           { kind: 'octagon', r: 40 },
  'lxc':          { kind: 'circle', r: 32 },
  'firewall':     { kind: 'diamond', r: 44 },
  'vps':          { kind: 'circle', r: 36 },
  'app':          { kind: 'rect', w: 120, h: 44 },
  'k3s-service':  { kind: 'triangle', r: 36 },
};

const SPOKES = [
  { key: 'cpu', label: 'CPU', tip: 'CPU', angle: -135 },
  { key: 'mem', label: 'MEM', tip: 'Memory', angle: -45 },
  { key: 'disk', label: 'DISK', tip: 'Filesystem', angle: 45 },
  { key: 'net', label: 'NET', tip: 'Network', angle: 135 },
];
const SPOKE_ICONS = { cpu: Cpu, mem: MemoryStick, disk: HardDrive, net: Wifi };
const SPOKE_BY_KEY = Object.fromEntries(SPOKES.map(s => [s.key, s]));
const SPOKE_DIST = 62;
const SPOKE_R = 13;
const SPOKE_TYPES = new Set(['proxmox-host', 'nas', 'baremetal', 'cloud', 'vm', 'lxc']);

// Compute which nodes are dependents of critical/warning nodes
function computeAffectedDependents(nodes, edges) {
  const affectedSet = new Set();
  const childrenMap = {};
  for (const n of nodes) {
    if (n.parentId) {
      if (!childrenMap[n.parentId]) childrenMap[n.parentId] = [];
      childrenMap[n.parentId].push(n.id);
    }
  }

  const unhealthyIds = new Set(nodes.filter(n => n.status === 'critical' || n.status === 'warning').map(n => n.id));

  const queue = [...unhealthyIds];
  const visited = new Set(unhealthyIds);
  while (queue.length) {
    const id = queue.shift();
    for (const childId of (childrenMap[id] || [])) {
      if (!visited.has(childId)) {
        affectedSet.add(childId);
        visited.add(childId);
        queue.push(childId);
      }
    }
    for (const edge of edges) {
      if (edge.source === id && !visited.has(edge.target)) {
        affectedSet.add(edge.target);
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
  }

  return affectedSet;
}

// alert logic lives in data/alerts.js

function polyPoints(cx, cy, r, sides, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI / sides) * i + rot;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

export default function Scene2D() {
  const nodes = useGraphStore(s => s.nodes);
  const edges = useGraphStore(s => s.edges);
  const selectedId = useGraphStore(s => s.selectedId);
  const selectedSpoke = useGraphStore(s => s.selectedSpoke);
  const selectNode = useGraphStore(s => s.selectNode);
  const selectSpoke = useGraphStore(s => s.selectSpoke);
  const clearSelection = useGraphStore(s => s.clearSelection);
  const getVisibilityDepth = useGraphStore(s => s.getVisibilityDepth);
  const metrics = useGraphStore(s => s.metrics);

  const positions2D = useMemo(() => compute2DLayout(nodes), [nodes]);

  const involvedNodes = useMemo(() => {
    if (!selectedId) return null;
    const s = new Set([selectedId]);
    for (const e of edges) {
      if (e.source === selectedId) s.add(e.target);
      if (e.target === selectedId) s.add(e.source);
    }
    const selectedNode = nodes.find(n => n.id === selectedId);
    if (selectedNode?.parentId) s.add(selectedNode.parentId);
    for (const n of nodes) {
      if (n.parentId === selectedId) s.add(n.id);
    }
    return s;
  }, [selectedId, edges, nodes]);

  const affectedDependents = useMemo(() => computeAffectedDependents(nodes, edges), [nodes, edges]);
  const highlightedIds = useMemo(() => {
    const s = new Set(affectedDependents);
    for (const n of nodes) {
      const eff = getEffectiveStatus(n, metrics);
      if (eff === 'critical' || eff === 'warning') s.add(n.id);
    }
    return s;
  }, [affectedDependents, nodes, metrics]);

  const [t, setT] = useState({ x: 0, y: 0, scale: 1 });
  const containerRef = useRef(null);
  const drag = useRef({ active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  const bounds = useMemo(() => {
    const ps = Object.values(positions2D);
    if (!ps.length) return { minX: 0, minY: 0, maxX: 1600, maxY: 600 };
    const xs = ps.map(p => p.x);
    const ys = ps.map(p => p.y);
    return {
      minX: Math.min(...xs) - 90,
      minY: Math.min(...ys) - 50,
      maxX: Math.max(...xs) + 90,
      maxY: Math.max(...ys) + 90,
    };
  }, [positions2D]);
  const svgW = bounds.maxX - bounds.minX;
  const svgH = bounds.maxY - bounds.minY;

  // center + fit on mount
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const scale = Math.min((cw / svgW) * 0.95, (ch / svgH) * 0.95);
    const x = (cw - svgW * scale) / 2;
    const y = (ch - svgH * scale) / 2;
    setT({ x, y, scale });
  }, [svgW, svgH]);

  // wheel zoom (non-passive so we can preventDefault)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setT(prev => {
        const delta = -e.deltaY * 0.0015;
        const newScale = Math.max(0.3, Math.min(3, prev.scale * (1 + delta)));
        const ratio = newScale / prev.scale;
        return { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio, scale: newScale };
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onPointerDown = (e) => {
    drag.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y };
    containerRef.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.sx;
    const dy = e.clientY - drag.current.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.current.moved = true;
    setT(prev => ({ ...prev, x: drag.current.ox + dx, y: drag.current.oy + dy }));
  };
  const onPointerUp = (e) => {
    const wasMoved = drag.current.moved;
    drag.current.active = false;
    drag.current.moved = false;
    containerRef.current?.releasePointerCapture(e.pointerId);
    if (!wasMoved) clearSelection();
  };

  const zoomBy = (factor) => {
    const el = containerRef.current;
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setT(prev => {
      const newScale = Math.max(0.3, Math.min(3, prev.scale * factor));
      const ratio = newScale / prev.scale;
      return { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio, scale: newScale };
    });
  };
  const reset = () => {
    const el = containerRef.current;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const scale = Math.min((cw / svgW) * 0.95, (ch / svgH) * 0.95);
    setT({ x: (cw - svgW * scale) / 2, y: (ch - svgH * scale) / 2, scale });
  };

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: '#0A0A0B' }}>
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: drag.current.active ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transformOrigin: '0 0' }}>
          <svg width={svgW} height={svgH} viewBox={`${bounds.minX} ${bounds.minY} ${svgW} ${svgH}`} style={{ display: 'block' }}>
            {/* level guide lines + labels */}
            {LEVELS.map(l => (
              <g key={l.key}>
                <line x1={bounds.minX} y1={l.y} x2={bounds.maxX} y2={l.y} stroke="#101820" strokeWidth={1} />
                <text x={bounds.minX + 10} y={l.y - 12} fill="#2a3a4a" fontSize={11} fontFamily="ui-monospace, monospace" letterSpacing={2}>
                  {l.label}
                </text>
              </g>
            ))}

            {/* edges */}
            {edges.map(e => {
              const sp = positions2D[e.source];
              const tp = positions2D[e.target];
              if (!sp || !tp) return null;
              const isAlertEdge = highlightedIds.has(e.source) || highlightedIds.has(e.target);
              const isDirect = selectedId && (e.source === selectedId || e.target === selectedId);
              const opacity = selectedId
                ? (isDirect ? 0.85 : 0.04)
                : (isAlertEdge ? 0.5 : 0.18);
              return (
                <line key={e.id} x1={sp.x} y1={sp.y} x2={tp.x} y2={tp.y}
                  stroke={EDGE_COLORS[e.type] || '#223344'} strokeWidth={isDirect ? 2 : 1} opacity={opacity} />
              );
            })}

            {/* virtual parent-child lines when a node is selected */}
            {selectedId && (() => {
              const selPos = positions2D[selectedId];
              if (!selPos) return null;
              const selNode = nodes.find(n => n.id === selectedId);
              const lines = [];
              // selected → its parent
              if (selNode?.parentId) {
                const pp = positions2D[selNode.parentId];
                if (pp) lines.push(<line key={`vpc-parent`} x1={selPos.x} y1={selPos.y} x2={pp.x} y2={pp.y} stroke="#334455" strokeWidth={1.5} opacity={0.7} strokeDasharray="6 4" />);
              }
              // selected → its children
              for (const n of nodes) {
                if (n.parentId !== selectedId) continue;
                const cp = positions2D[n.id];
                if (cp) lines.push(<line key={`vpc-${n.id}`} x1={selPos.x} y1={selPos.y} x2={cp.x} y2={cp.y} stroke="#334455" strokeWidth={1.5} opacity={0.7} strokeDasharray="6 4" />);
              }
              return lines;
            })()}


            {/* nodes */}
            {nodes.map(n => {
              const p = positions2D[n.id];
              if (!p) return null;
              
              const eff = getEffectiveStatus(n, metrics);
              let color;
              let brightness = 1;
              if (eff === 'critical') {
                color = '#ff2200';
              } else if (eff === 'warning') {
                color = '#ff8800';
                brightness = 0.6;
              } else if (affectedDependents.has(n.id)) {
                color = '#ff8800';
                brightness = 1;
              } else {
                color = STATUS_COLORS.healthy;
              }
              
              const isCriticalOrWarning = eff === 'critical' || eff === 'warning' || affectedDependents.has(n.id);
              const opacity = isCriticalOrWarning ? brightness : involvedNodes ? (involvedNodes.has(n.id) ? brightness : brightness * 0.08) : brightness * 0.8;
              const isSelected = selectedId === n.id;
              const shape = SHAPES[n.type] || SHAPES.app;
              const isRect = shape.kind === 'rect';
              const isCircle = shape.kind === 'circle';
              const isPoly = !isRect && !isCircle;
              const sides = shape.kind === 'hex' ? 6 : shape.kind === 'diamond' ? 4 : shape.kind === 'octagon' ? 8 : shape.kind === 'triangle' ? 3 : shape.kind === 'firewall' ? 4 : 6;
              const rot = shape.kind === 'octagon' ? Math.PI / 8 : shape.kind === 'firewall' ? 0 : -Math.PI / 2;
              const polyPts = isPoly ? polyPoints(0, 0, shape.r, sides, rot) : null;
              const polyOutlinePts = isPoly ? polyPoints(0, 0, shape.r + 8, sides, rot) : null;
              const big = n.type === 'proxmox-host' || n.type === 'nas' || n.type === 'baremetal';
              const glowFilter = isSelected
                ? `drop-shadow(0 0 10px ${color}) drop-shadow(0 0 5px ${color})`
                : (involvedNodes?.has(n.id) ? `drop-shadow(0 0 6px ${color})` : 'none');
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={opacity}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => { ev.stopPropagation(); if (!drag.current.moved) selectNode(n.id); }}
                  style={{ cursor: 'pointer', filter: glowFilter }}>
                  {isSelected && isPoly && (
                    <polygon points={polyOutlinePts} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6} />
                  )}
                  {isSelected && isRect && (
                    <rect x={-shape.w / 2 - 6} y={-shape.h / 2 - 6} width={shape.w + 12} height={shape.h + 12} rx={10} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6} />
                  )}
                  {isSelected && isCircle && (
                    <circle r={shape.r + 8} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6} />
                  )}
                  {isPoly && (
                    <>
                      <polygon points={polyPts} fill="#080c14" stroke={color} strokeWidth={isSelected ? 3 : 1.5} />
                      {shape.kind === 'triangle' ? (
                        <>
                          <title>{n.name}</title>
                          <text textAnchor="middle" y={8} fill={color} fontSize={9} fontWeight="bold" fontFamily="ui-monospace, monospace">
                            {n.name.length > 11 ? n.name.slice(0, 10) + '…' : n.name}
                          </text>
                        </>
                      ) : (
                        <>
                          <text textAnchor="middle" y={-3} fill={color} fontSize={big ? 14 : 11} fontWeight="bold" fontFamily="ui-monospace, monospace">{n.name}</text>
                          <text textAnchor="middle" y={11} fill="#556677" fontSize={8} fontFamily="ui-monospace, monospace">{n.ip}</text>
                        </>
                      )}
                    </>
                  )}
                  {isCircle && (
                    <>
                      <circle r={shape.r} fill="#080c14" stroke={color} strokeWidth={isSelected ? 3 : 1.5} />
                      <text textAnchor="middle" y={-3} fill={color} fontSize={11} fontWeight="bold" fontFamily="ui-monospace, monospace">{n.name}</text>
                      <text textAnchor="middle" y={11} fill="#556677" fontSize={8} fontFamily="ui-monospace, monospace">{n.ip}</text>
                    </>
                  )}
                  {isRect && (
                    <>
                      <rect x={-shape.w / 2} y={-shape.h / 2} width={shape.w} height={shape.h} rx={8} fill="#0c1218" stroke={color} strokeWidth={isSelected ? 2.5 : 1.2} />
                      <text textAnchor="middle" y={-3} fill={color} fontSize={p.level === 'app' ? 10 : 9} fontWeight="bold" fontFamily="ui-monospace, monospace">{n.name}</text>
                      <text textAnchor="middle" y={10} fill="#556677" fontSize={7} fontFamily="ui-monospace, monospace">{n.ip}</text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* zoom controls */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-2 z-20">
        <button onClick={() => zoomBy(1.25)} className="w-10 h-10 rounded-lg bg-[#111820] border border-[#1f2d3d] text-cyan-300 hover:bg-[#162030] text-lg leading-none">+</button>
        <button onClick={() => zoomBy(0.8)} className="w-10 h-10 rounded-lg bg-[#111820] border border-[#1f2d3d] text-cyan-300 hover:bg-[#162030] text-lg leading-none">−</button>
        <button onClick={reset} className="w-10 h-10 rounded-lg bg-[#111820] border border-[#1f2d3d] text-cyan-300 hover:bg-[#162030] text-[10px]">fit</button>
      </div>
    </div>
  );
}