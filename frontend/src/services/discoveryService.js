export async function fetchDiscoveredTopology() {
  try {
    const res = await fetch('/api/topology', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`topology API ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[discoveryService] failed:', err);
    return { nodes: [], enrichments: [], edges: [], lastUpdated: null };
  }
}
