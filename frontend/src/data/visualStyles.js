export const STATUS_COLORS = {
  healthy: '#00e5ff',
  warning: '#ff8800',
  critical: '#ff2200',
  unknown: '#556677',
};

export const STATUS_LABELS = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
};

export const EDGE_COLORS = {
  hosts: '#3a6a9a',
  pod_host: '#3a6a9a',
  depends_on: '#5a9a5a',
  storage: '#d4a017',
  database: '#2e86ab',
  sso: '#e0186c',
  sso_for: '#e0186c',
  secrets_for: '#9a6ac8',
  network: '#3acaca',
};

export const EDGE_LABELS = {
  hosts: 'Hosts (physical)',
  pod_host: 'Pod scheduled on (k3s)',
  depends_on: 'Depends on (data)',
  storage: 'Storage (NFS)',
  database: 'Database connection',
  sso: 'SSO / Auth',
  secrets_for: 'Secrets',
  network: 'Network / Tunnel',
};

export const EDGE_DASHED = new Set(['pod_host']);