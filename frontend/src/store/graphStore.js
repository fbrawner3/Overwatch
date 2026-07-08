import { create } from 'zustand';

let neighborMap = {};
let secondDegreeMap = {};

function extractMetrics(nodes) {
  const map = {};
  for (const n of nodes) {
    if (n.meta?.cpuPercent != null) {
      map[n.id] = {
        nodeId: n.id,
        cpuPercent: n.meta.cpuPercent ?? 0,
        memPercent: n.meta.memPercent ?? 0,
        diskPercent: n.meta.diskPercent ?? 0,
        networkMbps: n.meta.networkMbps ?? 0,
        networkUp: n.meta.networkUp !== false,
      };
    }
  }
  return map;
}

function buildNeighborMaps(edges) {
  neighborMap = {};
  secondDegreeMap = {};
  for (const e of edges) {
    if (!neighborMap[e.source]) neighborMap[e.source] = new Set();
    if (!neighborMap[e.target]) neighborMap[e.target] = new Set();
    neighborMap[e.source].add(e.target);
    neighborMap[e.target].add(e.source);
  }
  for (const nodeId of Object.keys(neighborMap)) {
    const first = neighborMap[nodeId];
    const second = new Set(first);
    for (const n of first) {
      const nNeighbors = neighborMap[n];
      if (nNeighbors) for (const nn of nNeighbors) second.add(nn);
    }
    secondDegreeMap[nodeId] = second;
  }
}

export const useGraphStore = create((set, get) => ({
  nodes: [],
  edges: [],
  metrics: {},
  logs: {},
  dataSourceLive: true,
  lastUpdated: null,

  updateLogs: (nodeId, logs) => set({ logs: { ...get().logs, [nodeId]: logs } }),

  selectedId: null,
  selectedSpoke: null,
  hoveredId: null,
  selectNode: (id) => {
    set({ selectedId: id, selectedSpoke: null, cameraMode: 'paused', lastInteractionAt: Date.now() });
  },
  selectSpoke: (nodeId, spokeKey) => {
    set({ selectedId: nodeId, selectedSpoke: spokeKey, cameraMode: 'paused', lastInteractionAt: Date.now() });
  },
  clearSelection: () => set({ selectedId: null, selectedSpoke: null }),
  setHoveredNode: (id) => set({ hoveredId: id }),

  getVisibilityDepth: (nodeId) => {
    const { selectedId, cameraMode } = get();
    if (cameraMode === 'idle-showcase') {
      const target = get().showcaseTargetId;
      if (!target) return 2;
      if (nodeId === target) return 0;
      const neighbors = neighborMap[target];
      if (neighbors?.has(nodeId)) return 1;
      const second = secondDegreeMap[target];
      if (second?.has(nodeId)) return 2;
      return 4;
    }
    if (!selectedId) return 2;
    if (nodeId === selectedId) return 0;
    const neighbors = neighborMap[selectedId];
    if (neighbors?.has(nodeId)) return 1;
    const second = secondDegreeMap[selectedId];
    if (second?.has(nodeId)) return 2;
    return 4;
  },

  cameraMode: 'orbiting',
  orbitAngle: 0,
  lastInteractionAt: null,
  pauseLocked: false,
  recordInteraction: () => set({ lastInteractionAt: Date.now() }),
  setCameraMode: (mode) => set({ cameraMode: mode }),
  setOrbitAngle: (angle) => set({ orbitAngle: angle }),
  togglePauseLock: () => {
    const locked = !get().pauseLocked;
    set({ pauseLocked: locked, cameraMode: locked ? 'paused' : 'orbiting' });
  },

  showcaseTargetId: null,
  setShowcaseTarget: (id) => set({ showcaseTargetId: id }),

  // Replace edges wholesale — backend is the source of truth
  mergeDiscoveredEdges: (discoveredEdges) => {
    buildNeighborMaps(discoveredEdges);
    set({ edges: discoveredEdges });
  },

  mergeDiscoveredNodes: (discovered) => {
    set({ nodes: discovered, metrics: extractMetrics(discovered), lastUpdated: new Date().toISOString() });
  },

  init: () => {
    set({ nodes: [], edges: [] });
  },
}));
