export const ALERT_THRESHOLDS = {
  cpu: { warn: 80, crit: 95 },
  mem: { warn: 80, crit: 95 },
  disk: { warn: 80, crit: 95 },
};

export const SPOKE_META = {
  cpu: { label: 'CPU', unit: '%', field: 'cpuPercent' },
  mem: { label: 'Memory', unit: '%', field: 'memPercent' },
  disk: { label: 'Disk', unit: '%', field: 'diskPercent' },
  net: { label: 'Network', unit: '', field: 'networkUp', kind: 'link' },
  pod: { label: 'Pod', unit: '', field: 'podDown', kind: 'status' },
};

export const SPOKE_DESCRIPTIONS = {
  cpu: 'CPU utilization is high. A process may be in a tight loop, or the workload has outgrown this node.',
  mem: 'Memory pressure is high. The kernel may begin swapping, which will sharply increase latency.',
  disk: 'Disk capacity is nearly exhausted. Writes may fail and services that log or store data will degrade.',
  net: 'Network link is down. The interface is not reporting carrier — verify cable, switch port, or SNMP up/down state.',
  pod: 'Pod is not running. The container has crashed or failed to start — check kubectl logs for the deployment.',
};

export function isNetworkUp(m) {
  if (!m) return false;
  if (m.networkUp !== undefined) return m.networkUp;
  return (m.networkMbps ?? 0) > 0;
}

export function getAlarmingSpokes(nodeId, metrics, nodes) {
  const m = metrics[nodeId];
  const node = nodes?.find?.(n => n.id === nodeId);
  if (node?.meta?.podDown === true) {
    return [{ key: 'pod', severity: 'critical', value: 'down' }];
  }
  if (!m) return [];
  const pveOnly = node?.meta?.pveId && !node?.meta?.prometheusInstance;
  const out = [];
  const check = (key, val) => {
    const t = ALERT_THRESHOLDS[key];
    if (val >= t.crit) out.push({ key, severity: 'critical', value: val });
    else if (val >= t.warn) out.push({ key, severity: 'warning', value: val });
  };
  check('cpu', m.cpuPercent);
  if (!pveOnly) check('mem', m.memPercent);
  check('disk', m.diskPercent);
  // Network is SNMP up/down only — no bandwidth thresholds.
  if (!isNetworkUp(m)) out.push({ key: 'net', severity: 'critical', value: 'down' });
  return out;
}

export function getEffectiveStatus(node, metrics) {
  const spokes = getAlarmingSpokes(node.id, metrics, [node]);
  if (spokes.some(s => s.severity === 'critical') || node.status === 'critical') return 'critical';
  if (spokes.some(s => s.severity === 'warning') || node.status === 'warning') return 'warning';
  return 'healthy';
}