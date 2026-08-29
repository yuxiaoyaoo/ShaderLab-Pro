import type { UnifiedDiagnostic } from '../../diagnostics/model';
import { validateGraph } from '../compiler/validate';
import { createEmptyGraph, type GraphDocument, type GraphEdge, type GraphNode, type GraphParameter, type GraphPassId } from '../model';
import { DEFAULT_NODE_REGISTRY, isNodeAllowedInPureGroup, type NodeRegistry } from '../registry';

export interface GraphFragment { nodes: GraphNode[]; edges: GraphEdge[]; parameters: GraphParameter[] }
export interface GraphFragmentValidationOptions {
  registry?: NodeRegistry;
  pass?: GraphPassId;
  insideGroup?: boolean;
}

const structuralDiagnostics = (
  document: GraphDocument,
  options: GraphFragmentValidationOptions,
): UnifiedDiagnostic[] => {
  const registry = options.registry ?? DEFAULT_NODE_REGISTRY;
  const diagnostics = validateGraph(document, registry).diagnostics.filter((item) => item.code !== 'graph.output-count');
  if (!options.insideGroup) return diagnostics;
  for (const node of document.nodes) {
    const definition = registry.get(node.type, node.typeVersion);
    if (!definition || isNodeAllowedInPureGroup(definition)) continue;
    diagnostics.push({
      message: `${definition.title} 是上下文、资源或 Output 节点，不能用于纯函数 Group`,
      severity: 'error',
      stage: 'graph-validate',
      code: 'graph.group-node-not-pure',
      params: { title: definition.title },
      origin: { kind: 'graph', pass: document.pass, nodeId: node.id },
    });
  }
  if (document.parameters.length) diagnostics.push({
    message: '纯函数 Group 不能包含项目 Parameter',
    severity: 'error',
    stage: 'graph-validate',
    code: 'graph.group-parameter-not-pure',
    origin: { kind: 'graph', pass: document.pass },
  });
  return diagnostics;
};

const diagnosticKey = (item: UnifiedDiagnostic): string => {
  const origin = item.origin.kind === 'graph' ? item.origin : undefined;
  return [item.code, origin?.nodeId, origin?.socketId, origin?.edgeId, origin?.parameterId].join('\u0000');
};

export function validateGraphFragment(
  fragment: GraphFragment,
  options: GraphFragmentValidationOptions = {},
): UnifiedDiagnostic[] {
  const pass = options.pass ?? 'image';
  return structuralDiagnostics({
    ...createEmptyGraph(pass),
    nodes: fragment.nodes,
    edges: fragment.edges,
    parameters: fragment.parameters,
  }, { ...options, pass });
}

export function canInsertGraphFragment(
  document: GraphDocument,
  fragment: GraphFragment,
  options: GraphFragmentValidationOptions = {},
): boolean {
  const context = { ...options, pass: document.pass };
  if (validateGraphFragment(fragment, context).length > 0) return false;
  const merged: GraphDocument = {
    ...document,
    nodes: [...document.nodes, ...fragment.nodes],
    edges: [...document.edges, ...fragment.edges],
    parameters: [...document.parameters, ...fragment.parameters],
  };
  const baselineCounts = new Map<string, number>();
  for (const item of structuralDiagnostics(document, context)) {
    const key = diagnosticKey(item);
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
  }
  for (const item of structuralDiagnostics(merged, context)) {
    const key = diagnosticKey(item);
    const remaining = baselineCounts.get(key) ?? 0;
    if (remaining === 0) return false;
    baselineCounts.set(key, remaining - 1);
  }
  return true;
}
