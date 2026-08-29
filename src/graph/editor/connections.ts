import { compileGraph } from '../compiler/index';
import type { UnifiedDiagnostic } from '../../diagnostics/model';
import type { ProductMessageDescriptor } from '../../productMessage';
import type { GraphDocument, GraphEdge, GraphSocketRef } from '../model';
import { DEFAULT_NODE_REGISTRY, type NodeRegistry } from '../registry';

export type ConnectionFailure = 'endpoint' | 'socket' | 'direction' | 'self' | 'cycle' | 'type';
export interface ConnectionPreflight { ok: boolean; reason?: ConnectionFailure; descriptor?: ProductMessageDescriptor; edge?: GraphEdge; replaceEdgeIds: string[]; diagnostics: UnifiedDiagnostic[] }
export interface ConnectionOptions { registry?: NodeRegistry; edgeId?: string }

const diagnosticKey = (item: UnifiedDiagnostic) => `${item.code}|${item.message}|${JSON.stringify(item.origin)}`;

/** Side-effect-free connection check. Registry owns endpoint/direction metadata; compileGraph remains cycle/type authority. */
export function preflightConnection(document: GraphDocument, from: GraphSocketRef, to: GraphSocketRef, options: ConnectionOptions = {}): ConnectionPreflight {
  const registry = options.registry ?? DEFAULT_NODE_REGISTRY;
  const fromNode = document.nodes.find((node) => node.id === from.nodeId);
  const toNode = document.nodes.find((node) => node.id === to.nodeId);
  if (!fromNode || !toNode) return { ok: false, reason: 'endpoint', descriptor: { code: 'graph.connection-endpoint-missing' }, replaceEdgeIds: [], diagnostics: [] };
  if (from.nodeId === to.nodeId) return { ok: false, reason: 'self', descriptor: { code: 'graph.connection-self' }, replaceEdgeIds: [], diagnostics: [] };
  const fromDef = registry.get(fromNode.type, fromNode.typeVersion);
  const toDef = registry.get(toNode.type, toNode.typeVersion);
  if (!fromDef || !toDef) return { ok: false, reason: 'endpoint', descriptor: { code: 'graph.connection-definition-missing' }, replaceEdgeIds: [], diagnostics: [] };
  const fromOutput = fromDef.outputs.find((socket) => socket.id === from.socketId);
  const toInput = toDef.inputs.find((socket) => socket.id === to.socketId);
  if (!fromOutput) return { ok: false, reason: fromDef.inputs.some((socket) => socket.id === from.socketId) ? 'direction' : 'socket', descriptor: { code: 'graph.connection-source-output-required' }, replaceEdgeIds: [], diagnostics: [] };
  if (!toInput) return { ok: false, reason: toDef.outputs.some((socket) => socket.id === to.socketId) ? 'direction' : 'socket', descriptor: { code: 'graph.connection-target-input-required' }, replaceEdgeIds: [], diagnostics: [] };
  const replaceEdgeIds = document.edges.filter((edge) => edge.to.nodeId === to.nodeId && edge.to.socketId === to.socketId).map((edge) => edge.id);
  const edge: GraphEdge = { id: options.edgeId ?? '__connection_preflight__', from: { ...from }, to: { ...to } };
  const baseline = new Set(compileGraph(document, registry).diagnostics.map(diagnosticKey));
  const candidate: GraphDocument = { ...document, edges: [...document.edges.filter((item) => !replaceEdgeIds.includes(item.id)), edge] };
  const result = compileGraph(candidate, registry);
  const diagnostics = result.diagnostics.filter((item) => !baseline.has(diagnosticKey(item)));
  const cycle = diagnostics.find((item) => item.code === 'graph.cycle');
  if (cycle) return { ok: false, reason: 'cycle', descriptor: { code: cycle.code ?? 'graph.cycle', params: cycle.params, rawDetail: cycle.rawDetail, fallback: cycle.message }, edge, replaceEdgeIds, diagnostics };
  const type = diagnostics.find((item) => item.stage === 'graph-typecheck');
  if (type) return { ok: false, reason: 'type', descriptor: { code: type.code ?? 'type.inference-failed', params: type.params, rawDetail: type.rawDetail, fallback: type.message }, edge, replaceEdgeIds, diagnostics };
  const structural = diagnostics[0];
  if (structural) return { ok: false, reason: structural.code === 'graph.self-edge' ? 'self' : 'socket', descriptor: { code: structural.code ?? 'graph.invalid', params: structural.params, rawDetail: structural.rawDetail, fallback: structural.message }, edge, replaceEdgeIds, diagnostics };
  return { ok: true, edge, replaceEdgeIds, diagnostics: [] };
}
