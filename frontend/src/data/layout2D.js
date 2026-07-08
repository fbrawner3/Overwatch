const HOST_COLUMNS = ['heizou', 'zhongli', 'raiden', 'venti', 'nahida', 'furina', 'noelle'];
const COL_SPACING = 300;
const COL_START_X = 160;
const MAP_CENTER_X = COL_START_X + ((HOST_COLUMNS.length - 1) / 2) * COL_SPACING;

export const LEVELS = [
  { key: 'edge',    label: 'EDGE',              y: -50 },
  { key: 'host',    label: 'HOSTS',             y: 70  },
  { key: 'vm',      label: 'VMs & CONTAINERS',  y: 230 },
  { key: 'service', label: 'PLATFORM SERVICES', y: 450 },
  { key: 'app',     label: 'APPLICATIONS',      y: 640 },
];

const Y = {
  edge:    -50,
  host:    70,
  vm:      230,
  lxc:     230,
  service: 450,
};

const SVC_COLS = 2;
const SVC_SPACING_X = 145;
const SVC_SPACING_Y = 80;
const APP_COLS = 2;
const APP_SPACING_X = 130;
const APP_SPACING_Y = 70;
const SVC_APP_GAP = 28;

export function compute2DLayout(nodes) {
  const positions = {};
  const columns = {};
  const nodeById = {};
  for (const node of nodes) nodeById[node.id] = node;

  // k3s workers = VMs/LXCs that actually have pods scheduled on them
  const K3S_PARENTS = new Set(
    nodes.filter(n => n.type === 'k3s-service').map(n => n.parentId).filter(Boolean)
  );

  function resolveColumn(node) {
    if (node.column) return node.column;
    if (node.parentId) {
      const parent = nodeById[node.parentId];
      if (parent) return resolveColumn(parent);
    }
    return node.id;
  }

  for (const node of nodes) {
    const col = resolveColumn(node);
    if (!columns[col]) columns[col] = [];
    columns[col].push(node);
  }

  // Edge nodes centered above entire map
  const allEdgeNodes = nodes.filter(n => n.isEdge);
  allEdgeNodes.forEach((n, i) => {
    const offsetX = (i - (allEdgeNodes.length - 1) / 2) * 160;
    positions[n.id] = { x: MAP_CENTER_X + offsetX, y: Y.edge, level: 'edge' };
  });

  HOST_COLUMNS.forEach((colId, colIdx) => {
    const colNodes = columns[colId];
    if (!colNodes) return;
    const colX = COL_START_X + colIdx * COL_SPACING;

    const colHostNode = colNodes.find(n => n.parentId === null && !n.isAmbient && !n.isEdge);

    const vmsAndLxcs = colNodes.filter(n =>
      (n.type === 'vm' || n.type === 'lxc') && !n.isEdge && !positions[n.id]
    );

    if (colHostNode) {
      positions[colHostNode.id] = { x: colX, y: Y.host, level: 'host' };
    } else {
      const others = colNodes.filter(n =>
        !n.isAmbient && !n.isEdge && !K3S_PARENTS.has(n.id) &&
        n.type !== 'app' && n.type !== 'k3s-service' && n.layer !== 'service' && !positions[n.id]
      );
      others.forEach((node, i) => {
        positions[node.id] = { x: colX + (i - (others.length - 1) / 2) * 130, y: Y.host, level: 'host' };
      });
    }

    // VMs and LXCs: up to 3 in a single row; 4+ wrap to 2-per-row grid
    const VM_COLS = vmsAndLxcs.length > 3 ? 2 : vmsAndLxcs.length;
    const VM_X_GAP = 110;
    const VM_Y_GAP = 100;
    vmsAndLxcs.forEach((node, i) => {
      const row = Math.floor(i / VM_COLS);
      const col = i % VM_COLS;
      const colsInRow = Math.min(VM_COLS, vmsAndLxcs.length - row * VM_COLS);
      const xOff = (col - (colsInRow - 1) / 2) * VM_X_GAP;
      positions[node.id] = { x: colX + xOff, y: Y.vm + row * VM_Y_GAP, level: node.type };
    });

    // k3s service grid: pods on k3s workers + ambient nodes
    const serviceNodes = colNodes.filter(n =>
      !positions[n.id] &&
      (n.isAmbient ||
        n.type === 'k3s-service' ||
        K3S_PARENTS.has(n.parentId) ||
        (colHostNode && n.parentId === colHostNode.id && !['vm', 'lxc'].includes(n.type)))
    );

    serviceNodes.forEach((s, i) => {
      const row = Math.floor(i / SVC_COLS);
      const col = i % SVC_COLS;
      const colsThisRow = Math.min(SVC_COLS, serviceNodes.length - row * SVC_COLS);
      const gridW = (colsThisRow - 1) * SVC_SPACING_X;
      positions[s.id] = { x: colX + col * SVC_SPACING_X - gridW / 2, y: Y.service + row * SVC_SPACING_Y, level: 'service' };
    });

    const svcRows = Math.ceil(serviceNodes.length / SVC_COLS);
    const appStartY = Y.service + (svcRows > 0 ? svcRows * SVC_SPACING_Y + SVC_APP_GAP : 0);

    const apps = colNodes.filter(n => !positions[n.id] && (n.type === 'app' || n.layer === 'app'));
    apps.forEach((app, i) => {
      const row = Math.floor(i / APP_COLS);
      const col = i % APP_COLS;
      const colsThisRow = Math.min(APP_COLS, apps.length - row * APP_COLS);
      const gridW = (colsThisRow - 1) * APP_SPACING_X;
      positions[app.id] = { x: colX + col * APP_SPACING_X - gridW / 2, y: appStartY + row * APP_SPACING_Y, level: 'app' };
    });
  });

  return positions;
}

export const NODE_POSITIONS_2D = {};

export const COLUMN_X = Object.fromEntries(
  HOST_COLUMNS.map((id, idx) => [id, COL_START_X + idx * COL_SPACING])
);
