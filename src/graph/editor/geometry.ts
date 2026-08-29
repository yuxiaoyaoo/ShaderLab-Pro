import type { GraphNode, GraphPoint } from '../model';
import type { NodeDefinition, NodeRegistry } from '../registry';

interface GraphNodeLayoutDescriptor {
  width: number;
  minHeight: number;
  headerHeight: number;
  socketRowHeight: number;
  socketPaddingY: number;
  borderTop: number;
  borderBottom: number;
}

export const GRAPH_NODE_LAYOUT_DESCRIPTORS = {
  normal: {
    width: 190,
    minHeight: 92,
    headerHeight: 34,
    socketRowHeight: 25,
    socketPaddingY: 7,
    borderTop: 3,
    borderBottom: 1,
  },
  reroute: {
    width: 72,
    minHeight: 42,
    headerHeight: 0,
    socketRowHeight: 0,
    socketPaddingY: 0,
    borderTop: 3,
    borderBottom: 1,
  },
  collapsed: {
    width: 190,
    minHeight: 54,
    headerHeight: 34,
    socketRowHeight: 12,
    socketPaddingY: 6,
    borderTop: 3,
    borderBottom: 1,
  },
} as const satisfies Record<string, GraphNodeLayoutDescriptor>;

export const GRAPH_NODE_WIDTH = GRAPH_NODE_LAYOUT_DESCRIPTORS.normal.width;

export type GraphNodeLayoutKind = keyof typeof GRAPH_NODE_LAYOUT_DESCRIPTORS;

export interface GraphNodeLayout {
  kind: GraphNodeLayoutKind;
  width: number;
  height: number;
  headerHeight: number;
  socketRowHeight: number;
  socketPaddingY: number;
  socketStartY: number;
  compactSockets: boolean;
}

export interface GraphNodeBounds { x: number; y: number; width: number; height: number }

export interface GraphEdgeBezierLayout {
  from: GraphPoint;
  to: GraphPoint;
  controlFrom: GraphPoint;
  controlTo: GraphPoint;
  path: string;
  bounds: GraphNodeBounds;
}

function socketRows(definition?: NodeDefinition): number {
  return Math.max(definition?.inputs.length ?? 0, definition?.outputs.length ?? 0);
}

function normalNodeHeight(definition?: NodeDefinition): number {
  const descriptor = GRAPH_NODE_LAYOUT_DESCRIPTORS.normal;
  return Math.max(
    descriptor.minHeight,
    descriptor.borderTop + descriptor.headerHeight + descriptor.socketPaddingY * 2
      + socketRows(definition) * descriptor.socketRowHeight + descriptor.borderBottom,
  );
}

export function graphNodeHeight(definition?: NodeDefinition): number {
  return normalNodeHeight(definition);
}

export function graphNodeLayout(node: Pick<GraphNode, 'type'>, definition?: NodeDefinition, collapsed = false): GraphNodeLayout {
  if (node.type === 'core.reroute') {
    const descriptor = GRAPH_NODE_LAYOUT_DESCRIPTORS.reroute;
    return {
      kind: 'reroute',
      width: descriptor.width,
      height: descriptor.minHeight,
      headerHeight: descriptor.headerHeight,
      socketRowHeight: descriptor.socketRowHeight,
      socketPaddingY: descriptor.socketPaddingY,
      socketStartY: descriptor.minHeight / 2,
      compactSockets: true,
    };
  }

  if (collapsed) {
    const descriptor = GRAPH_NODE_LAYOUT_DESCRIPTORS.collapsed;
    const rows = socketRows(definition);
    const height = Math.max(descriptor.minHeight, descriptor.socketPaddingY * 2 + rows * descriptor.socketRowHeight);
    return {
      kind: 'collapsed',
      width: descriptor.width,
      height,
      headerHeight: height - descriptor.borderTop - descriptor.borderBottom,
      socketRowHeight: descriptor.socketRowHeight,
      socketPaddingY: descriptor.socketPaddingY,
      socketStartY: rows > 0 ? (height - rows * descriptor.socketRowHeight) / 2 + descriptor.socketRowHeight / 2 : height / 2,
      compactSockets: true,
    };
  }

  const descriptor = GRAPH_NODE_LAYOUT_DESCRIPTORS.normal;
  return {
    kind: 'normal',
    width: descriptor.width,
    height: normalNodeHeight(definition),
    headerHeight: descriptor.headerHeight,
    socketRowHeight: descriptor.socketRowHeight,
    socketPaddingY: descriptor.socketPaddingY,
    socketStartY: descriptor.borderTop + descriptor.headerHeight + descriptor.socketPaddingY + descriptor.socketRowHeight / 2,
    compactSockets: false,
  };
}

export function graphSocketOffset(layout: GraphNodeLayout, index: number, output: boolean): GraphPoint {
  return {
    x: output ? layout.width : 0,
    y: layout.socketStartY + Math.max(0, index) * layout.socketRowHeight,
  };
}

export function graphNodeBounds(
  node: GraphNode,
  registry: NodeRegistry,
  collapsed = false,
  position: GraphPoint = node.position,
): GraphNodeBounds {
  const layout = graphNodeLayout(node, registry.get(node.type, node.typeVersion), collapsed);
  return { x: position.x, y: position.y, width: layout.width, height: layout.height };
}

export function graphSocketPoint(
  node: GraphNode,
  socketId: string,
  output: boolean,
  registry: NodeRegistry,
  position: GraphPoint = node.position,
  collapsed = false,
): GraphPoint {
  const definition = registry.get(node.type, node.typeVersion);
  const sockets = output ? definition?.outputs : definition?.inputs;
  const index = Math.max(0, sockets?.findIndex((socket) => socket.id === socketId) ?? 0);
  const offset = graphSocketOffset(graphNodeLayout(node, definition, collapsed), index, output);
  return { x: position.x + offset.x, y: position.y + offset.y };
}

export function graphBounds(
  nodes: readonly GraphNode[],
  registry: NodeRegistry,
  collapsedNodeIds: ReadonlySet<string> = new Set<string>(),
): GraphNodeBounds | null {
  if (nodes.length === 0) return null;
  const bounds = nodes.map((node) => graphNodeBounds(node, registry, collapsedNodeIds.has(node.id)));
  const minX = Math.min(...bounds.map((item) => item.x));
  const minY = Math.min(...bounds.map((item) => item.y));
  const maxX = Math.max(...bounds.map((item) => item.x + item.width));
  const maxY = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function graphEdgeBezier(from: GraphPoint, to: GraphPoint): GraphEdgeBezierLayout {
  const bend = Math.max(55, Math.abs(to.x - from.x) * 0.45);
  const controlFrom = { x: from.x + bend, y: from.y };
  const controlTo = { x: to.x - bend, y: to.y };
  const points = [from, controlFrom, controlTo, to];
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return {
    from,
    to,
    controlFrom,
    controlTo,
    path: `M ${from.x} ${from.y} C ${controlFrom.x} ${controlFrom.y}, ${controlTo.x} ${controlTo.y}, ${to.x} ${to.y}`,
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

export function graphBoundsIntersect(a: GraphNodeBounds, b: GraphNodeBounds): boolean {
  return a.x + a.width >= b.x && a.x <= b.x + b.width && a.y + a.height >= b.y && a.y <= b.y + b.height;
}
