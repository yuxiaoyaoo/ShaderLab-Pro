import type { GraphDocument, GraphNode, GraphPoint, GraphSocketRef } from '../model';
import { DEFAULT_NODE_REGISTRY, type NodeRegistry } from '../registry';
import { preflightConnection } from './connections';

export type GraphDirection = 'left' | 'right' | 'up' | 'down';
export interface KeyboardConnectionState { from: GraphSocketRef; compatibleInputs: GraphSocketRef[]; activeIndex: number }

export function nudgeNodePositions(document: GraphDocument, selection: readonly string[], direction: GraphDirection, grid = 16): Record<string, GraphPoint> {
  const delta = direction === 'left' ? { x: -grid, y: 0 }
    : direction === 'right' ? { x: grid, y: 0 }
      : direction === 'up' ? { x: 0, y: -grid }
        : { x: 0, y: grid };
  const ids = new Set(selection);
  return Object.fromEntries(document.nodes.filter((node) => ids.has(node.id)).map((node) => [node.id, { x: node.position.x + delta.x, y: node.position.y + delta.y }]));
}

export function nextNodeInDirection(nodes: readonly GraphNode[], currentId: string | undefined, direction: GraphDirection): string | undefined {
  if (!nodes.length) return undefined;
  const current = nodes.find((node) => node.id === currentId) ?? nodes[0];
  const candidates = nodes.filter((node) => {
    if (node.id === current.id) return false;
    const dx = node.position.x - current.position.x;
    const dy = node.position.y - current.position.y;
    return direction === 'left' ? dx < 0 : direction === 'right' ? dx > 0 : direction === 'up' ? dy < 0 : dy > 0;
  });
  candidates.sort((a, b) => {
    const adx = a.position.x - current.position.x; const ady = a.position.y - current.position.y;
    const bdx = b.position.x - current.position.x; const bdy = b.position.y - current.position.y;
    return (adx * adx + ady * ady) - (bdx * bdx + bdy * bdy) || a.id.localeCompare(b.id);
  });
  return candidates[0]?.id ?? current.id;
}

export function beginKeyboardConnection(document: GraphDocument, from: GraphSocketRef, registry: NodeRegistry = DEFAULT_NODE_REGISTRY): KeyboardConnectionState | null {
  const sourceNode = document.nodes.find((node) => node.id === from.nodeId);
  const sourceDef = sourceNode && registry.get(sourceNode.type, sourceNode.typeVersion);
  if (!sourceDef?.outputs.some((socket) => socket.id === from.socketId)) return null;
  const compatibleInputs: GraphSocketRef[] = [];
  for (const node of document.nodes) {
    const definition = registry.get(node.type, node.typeVersion);
    for (const input of definition?.inputs ?? []) {
      const to = { nodeId: node.id, socketId: input.id };
      if (preflightConnection(document, from, to, { registry }).ok) compatibleInputs.push(to);
    }
  }
  compatibleInputs.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.socketId.localeCompare(b.socketId));
  return compatibleInputs.length ? { from, compatibleInputs, activeIndex: 0 } : null;
}

export function moveKeyboardConnection(state: KeyboardConnectionState, delta: number): KeyboardConnectionState {
  const length = state.compatibleInputs.length;
  return length ? { ...state, activeIndex: (state.activeIndex + delta + length) % length } : state;
}

export const activeKeyboardConnectionTarget = (state: KeyboardConnectionState): GraphSocketRef | undefined => state.compatibleInputs[state.activeIndex];

export function graphKeyboardIntent(key: string, shiftKey = false): 'fit' | 'zoom-in' | 'zoom-out' | 'palette' | 'cancel' | 'none' {
  if (key === 'f' || key === 'F') return 'fit';
  if (key === '+' || key === '=') return 'zoom-in';
  if (key === '-' || key === '_') return 'zoom-out';
  if ((key === 'a' || key === 'A') && shiftKey) return 'palette';
  if (key === 'Escape') return 'cancel';
  return 'none';
}

export function graphNodeActivationIntent(key: string, code = ''): 'connect' | 'none' {
  return key === 'Enter' || code === 'Space' ? 'connect' : 'none';
}
