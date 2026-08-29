import type { GraphDocument, GraphEdge, GraphNode, GraphParameterValue, GraphSocketRef, GraphValueType } from '../model';
import type { GraphNodeGroupDefinition, LibrarySocket } from '../library';
import { isNodeAllowedInPureGroup, type NodeDefinition, type NodeRegistry, type SocketDefinition } from '../registry';

export interface BuildNodeGroupOptions {
  id: string;
  version?: number;
  title?: string;
  instanceNodeId: string;
  edgeId: (purpose: string) => string;
}

export interface BuildNodeGroupResult {
  group: GraphNodeGroupDefinition;
  document: GraphDocument;
  instanceNodeId: string;
}

const key = (ref: GraphSocketRef) => `${ref.nodeId}\u0000${ref.socketId}`;

function defaultType(socket: SocketDefinition): GraphValueType {
  if (socket.defaultType) return socket.defaultType;
  if (!['numeric', 'vector', 'any-value'].includes(socket.type)) return socket.type as GraphValueType;
  return 'float';
}

function defaultValue(definition: NodeDefinition, node: GraphNode, socket: SocketDefinition, type: GraphValueType): GraphParameterValue {
  const value = Object.prototype.hasOwnProperty.call(node.values, socket.id)
    ? node.values[socket.id]
    : Object.prototype.hasOwnProperty.call(definition.defaultValues, socket.id)
      ? definition.defaultValues[socket.id]
      : socket.defaultValue;
  if (typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value)) return value as GraphParameterValue;
  if (type === 'bool') return false;
  if (type === 'int' || type === 'float') return 0;
  const count = type.endsWith('2') ? 2 : type.endsWith('3') || type === 'color3' ? 3 : 4;
  return Array.from({ length: count }, () => 0);
}

function inferOutputTypes(document: GraphDocument, registry: NodeRegistry): Map<string, GraphValueType> {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const incoming = new Map(document.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  const inputEdges = new Map(document.edges.map((edge) => [key(edge.to), edge]));
  for (const edge of document.edges) {
    if (!nodeMap.has(edge.from.nodeId) || !nodeMap.has(edge.to.nodeId)) throw new Error('Graph 包含悬空连接');
    incoming.set(edge.to.nodeId, (incoming.get(edge.to.nodeId) ?? 0) + 1);
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }
  const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const outputTypes = new Map<string, GraphValueType>();
  let visited = 0;
  while (queue.length) {
    const nodeId = queue.shift()!;
    visited++;
    const node = nodeMap.get(nodeId)!;
    const definition = registry.get(node.type, node.typeVersion);
    if (!definition) throw new Error(`节点定义不存在：${node.type}@${node.typeVersion}`);
    const inputTypes: Record<string, GraphValueType> = {};
    for (const socket of definition.inputs) {
      const edge = inputEdges.get(key({ nodeId, socketId: socket.id }));
      const type = edge ? outputTypes.get(key(edge.from)) : defaultType(socket);
      if (!type) throw new Error(`无法推导 ${node.type}.${socket.id} 的输入类型`);
      inputTypes[socket.id] = type;
    }
    const parameterId = typeof node.values.parameterId === 'string' ? node.values.parameterId : undefined;
    const parameterType = parameterId ? document.parameters.find((parameter) => parameter.id === parameterId)?.valueType : undefined;
    const inferred = definition.inferTypes({ node, inputTypes, parameterType });
    if (!inferred) throw new Error(`节点 ${definition.title} 的类型无法推导`);
    for (const socket of definition.outputs) {
      const type = inferred[socket.id];
      if (!type) throw new Error(`无法推导 ${definition.title}.${socket.title} 的输出类型`);
      outputTypes.set(key({ nodeId, socketId: socket.id }), type);
    }
    for (const target of outgoing.get(nodeId) ?? []) {
      const count = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, count);
      if (count === 0) queue.push(target);
    }
    queue.sort();
  }
  if (visited !== document.nodes.length) throw new Error('Graph 存在环，不能创建 Node Group');
  return outputTypes;
}

function socketTitle(definition: NodeDefinition, socketId: string, output: boolean): string {
  return (output ? definition.outputs : definition.inputs).find((socket) => socket.id === socketId)?.title ?? socketId;
}

function safeSocketId(prefix: string, index: number): string {
  return `${prefix}_${index + 1}`;
}

/** Builds a graph-backed, typed, pure Node Group and replaces the selection with one version-pinned instance. */
export function buildNodeGroupFromSelection(
  document: GraphDocument,
  selectedNodeIds: readonly string[],
  registry: NodeRegistry,
  options: BuildNodeGroupOptions,
): BuildNodeGroupResult {
  const selected = new Set(selectedNodeIds);
  if (!selected.size) throw new Error('请先选择要封装的节点');
  const nodes = document.nodes.filter((node) => selected.has(node.id));
  if (nodes.length !== selected.size) throw new Error('选择包含不存在的节点');
  for (const node of nodes) {
    const definition = registry.get(node.type, node.typeVersion);
    if (!definition) throw new Error(`节点定义不存在：${node.type}@${node.typeVersion}`);
    if (!isNodeAllowedInPureGroup(definition)) {
      throw new Error(`${definition.title} 是上下文、资源或 Output 节点，不能封装进纯函数 Group`);
    }
  }

  const types = inferOutputTypes(document, registry);
  const incoming = document.edges
    .filter((edge) => !selected.has(edge.from.nodeId) && selected.has(edge.to.nodeId))
    .sort((a, b) => key(a.to).localeCompare(key(b.to)) || key(a.from).localeCompare(key(b.from)));
  const outgoing = document.edges
    .filter((edge) => selected.has(edge.from.nodeId) && !selected.has(edge.to.nodeId))
    .sort((a, b) => key(a.from).localeCompare(key(b.from)) || key(a.to).localeCompare(key(b.to)));
  if (!outgoing.length) throw new Error('选择必须至少有一个连接到外部的输出');

  const inputs: LibrarySocket[] = incoming.map((edge, index) => {
    const target = document.nodes.find((node) => node.id === edge.to.nodeId)!;
    const definition = registry.get(target.type, target.typeVersion)!;
    const socket = definition.inputs.find((item) => item.id === edge.to.socketId);
    const type = types.get(key(edge.from));
    if (!socket || !type || type === 'sdf3') throw new Error(`边界输入 ${edge.to.socketId} 类型不受 Group 支持`);
    return { id: safeSocketId('in', index), title: socket.title, type, defaultValue: defaultValue(definition, target, socket, type) };
  });

  const uniqueOutputs = new Map<string, GraphEdge>();
  for (const edge of outgoing) if (!uniqueOutputs.has(key(edge.from))) uniqueOutputs.set(key(edge.from), edge);
  const outputEntries = [...uniqueOutputs.values()];
  const outputs = outputEntries.map((edge, index) => {
    const source = document.nodes.find((node) => node.id === edge.from.nodeId)!;
    const definition = registry.get(source.type, source.typeVersion)!;
    const type = types.get(key(edge.from));
    if (!type || type === 'sdf3') throw new Error(`边界输出 ${edge.from.socketId} 类型不受 Group 支持`);
    return { id: safeSocketId('out', index), title: socketTitle(definition, edge.from.socketId, true), type };
  });

  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const internalNodes = nodes.map((node) => ({ ...node, position: { x: node.position.x - minX + 80, y: node.position.y - minY + 80 }, values: { ...node.values } }));
  const internalEdges = document.edges
    .filter((edge) => selected.has(edge.from.nodeId) && selected.has(edge.to.nodeId))
    .map((edge) => ({ ...edge, from: { ...edge.from }, to: { ...edge.to } }));
  const version = options.version ?? 1;
  const group: GraphNodeGroupDefinition = {
    kind: 'graph',
    id: options.id,
    version,
    title: options.title?.trim() || 'Node Group',
    inputs,
    outputs,
    graph: {
      nodes: internalNodes,
      edges: internalEdges,
      inputBindings: incoming.map((edge, index) => ({ inputId: inputs[index].id, to: { ...edge.to } })),
      outputBindings: outputEntries.map((edge, index) => ({ outputId: outputs[index].id, from: { ...edge.from } })),
    },
  };

  const center = {
    x: nodes.reduce((sum, node) => sum + node.position.x, 0) / nodes.length,
    y: nodes.reduce((sum, node) => sum + node.position.y, 0) / nodes.length,
  };
  const instance: GraphNode = {
    id: options.instanceNodeId,
    type: `library.group.${options.id}`,
    typeVersion: version,
    position: center,
    values: Object.fromEntries(inputs.map((input) => [input.id, input.defaultValue])),
  };
  const inputEdges: GraphEdge[] = incoming.map((edge, index) => ({
    id: options.edgeId(`input-${index}`),
    from: { ...edge.from },
    to: { nodeId: instance.id, socketId: inputs[index].id },
  }));
  const outputBySource = new Map(outputEntries.map((edge, index) => [key(edge.from), outputs[index].id]));
  const outputEdges: GraphEdge[] = outgoing.map((edge, index) => ({
    id: options.edgeId(`output-${index}`),
    from: { nodeId: instance.id, socketId: outputBySource.get(key(edge.from))! },
    to: { ...edge.to },
  }));
  const parentEdges = document.edges.filter((edge) => !selected.has(edge.from.nodeId) && !selected.has(edge.to.nodeId));
  return {
    group,
    instanceNodeId: instance.id,
    document: {
      ...document,
      nodes: [...document.nodes.filter((node) => !selected.has(node.id)), instance],
      edges: [...parentEdges, ...inputEdges, ...outputEdges],
    },
  };
}
