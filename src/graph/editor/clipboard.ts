import { createEmptyGraph, type GraphDocument, type GraphEdge, type GraphNode, type GraphParameter, type GraphPoint } from '../model';
import { normalizeGraphDocument } from '../schema';
import { DEFAULT_NODE_REGISTRY } from '../registry';
import { canInsertGraphFragment, validateGraphFragment, type GraphFragmentValidationOptions } from './fragmentValidation';

export const GRAPH_CLIPBOARD_FORMAT = 'shaderlab-graph-clipboard';
export interface GraphClipboardPayload { format: typeof GRAPH_CLIPBOARD_FORMAT; version: 1; nodes: GraphNode[]; edges: GraphEdge[]; parameters: GraphParameter[] }
export interface GraphIdFactory { node(oldId: string): string; edge(oldId: string): string; parameter(oldId: string): string }
export interface PasteGraphOptions extends GraphFragmentValidationOptions { offset?: GraphPoint; idFactory: GraphIdFactory }
export interface PasteGraphResult { document: GraphDocument; nodeIds: string[]; edgeIds: string[]; parameterIds: string[] }

export function serializeGraphSelection(document: GraphDocument, selectedNodeIds: Iterable<string>): string {
  const selected = new Set(selectedNodeIds);
  const nodes = document.nodes.filter((node) => selected.has(node.id) && !node.type.startsWith('output.'));
  const copied = new Set(nodes.map((node) => node.id));
  const parameterIds = new Set(nodes.filter((node) => node.type === 'core.parameter' && typeof node.values.parameterId === 'string').map((node) => node.values.parameterId as string));
  const payload: GraphClipboardPayload = {
    format: GRAPH_CLIPBOARD_FORMAT,
    version: 1,
    nodes,
    edges: document.edges.filter((edge) => copied.has(edge.from.nodeId) && copied.has(edge.to.nodeId)),
    parameters: document.parameters.filter((parameter) => parameterIds.has(parameter.id)),
  };
  return JSON.stringify(payload);
}

export function parseGraphClipboard(
  text: string,
  options: GraphFragmentValidationOptions = {},
): GraphClipboardPayload | null {
  try {
    const value = JSON.parse(text) as Partial<GraphClipboardPayload>;
    if (value.format !== GRAPH_CLIPBOARD_FORMAT || value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.parameters)) return null;
    const registry = options.registry ?? DEFAULT_NODE_REGISTRY;
    const normalized = normalizeGraphDocument({ ...createEmptyGraph(options.pass ?? 'image'), nodes: value.nodes, edges: value.edges, parameters: value.parameters });
    if (!normalized.ok || !normalized.document) return null;
    const payload: GraphClipboardPayload = {
      format: GRAPH_CLIPBOARD_FORMAT,
      version: 1,
      nodes: normalized.document.nodes.filter((node) => !(registry.get(node.type, node.typeVersion)?.output ?? node.type.startsWith('output.'))),
      edges: normalized.document.edges,
      parameters: normalized.document.parameters,
    };
    return validateGraphFragment(payload, options).length === 0 ? payload : null;
  } catch { return null; }
}

export function pasteGraphSelection(document: GraphDocument, payload: GraphClipboardPayload, options: PasteGraphOptions): PasteGraphResult | null {
  const offset = options.offset ?? { x: 32, y: 32 };
  const registry = options.registry ?? DEFAULT_NODE_REGISTRY;
  const allowedNodes = payload.nodes.filter((node) => !(registry.get(node.type, node.typeVersion)?.output ?? node.type.startsWith('output.')));
  const nodeMap = new Map(allowedNodes.map((node) => [node.id, options.idFactory.node(node.id)]));
  const neededParameters = new Set(allowedNodes.filter((node) => node.type === 'core.parameter' && typeof node.values.parameterId === 'string').map((node) => node.values.parameterId as string));
  const parameterMap = new Map(payload.parameters.filter((parameter) => neededParameters.has(parameter.id)).map((parameter) => [parameter.id, options.idFactory.parameter(parameter.id)]));
  if ([...neededParameters].some((parameterId) => !parameterMap.has(parameterId))) return null;
  const parameters = payload.parameters.filter((parameter) => parameterMap.has(parameter.id)).map((parameter) => ({ ...parameter, id: parameterMap.get(parameter.id)! }));
  const nodes = allowedNodes.map((node) => ({ ...node, id: nodeMap.get(node.id)!, position: { x: node.position.x + offset.x, y: node.position.y + offset.y }, values: node.type === 'core.parameter' && typeof node.values.parameterId === 'string' ? { ...node.values, parameterId: parameterMap.get(node.values.parameterId) ?? node.values.parameterId } : { ...node.values } }));
  const edges = payload.edges.filter((edge) => nodeMap.has(edge.from.nodeId) && nodeMap.has(edge.to.nodeId)).map((edge) => ({ id: options.idFactory.edge(edge.id), from: { nodeId: nodeMap.get(edge.from.nodeId)!, socketId: edge.from.socketId }, to: { nodeId: nodeMap.get(edge.to.nodeId)!, socketId: edge.to.socketId } }));
  const fragment = { nodes, edges, parameters };
  if (!canInsertGraphFragment(document, fragment, { registry, pass: document.pass, insideGroup: options.insideGroup })) return null;
  return { document: { ...document, nodes: [...document.nodes, ...nodes], edges: [...document.edges, ...edges], parameters: [...document.parameters, ...parameters] }, nodeIds: nodes.map((node) => node.id), edgeIds: edges.map((edge) => edge.id), parameterIds: parameters.map((parameter) => parameter.id) };
}

export function createSequentialGraphIdFactory(prefix = 'copy'): GraphIdFactory {
  let counter = 0; const next = (kind: string) => `${prefix}-${kind}-${++counter}`;
  return { node: () => next('node'), edge: () => next('edge'), parameter: () => next('parameter') };
}
