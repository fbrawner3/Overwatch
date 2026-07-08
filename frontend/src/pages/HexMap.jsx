import { useEffect } from 'react';
import { useGraphStore } from '../store/graphStore';
import { fetchDiscoveredTopology } from '../services/discoveryService';
import Scene2D from '../components/Scene2D';
import LeftHUD from '../components/ui/LeftHUD';
import DetailPanel from '../components/ui/DetailPanel';

export default function HexMap() {
  const mergeDiscoveredNodes = useGraphStore(s => s.mergeDiscoveredNodes);
  const mergeDiscoveredEdges = useGraphStore(s => s.mergeDiscoveredEdges);
  const selectNode = useGraphStore(s => s.selectNode);
  const init = useGraphStore(s => s.init);

  useEffect(() => {
    init();

    const refreshTopology = async () => {
      const { nodes, edges } = await fetchDiscoveredTopology();
      mergeDiscoveredNodes(nodes);
      mergeDiscoveredEdges(edges);

      const { selectedId } = useGraphStore.getState();
      if (!selectedId) {
        const critical = nodes.find(n => n.status === 'critical');
        const warning = !critical && nodes.find(n => n.status === 'warning');
        if (critical) selectNode(critical.id);
        else if (warning) selectNode(warning.id);
      }
    };

    refreshTopology();
    const topologyInterval = setInterval(refreshTopology, 60_000);
    return () => clearInterval(topologyInterval);
  }, [init, mergeDiscoveredNodes, mergeDiscoveredEdges, selectNode]);

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', overflow: 'hidden', background: '#0A0A0B' }}>
      <Scene2D />
      <LeftHUD />
      <DetailPanel />
    </div>
  );
}
