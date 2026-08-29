import type { GraphDocument, GraphEdge, GraphNode, GraphParameter, GraphPoint, GraphViewport } from '../model';
import type { NodeGroupDefinition } from '../library';
import { DEFAULT_NODE_REGISTRY, isNodeAllowedInPureGroup, isNodeAvailableInPass, type NodeRegistry } from '../registry';
import { canInsertGraphFragment } from './fragmentValidation';

export type GraphCommandImpact = 'semantic' | 'layout';

export type GraphCommand =
  | { type: 'replace-document'; document: GraphDocument; libraryGroup?: NodeGroupDefinition }
  | { type: 'add-node'; node: GraphNode }
  | { type: 'insert-fragment'; nodes: GraphNode[]; edges: GraphEdge[]; parameters: GraphParameter[] }
  | { type: 'delete-nodes'; nodeIds: string[] }
  | { type: 'move-nodes'; positions: Record<string, GraphPoint> }
  | { type: 'set-node-value'; nodeId: string; key: string; value: unknown }
  | { type: 'connect'; edge: GraphEdge; replaceInput?: boolean }
  | { type: 'disconnect'; edgeIds: string[] }
  | { type: 'set-viewport'; viewport: GraphViewport }
  | { type: 'add-parameter'; parameter: GraphParameter }
  | { type: 'update-parameter'; parameterId: string; patch: Partial<Omit<GraphParameter, 'id'>> }
  | { type: 'delete-parameter'; parameterId: string };

export interface AppliedGraphCommand {
  document: GraphDocument;
  impact: GraphCommandImpact;
  changed: boolean;
}

const samePoint = (a: GraphPoint, b: GraphPoint) => a.x === b.x && a.y === b.y;

export function graphCommandImpact(command: GraphCommand): GraphCommandImpact {
  return command.type === 'move-nodes' || command.type === 'set-viewport' ? 'layout' : 'semantic';
}

export interface GraphCommandContext {
  registry?: NodeRegistry;
  insideGroup?: boolean;
}

/** Applies one immutable editor transaction. Pointer drags should dispatch one move-nodes command on pointer-up. */
export function applyGraphCommand(
  document: GraphDocument,
  command: GraphCommand,
  context: GraphCommandContext = {},
): AppliedGraphCommand {
  const registry = context.registry ?? DEFAULT_NODE_REGISTRY;
  const impact = graphCommandImpact(command);
  switch (command.type) {
    case 'replace-document':
      if (command.document === document) return { document, impact, changed: false };
      return { document: command.document, impact, changed: true };
    case 'add-node': {
      const definition = registry.get(command.node.type, command.node.typeVersion);
      if (!definition || !isNodeAvailableInPass(definition, document.pass) || (context.insideGroup && !isNodeAllowedInPureGroup(definition))) return { document, impact, changed: false };
      if (document.nodes.some((node) => node.id === command.node.id)) return { document, impact, changed: false };
      return { document: { ...document, nodes: [...document.nodes, command.node] }, impact, changed: true };
    }
    case 'insert-fragment': {
      if (!command.nodes.length && !command.edges.length && !command.parameters.length) return { document, impact, changed: false };
      const fragment = { nodes: command.nodes, edges: command.edges, parameters: command.parameters };
      if (command.nodes.some((node) => registry.get(node.type, node.typeVersion)?.output)
        || !canInsertGraphFragment(document, fragment, { registry, insideGroup: context.insideGroup })) return { document, impact, changed: false };
      return { document: { ...document, nodes: [...document.nodes, ...command.nodes], edges: [...document.edges, ...command.edges], parameters: [...document.parameters, ...command.parameters] }, impact, changed: true };
    }
    case 'delete-nodes': { const ids = new Set(command.nodeIds); if (![...ids].some((id) => document.nodes.some((node) => node.id === id))) return { document, impact, changed: false }; return { document: { ...document, nodes: document.nodes.filter((node) => !ids.has(node.id)), edges: document.edges.filter((edge) => !ids.has(edge.from.nodeId) && !ids.has(edge.to.nodeId)) }, impact, changed: true }; }
    case 'move-nodes': { let changed = false; const nodes = document.nodes.map((node) => { const position = command.positions[node.id]; if (!position || samePoint(position, node.position)) return node; changed = true; return { ...node, position: { ...position } }; }); return { document: changed ? { ...document, nodes } : document, impact, changed }; }
    case 'set-node-value': { let changed = false; const nodes = document.nodes.map((node) => { if (node.id !== command.nodeId || Object.is(node.values[command.key], command.value)) return node; changed = true; return { ...node, values: { ...node.values, [command.key]: command.value } }; }); return { document: changed ? { ...document, nodes } : document, impact, changed }; }
    case 'connect': { const duplicate = document.edges.some((edge) => edge.from.nodeId === command.edge.from.nodeId && edge.from.socketId === command.edge.from.socketId && edge.to.nodeId === command.edge.to.nodeId && edge.to.socketId === command.edge.to.socketId); if (duplicate) return { document, impact, changed: false }; const edges = command.replaceInput ? document.edges.filter((edge) => edge.to.nodeId !== command.edge.to.nodeId || edge.to.socketId !== command.edge.to.socketId) : document.edges; return { document: { ...document, edges: [...edges, command.edge] }, impact, changed: true }; }
    case 'disconnect': { const ids = new Set(command.edgeIds); const edges = document.edges.filter((edge) => !ids.has(edge.id)); return { document: edges.length === document.edges.length ? document : { ...document, edges }, impact, changed: edges.length !== document.edges.length }; }
    case 'set-viewport': { const before = document.ui.viewport; const changed = before.x !== command.viewport.x || before.y !== command.viewport.y || before.zoom !== command.viewport.zoom; return { document: changed ? { ...document, ui: { ...document.ui, viewport: { ...command.viewport } } } : document, impact, changed }; }
    case 'add-parameter': if (document.parameters.some((parameter) => parameter.id === command.parameter.id)) return { document, impact, changed: false }; else return { document: { ...document, parameters: [...document.parameters, command.parameter] }, impact, changed: true };
    case 'update-parameter': { let changed = false; const parameters = document.parameters.map((parameter) => { if (parameter.id !== command.parameterId) return parameter; changed = true; return { ...parameter, ...command.patch, id: parameter.id }; }); return { document: changed ? { ...document, parameters } : document, impact, changed }; }
    case 'delete-parameter': { const parameters = document.parameters.filter((parameter) => parameter.id !== command.parameterId); if (parameters.length === document.parameters.length) return { document, impact, changed: false }; const referenced = new Set(document.nodes.filter((node) => node.type === 'core.parameter' && node.values.parameterId === command.parameterId).map((node) => node.id)); return { document: { ...document, parameters, nodes: document.nodes.filter((node) => !referenced.has(node.id)), edges: document.edges.filter((edge) => !referenced.has(edge.from.nodeId) && !referenced.has(edge.to.nodeId)) }, impact, changed: true }; }
  }
}
