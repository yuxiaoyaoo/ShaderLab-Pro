import { For, createMemo, type Component } from 'solid-js';
import { graphBoundsIntersect, graphEdgeBezier, graphSocketPoint, type GraphNodeBounds } from '../../graph/editor/geometry';
import type { GraphDocument, GraphPoint, GraphSocketRef, GraphValueType } from '../../graph/model';
import type { NodeRegistry } from '../../graph/registry';

interface Props {
  document: GraphDocument;
  registry: NodeRegistry;
  visibleRect: GraphNodeBounds;
  collapsedNodeIds?: ReadonlySet<string>;
  transientPositions?: Record<string, GraphPoint>;
  connectingFrom?: GraphPoint;
  pointer?: GraphPoint;
  disconnectingTo?: GraphSocketRef;
  disconnectPointer?: GraphPoint;
  disconnectArmed?: boolean;
}

const SOCKET_COLORS: Record<GraphValueType, string> = {
  bool: '#d978a5', int: '#64c6a2', float: '#a8d36f', vec2: '#66b8e8', vec3: '#6f8fe8', vec4: '#9d7de0', color3: '#e6c95e', color4: '#ef9f62', sdf3: '#ef6f79',
};

const GraphEdgeLayer: Component<Props> = (props) => {
  const nodeMap = createMemo(() => new Map(props.document.nodes.map((node) => [node.id, node])));
  const position = (id: string) => props.transientPositions?.[id] ?? nodeMap().get(id)?.position ?? { x: 0, y: 0 };
  const socketPoint = (nodeId: string, socketId: string, output: boolean) => {
    const node = nodeMap().get(nodeId);
    return node ? graphSocketPoint(node, socketId, output, props.registry, position(nodeId), props.collapsedNodeIds?.has(nodeId) ?? false) : { x: 0, y: 0 };
  };
  const isDisconnectingEdge = (edge: GraphDocument['edges'][number]) => props.disconnectArmed === true
    && edge.to.nodeId === props.disconnectingTo?.nodeId
    && edge.to.socketId === props.disconnectingTo?.socketId;
  const visibleEdges = createMemo(() => props.document.edges.flatMap((edge) => {
    if (isDisconnectingEdge(edge)) return [];
    const geometry = graphEdgeBezier(
      socketPoint(edge.from.nodeId, edge.from.socketId, true),
      socketPoint(edge.to.nodeId, edge.to.socketId, false),
    );
    return graphBoundsIntersect(geometry.bounds, props.visibleRect) ? [{ edge, geometry }] : [];
  }));
  const disconnectPaths = createMemo(() => {
    if (!props.disconnectArmed || !props.disconnectingTo || !props.disconnectPointer) return [];
    return props.document.edges
      .filter((edge) => edge.to.nodeId === props.disconnectingTo!.nodeId && edge.to.socketId === props.disconnectingTo!.socketId)
      .map((edge) => graphEdgeBezier(socketPoint(edge.from.nodeId, edge.from.socketId, true), props.disconnectPointer!).path);
  });
  const color = (nodeId: string, socketId: string) => {
    const node = nodeMap().get(nodeId);
    const socket = node && props.registry.get(node.type, node.typeVersion)?.outputs.find((item) => item.id === socketId);
    const type = socket?.defaultType ?? (!socket || ['numeric', 'vector', 'any-value'].includes(socket.type) ? undefined : socket.type as GraphValueType);
    return type ? SOCKET_COLORS[type] : 'var(--brand1-bright)';
  };
  const rect = () => props.visibleRect;
  const draftPath = () => props.connectingFrom && props.pointer ? graphEdgeBezier(props.connectingFrom, props.pointer).path : undefined;
  return <svg class="graph-edges" style={{ left: `${rect().x}px`, top: `${rect().y}px`, width: `${rect().width}px`, height: `${rect().height}px` }} viewBox={`${rect().x} ${rect().y} ${rect().width} ${rect().height}`} preserveAspectRatio="none" aria-hidden="true">
    <For each={visibleEdges()}>{(item) => <path style={{ '--edge-color': color(item.edge.from.nodeId, item.edge.from.socketId) }} d={item.geometry.path} />}</For>
    <For each={disconnectPaths()}>{(path) => <path class="disconnect-draft" d={path} />}</For>
    {draftPath() ? <path class="draft" d={draftPath()} /> : null}
  </svg>;
};

export default GraphEdgeLayer;
