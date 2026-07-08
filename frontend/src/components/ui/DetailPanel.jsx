import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGraphStore } from '../../store/graphStore';
import { getNodeLogs } from '../../services/logsService';
import { getEffectiveStatus } from '../../data/alerts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const STATUS_COLORS = {
  healthy: '#00e5ff',
  warning: '#ff8800',
  critical: '#ff2200',
  unknown: '#556677',
};

const STATUS_LABELS = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
};

const TYPE_LABELS = {
  'proxmox-host': 'Proxmox Host',
  nas: 'NAS',
  baremetal: 'Bare Metal',
  vm: 'Virtual Machine',
  lxc: 'LXC Container',
  app: 'Application',
  cloud: 'Cloud Node',
};

const S = {
  label: { fontSize: '11px', color: '#64748b', fontFamily: 'monospace' },
  value: { fontSize: '11px', color: '#cbd5e1', fontFamily: 'monospace' },
  valueAccent: { fontSize: '11px', color: '#67e8f9', fontFamily: 'monospace' },
  sectionHeader: { fontSize: '9px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px', fontFamily: 'monospace' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' },
  noData: { fontSize: '11px', color: '#64748b', fontFamily: 'monospace', padding: '8px 0' },
};

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Gauge({ label, value, detail }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const barColor = pct > 85 ? '#ef4444' : pct > 65 ? '#f59e0b' : '#00e5ff';
  return (
    <div style={{ background: 'rgba(0,229,255,0.04)', border: '1px solid rgba(0,229,255,0.1)', borderRadius: '4px', padding: '8px', marginBottom: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
        <span style={{ fontSize: '9px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: 'monospace' }}>{label}</span>
        <span style={{ fontSize: '11px', color: barColor, fontFamily: 'monospace', fontWeight: 700 }}>{pct.toFixed(0)}%</span>
      </div>
      <div style={{ height: '4px', background: '#1e293b', borderRadius: '2px' }}>
        <div style={{ height: '4px', background: barColor, borderRadius: '2px', width: `${pct}%`, transition: 'width 0.3s ease' }} />
      </div>
      {detail && <div style={{ fontSize: '9px', color: '#64748b', fontFamily: 'monospace', marginTop: '4px', textAlign: 'right' }}>{detail}</div>}
    </div>
  );
}

function pathFor(points, max) {
  if (!points.length) return '';
  return points.map(([, value], index) => {
    const x = points.length === 1 ? 120 : (index / (points.length - 1)) * 120;
    const y = 36 - (value / max) * 28;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function NetworkSparkline({ metrics, range }) {
  const rx = range.rx || [];
  const tx = range.tx || [];
  const allValues = [...rx, ...tx].map(([, v]) => v);
  const max = Math.max(...allValues, 1);
  const latestRx = rx.length ? rx[rx.length - 1][1] : (metrics?.networkRxBytes ?? 0);
  const latestTx = tx.length ? tx[tx.length - 1][1] : (metrics?.networkTxBytes ?? 0);
  return (
    <div style={{ background: 'rgba(0,229,255,0.04)', border: '1px solid rgba(0,229,255,0.1)', borderRadius: '4px', padding: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
        <span style={{ fontSize: '9px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: 'monospace' }}>Network</span>
        <span style={{ fontSize: '11px', color: '#67e8f9', fontFamily: 'monospace' }}>{(metrics?.networkMbps ?? 0).toFixed(1)} Mbps</span>
      </div>
      <svg viewBox="0 0 120 40" style={{ width: '100%', height: '40px', display: 'block' }}>
        <polyline points={pathFor(rx, max)} fill="none" stroke="#00e5ff" strokeWidth="2" />
        <polyline points={pathFor(tx, max)} fill="none" stroke="#f59e0b" strokeWidth="2" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
        <span style={{ fontSize: '8px', color: '#64748b', fontFamily: 'monospace' }}>↓ RX {latestRx.toFixed(0)} B/s</span>
        <span style={{ fontSize: '8px', color: '#64748b', fontFamily: 'monospace' }}>↑ TX {latestTx.toFixed(0)} B/s</span>
      </div>
    </div>
  );
}

function logColor(line) {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('critical') || lower.includes('fatal')) return '#ff5c5c';
  if (lower.includes('warn')) return '#f59e0b';
  return '#94a3b8';
}

const NGINX_RE = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\w+)\s+(\S+)\s+[^"]*"\s+(\d{3})/;
const METHOD_COLORS = { GET: '#0891b2', POST: '#10b981', PUT: '#f59e0b', DELETE: '#ef4444', PATCH: '#8b5cf6' };
const STATUS_COLOR = s => s < 300 ? '#10b981' : s < 400 ? '#0891b2' : s < 500 ? '#f59e0b' : '#ef4444';

function parseLogLine(line) {
  const m = line.match(NGINX_RE);
  if (!m) return null;
  const [, ip, , method, path, statusStr] = m;
  const status = Number(statusStr);
  return { ip, method, path: path.length > 48 ? path.slice(0, 48) + '…' : path, status };
}

function LogEntry({ entry }) {
  const parsed = parseLogLine(entry.line);
  if (parsed) {
    const { ip, method, path, status } = parsed;
    return (
      <div style={{ borderLeft: `2px solid ${STATUS_COLOR(status)}`, paddingLeft: '6px', marginBottom: '5px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1px' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, fontFamily: 'monospace', color: METHOD_COLORS[method] || '#94a3b8', marginRight: '6px' }}>{method}</span>
          <span style={{ fontSize: '9px', fontFamily: 'monospace', color: '#cbd5e1', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
          <span style={{ fontSize: '9px', fontFamily: 'monospace', color: STATUS_COLOR(status), marginLeft: '6px', fontWeight: 700 }}>{status}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '8px', color: '#475569', fontFamily: 'monospace' }}>{ip}</span>
          <span style={{ fontSize: '8px', color: '#475569', fontFamily: 'monospace' }}>{formatLogTs(entry.ts)}</span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ borderLeft: '2px solid #1e293b', paddingLeft: '6px', marginBottom: '5px' }}>
      <div style={{ fontSize: '8px', color: '#475569', fontFamily: 'monospace', marginBottom: '1px' }}>{formatLogTs(entry.ts)}</div>
      <div style={{ fontSize: '9px', color: logColor(entry.line), fontFamily: 'monospace', wordBreak: 'break-word', lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>{entry.line}</div>
    </div>
  );
}

function formatLogTs(ts) {
  const ms = Number(ts) / 1e6;
  if (!Number.isFinite(ms)) return '--:--:--';
  return new Date(ms).toLocaleTimeString();
}

export default function DetailPanel() {
  const selectedId = useGraphStore(s => s.selectedId);
  const clearSelection = useGraphStore(s => s.clearSelection);
  const nodes = useGraphStore(s => s.nodes);
  const edges = useGraphStore(s => s.edges);
  const metrics = useGraphStore(s => s.metrics);

  const logs = useGraphStore(s => s.logs);
  const updateLogs = useGraphStore(s => s.updateLogs);

  const node = selectedId ? nodes.find(n => n.id === selectedId) : null;
  const status = node ? getEffectiveStatus(node, metrics) : 'unknown';
  const statusColor = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  const configuredForMetrics = Boolean(
    node?.meta?.k8sMetrics ||
    node?.meta?.dockerMetrics ||
    node?.meta?.haMetrics ||
    node?.meta?.maxcpu != null
  );
  const dependencies = node ? Array.from(new Set([...(node?.dependsOn || []), ...edges.filter(e => e.target === node.id).map(e => e.source)])) : [];
  const dependents = node ? Array.from(new Set(edges.filter(e => e.source === node.id).map(e => e.target))) : [];
  const nodeLogs = selectedId ? logs[selectedId] || [] : [];

  useEffect(() => {
    if (!node) return undefined;
    const nodeId = node.id;
    const lokiLabel = node.meta?.lokiLabel ?? node.id;
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        const nextLogs = await getNodeLogs(lokiLabel, 50);
        if (!cancelled) updateLogs(nodeId, nextLogs);
      } catch {
        if (!cancelled) updateLogs(nodeId, []);
      }
    };
    fetchLogs();
    const interval = window.setInterval(fetchLogs, 30_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [node, updateLogs]);

  return (
    <AnimatePresence>
      {node && (
        <motion.div
          initial={{ x: 320, opacity: 0 }}
          animate={{ x: 0, opacity: 1, transition: { duration: 0.25, ease: 'easeOut' } }}
          exit={{ x: 320, opacity: 0, transition: { duration: 0.15 } }}
          style={{
            position: 'fixed',
            right: 0,
            top: 0,
            height: '100vh',
            width: '320px',
            background: 'rgba(4, 8, 18, 0.92)',
            borderLeft: '1px solid rgba(0, 229, 255, 0.15)',
            backdropFilter: 'blur(16px)',
            fontFamily: 'monospace',
            zIndex: 50,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '16px',
            boxSizing: 'border-box',
          }}
        >
          {/* Close button — absolute top-right, out of content flow */}
          <button
            onClick={clearSelection}
            style={{
              position: 'absolute',
              top: '12px',
              right: '12px',
              background: 'rgba(0,229,255,0.08)',
              border: '1px solid rgba(0,229,255,0.2)',
              borderRadius: '4px',
              color: '#64748b',
              cursor: 'pointer',
              fontSize: '11px',
              lineHeight: 1,
              padding: '3px 7px',
              fontFamily: 'monospace',
            }}
            onMouseOver={e => e.currentTarget.style.color = '#67e8f9'}
            onMouseOut={e => e.currentTarget.style.color = '#64748b'}
          >
            ESC
          </button>

          {/* Header */}
          <div style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid rgba(0,229,255,0.12)', paddingRight: '48px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ height: '10px', width: '10px', borderRadius: '9999px', background: statusColor, boxShadow: `0 0 10px ${statusColor}`, flexShrink: 0 }} />
              <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#f1f5f9', margin: 0, fontFamily: 'monospace' }}>{node.name || node.id}</h2>
            </div>
            <div style={{ marginTop: '4px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b' }}>
              {TYPE_LABELS[node.type] || node.type}
            </div>
          </div>

          <Tabs key={node.id} defaultValue="status">
            <TabsList
              className="w-full border border-cyan-500/10 bg-cyan-500/5"
              style={{ display: 'grid', gridTemplateColumns: `repeat(${configuredForMetrics ? 3 : 2}, minmax(0, 1fr))` }}
            >
              <TabsTrigger value="status" className="text-[10px]">Status</TabsTrigger>
              {configuredForMetrics && <TabsTrigger value="metrics" className="text-[10px]">Metrics</TabsTrigger>}
              <TabsTrigger value="logs" className="text-[10px]">Logs</TabsTrigger>
            </TabsList>

            <TabsContent value="status">
              <div style={{ marginTop: '16px' }}>
                {/* Info rows */}
                {[
                  ['Name', node.name],
                  ['Type', TYPE_LABELS[node.type] || node.type],
                  ['IP', node.ip],
                  ['Layer', node.layer],
                ].map(([label, val]) => (
                  <div key={label} style={S.row}>
                    <span style={S.label}>{label}</span>
                    <span style={label === 'IP' ? S.valueAccent : S.value}>{val}</span>
                  </div>
                ))}
                <div style={S.row}>
                  <span style={S.label}>Status</span>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor, fontFamily: 'monospace' }}>{STATUS_LABELS[status] || status}</span>
                </div>

                {/* Dependents — things that depend on this node */}
                {dependents.length > 0 && (
                  <div style={{ marginTop: '14px' }}>
                    <div style={S.sectionHeader}>Dependents</div>
                    {dependents.map(depId => {
                      const dep = nodes.find(n => n.id === depId);
                      const depColor = STATUS_COLORS[dep?.status || 'unknown'] || STATUS_COLORS.unknown;
                      return (
                        <div key={depId} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                          <span style={{ height: '6px', width: '6px', borderRadius: '50%', background: depColor, flexShrink: 0 }} />
                          <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' }}>{dep?.name || depId}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Dependencies — things this node depends on */}
                {dependencies.length > 0 && (
                  <div style={{ marginTop: '14px' }}>
                    <div style={S.sectionHeader}>Dependencies</div>
                    {dependencies.map(depId => {
                      const dep = nodes.find(n => n.id === depId);
                      const depColor = STATUS_COLORS[dep?.status || 'unknown'] || STATUS_COLORS.unknown;
                      return (
                        <div key={depId} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                          <span style={{ height: '6px', width: '6px', borderRadius: '50%', background: depColor, flexShrink: 0 }} />
                          <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' }}>{dep?.name || depId}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Specs */}
                {node.meta?.specs && (
                  <div style={{ marginTop: '14px' }}>
                    <div style={S.sectionHeader}>Specs</div>
                    <p style={{ fontSize: '10px', color: '#94a3b8', lineHeight: '1.4', margin: 0, fontFamily: 'monospace' }}>{node.meta.specs}</p>
                  </div>
                )}

                {/* Notes */}
                {node.meta?.notes && (
                  <div style={{ marginTop: '14px' }}>
                    <div style={S.sectionHeader}>Notes</div>
                    <p style={{ fontSize: '10px', color: '#94a3b8', lineHeight: '1.4', margin: 0, fontFamily: 'monospace' }}>{node.meta.notes}</p>
                  </div>
                )}
              </div>
            </TabsContent>

            {configuredForMetrics && (
              <TabsContent value="metrics">
                <div style={{ marginTop: '16px' }}>
                  {node.meta?.k8sMetrics ? (
                    <>
                      <Gauge
                        label="CPU"
                        value={node.meta.cpuLimitM ? (node.meta.cpuM / node.meta.cpuLimitM) * 100 : Math.min((node.meta.cpuM / 4000) * 100, 100)}
                        detail={`${node.meta.cpuM}m${node.meta.cpuLimitM ? ` / ${node.meta.cpuLimitM}m` : ''}`}
                      />
                      <Gauge
                        label="RAM"
                        value={node.meta.memLimitMiB ? (node.meta.memMiB / node.meta.memLimitMiB) * 100 : Math.min((node.meta.memMiB / 4096) * 100, 100)}
                        detail={`${node.meta.memMiB >= 1024 ? `${(node.meta.memMiB / 1024).toFixed(1)} GiB` : `${node.meta.memMiB} MiB`}${node.meta.memLimitMiB ? ` / ${node.meta.memLimitMiB >= 1024 ? `${(node.meta.memLimitMiB / 1024).toFixed(1)} GiB` : `${node.meta.memLimitMiB} MiB`}` : ''}`}
                      />
                      {node.meta.namespace && (
                        <div style={S.row}>
                          <span style={S.label}>Namespace</span>
                          <span style={S.value}>{node.meta.namespace}</span>
                        </div>
                      )}
                    </>
                  ) : node.meta?.dockerMetrics ? (
                    <>
                      <Gauge
                        label="CPU"
                        value={node.meta.cpuPercent ?? 0}
                        detail={`${(node.meta.cpuPercent ?? 0).toFixed(1)}%`}
                      />
                      <Gauge
                        label="RAM"
                        value={node.meta.memLimitMiB ? (node.meta.memMiB / node.meta.memLimitMiB) * 100 : Math.min((node.meta.memMiB / 4096) * 100, 100)}
                        detail={`${node.meta.memMiB >= 1024 ? `${(node.meta.memMiB / 1024).toFixed(1)} GiB` : `${node.meta.memMiB} MiB`}${node.meta.memLimitMiB > 0 ? ` / ${node.meta.memLimitMiB >= 1024 ? `${(node.meta.memLimitMiB / 1024).toFixed(1)} GiB` : `${node.meta.memLimitMiB} MiB`}` : ''}`}
                      />
                      {node.meta.dockerHost && (
                        <div style={S.row}>
                          <span style={S.label}>Host</span>
                          <span style={S.value}>{node.meta.dockerHost}</span>
                        </div>
                      )}
                    </>
                  ) : node.meta?.haMetrics ? (
                    <>
                      {node.meta.cpuPercent != null && <Gauge label="CPU" value={node.meta.cpuPercent} detail={`${node.meta.cpuPercent.toFixed(1)}%`} />}
                      {node.meta.memPercent != null && <Gauge label="RAM" value={node.meta.memPercent} detail={`${node.meta.memPercent.toFixed(1)}%`} />}
                      {node.meta.memMiB != null && node.meta.memPercent == null && (
                        <div style={S.row}>
                          <span style={S.label}>RAM</span>
                          <span style={S.valueAccent}>{node.meta.memMiB >= 1024 ? `${(node.meta.memMiB / 1024).toFixed(1)} GiB` : `${node.meta.memMiB} MiB`} used</span>
                        </div>
                      )}
                      {node.meta.diskPercent != null && <Gauge label="Disk" value={node.meta.diskPercent} detail={`${node.meta.diskPercent.toFixed(1)}%`} />}
                      {node.meta.diskGiB != null && node.meta.diskPercent == null && (
                        <div style={S.row}>
                          <span style={S.label}>Disk</span>
                          <span style={S.valueAccent}>{node.meta.diskGiB.toFixed(1)} GiB used</span>
                        </div>
                      )}
                      {node.meta.memMiB != null && node.meta.memPercent == null && (
                        <div style={S.row}>
                          <span style={S.label}>Source</span>
                          <span style={S.value}>Home Assistant</span>
                        </div>
                      )}
                    </>
                  ) : node.meta?.maxcpu ? (
                    <>
                      <Gauge label="CPU" value={(node.meta.cpu ?? 0) * 100} />
                      <Gauge label="RAM" value={node.meta.maxmem ? ((node.meta.mem ?? 0) / node.meta.maxmem) * 100 : 0} />
                      {node.meta.maxdisk > 0 && <Gauge label="Disk" value={(node.meta.disk ?? 0) / node.meta.maxdisk * 100} />}
                      {node.meta.uptime > 0 && (
                        <div style={S.row}>
                          <span style={S.label}>Uptime</span>
                          <span style={S.valueAccent}>{fmtUptime(node.meta.uptime)}</span>
                        </div>
                      )}
                      {node.meta.pveNode && (
                        <div style={S.row}>
                          <span style={S.label}>PVE Host</span>
                          <span style={S.value}>{node.meta.pveNode}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={S.noData}>No metrics data yet — fetching...</div>
                  )}
                </div>
              </TabsContent>
            )}

            <TabsContent value="logs">
              <div style={{ marginTop: '16px' }}>
                {!node.meta?.lokiLabel ? (
                  <div style={S.noData}>No log stream configured for this node.</div>
                ) : nodeLogs.length === 0 ? (
                  <div style={S.noData}>No log lines found.</div>
                ) : (
                  nodeLogs.slice(0, 50).map((entry, index) => (
                    <LogEntry key={`${entry.ts}-${index}`} entry={entry} />
                  ))
                )}
              </div>
            </TabsContent>
          </Tabs>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
