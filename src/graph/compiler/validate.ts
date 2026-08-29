import type { UnifiedDiagnostic } from '../../diagnostics/model';
import type { GraphDocument, GraphEdge, GraphNode, GraphPassId } from '../model';
import { compareStableStrings, isNodeAvailableInPass, validateNodeValues, type NodeDefinition, type NodeRegistry } from '../registry';

export interface ValidatedGraph {
  nodeMap: Map<string, GraphNode>;
  definitionMap: Map<string, NodeDefinition>;
  inputEdges: Map<string, GraphEdge>;
  topologicalOrder: string[];
  outputNodeId?: string;
  diagnostics: UnifiedDiagnostic[];
}

function origin(pass: GraphPassId, detail: { nodeId?: string; socketId?: string; edgeId?: string; parameterId?: string } = {}) {
  return { kind: 'graph' as const, pass, ...detail };
}

function diagnostic(
  pass: GraphPassId,
  code: string,
  message: string,
  detail: { nodeId?: string; socketId?: string; edgeId?: string; parameterId?: string } = {},
): UnifiedDiagnostic {
  return { message, severity: 'error', stage: 'graph-validate', code, origin: origin(pass, detail) };
}

export function validateGraph(document: GraphDocument, registry: NodeRegistry): ValidatedGraph {
  const diagnostics: UnifiedDiagnostic[] = [];
  const nodeMap = new Map<string, GraphNode>();
  const definitionMap = new Map<string, NodeDefinition>();
  const parameterIds = new Set<string>();
  const edgeIds = new Set<string>();
  const inputEdges = new Map<string, GraphEdge>();

  for (const parameter of [...document.parameters].sort((a, b) => compareStableStrings(a.id, b.id))) {
    if (parameterIds.has(parameter.id)) {
      diagnostics.push(diagnostic(document.pass, 'graph.duplicate-parameter-id', `参数 ID 重复：${parameter.id}`, { parameterId: parameter.id }));
    }
    parameterIds.add(parameter.id);
  }

  for (const node of [...document.nodes].sort((a, b) => compareStableStrings(a.id, b.id))) {
    if (nodeMap.has(node.id)) {
      diagnostics.push(diagnostic(document.pass, 'graph.duplicate-node-id', `节点 ID 重复：${node.id}`, { nodeId: node.id }));
      continue;
    }
    nodeMap.set(node.id, node);
    const definition = registry.get(node.type, node.typeVersion);
    if (!definition) {
      diagnostics.push(diagnostic(document.pass, 'graph.unknown-node', `未知节点或版本：${node.type}@${node.typeVersion}`, { nodeId: node.id }));
      continue;
    }
    definitionMap.set(node.id, definition);
    if (!isNodeAvailableInPass(definition, document.pass)) {
      diagnostics.push(diagnostic(document.pass, 'graph.node-pass-unavailable', `${definition.title} 不能用于 ${document.pass} Graph`, { nodeId: node.id }));
    }
    for (const issue of validateNodeValues(node, definition)) {
      diagnostics.push({
        message: issue.message,
        severity: 'error',
        stage: 'graph-validate',
        code: issue.code,
        params: { ...issue.params, field: issue.field },
        ...(issue.rawDetail ? { rawDetail: issue.rawDetail } : {}),
        origin: origin(document.pass, {
          nodeId: node.id,
          ...(issue.socketId ? { socketId: issue.socketId } : {}),
        }),
      });
    }
    if (node.type === 'core.parameter') {
      const parameterId = node.values.parameterId;
      if (typeof parameterId !== 'string' || !parameterIds.has(parameterId)) {
        diagnostics.push(diagnostic(document.pass, 'graph.unknown-parameter', 'Parameter 节点引用了不存在的参数', { nodeId: node.id, parameterId: typeof parameterId === 'string' ? parameterId : undefined }));
      }
    }
  }

  const target = document.pass === 'sound' ? 'sound' : 'visual';
  const allOutputs = document.nodes.filter((node) => definitionMap.get(node.id)?.output);
  const outputs = allOutputs.filter((node) => (definitionMap.get(node.id)?.outputTarget ?? 'visual') === target);
  for (const node of allOutputs.filter((item) => !outputs.includes(item))) {
    diagnostics.push(diagnostic(document.pass, 'graph.output-target', `${node.type} 不能用于 ${document.pass} Graph`, { nodeId: node.id }));
  }
  if (outputs.length !== 1) {
    diagnostics.push(diagnostic(document.pass, 'graph.output-count', `${target === 'sound' ? 'Sound' : 'Visual'} Graph 必须且只能包含一个匹配的 Output，当前为 ${outputs.length}`));
  }

  const validEdges: GraphEdge[] = [];
  for (const edge of [...document.edges].sort((a, b) => compareStableStrings(a.id, b.id))) {
    if (edgeIds.has(edge.id)) {
      diagnostics.push(diagnostic(document.pass, 'graph.duplicate-edge-id', `边 ID 重复：${edge.id}`, { edgeId: edge.id }));
      continue;
    }
    edgeIds.add(edge.id);
    if (edge.from.nodeId === edge.to.nodeId) {
      diagnostics.push(diagnostic(document.pass, 'graph.self-edge', '节点不能连接到自身', { nodeId: edge.from.nodeId, edgeId: edge.id }));
      continue;
    }
    const fromNode = nodeMap.get(edge.from.nodeId);
    const toNode = nodeMap.get(edge.to.nodeId);
    if (!fromNode || !toNode) {
      diagnostics.push(diagnostic(document.pass, 'graph.dangling-edge', '边引用了不存在的节点', { edgeId: edge.id }));
      continue;
    }
    const fromDefinition = definitionMap.get(fromNode.id);
    const toDefinition = definitionMap.get(toNode.id);
    if (!fromDefinition || !toDefinition) continue;
    const fromOutput = fromDefinition.outputs.find((socket) => socket.id === edge.from.socketId);
    const fromInput = fromDefinition.inputs.find((socket) => socket.id === edge.from.socketId);
    const toInput = toDefinition.inputs.find((socket) => socket.id === edge.to.socketId);
    const toOutput = toDefinition.outputs.find((socket) => socket.id === edge.to.socketId);
    if (!fromOutput) {
      diagnostics.push(diagnostic(document.pass, fromInput ? 'graph.edge-direction' : 'graph.unknown-socket', fromInput ? '边的 from 必须是输出 Socket' : '边引用了未知输出 Socket', { nodeId: fromNode.id, socketId: edge.from.socketId, edgeId: edge.id }));
      continue;
    }
    if (!toInput) {
      diagnostics.push(diagnostic(document.pass, toOutput ? 'graph.edge-direction' : 'graph.unknown-socket', toOutput ? '边的 to 必须是输入 Socket' : '边引用了未知输入 Socket', { nodeId: toNode.id, socketId: edge.to.socketId, edgeId: edge.id }));
      continue;
    }
    const inputKey = `${edge.to.nodeId}\u0000${edge.to.socketId}`;
    if (inputEdges.has(inputKey)) {
      diagnostics.push(diagnostic(document.pass, 'graph.duplicate-input', '一个输入 Socket 最多只能连接一条边', { nodeId: toNode.id, socketId: edge.to.socketId, edgeId: edge.id }));
      continue;
    }
    inputEdges.set(inputKey, edge);
    validEdges.push(edge);
  }

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeMap.keys()) {
    indegree.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of validEdges) {
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1);
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }
  for (const targets of outgoing.values()) targets.sort();
  const ready = [...nodeMap.keys()].filter((id) => indegree.get(id) === 0).sort();
  const topologicalOrder: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    topologicalOrder.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  if (topologicalOrder.length !== nodeMap.size) {
    const cyclic = [...nodeMap.keys()].filter((id) => (indegree.get(id) ?? 0) > 0).sort();
    for (const nodeId of cyclic) {
      diagnostics.push(diagnostic(document.pass, 'graph.cycle', 'Graph 包含有向循环', { nodeId }));
    }
  }

  return {
    nodeMap,
    definitionMap,
    inputEdges,
    topologicalOrder,
    outputNodeId: outputs.length === 1 ? outputs[0].id : undefined,
    diagnostics,
  };
}
