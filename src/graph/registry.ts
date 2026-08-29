import type { ProductMessageDescriptor, ProductMessageParams } from '../productMessage';
import type { GraphNode, GraphParameterValue, GraphPassId, GraphValueType } from './model';
import { graphTypeComponents } from './model';
import type { IrExpr, NodeIrBuilder } from './compiler/ir';

export type SocketType = GraphValueType | 'numeric' | 'vector' | 'any-value';

export interface SocketDefinition {
  id: string;
  title: string;
  type: SocketType;
  defaultType?: GraphValueType;
  defaultValue?: unknown;
  /** Required sockets must be connected; persisted defaults cannot stand in for structured values. */
  required?: boolean;
}

export interface NodeTypeContext {
  node: GraphNode;
  inputTypes: Readonly<Record<string, GraphValueType>>;
  parameterType?: GraphValueType;
}

export interface NodeValueField {
  validate(value: unknown): ProductMessageDescriptor | undefined;
}

export interface NodeValueIssue extends ProductMessageDescriptor {
  field: string;
  socketId?: string;
  message: string;
}

function valueIssue(
  code: string,
  fallback: string,
  params?: ProductMessageParams,
): ProductMessageDescriptor {
  return { code, fallback, ...(params ? { params } : {}) };
}

export interface NodeLowerContext {
  node: GraphNode;
  inputs: Readonly<Record<string, IrExpr>>;
  inputTypes: Readonly<Record<string, GraphValueType>>;
  outputTypes: Readonly<Record<string, GraphValueType>>;
  parameterName?: string;
  parameterType?: GraphValueType;
  /** Resolves a stable project Pass Graph channel-sample node to its physical iChannel slot. */
  channelSlot(nodeId: string): 0 | 1 | 2 | 3 | undefined;
  /** Resolves a Texture2D node after Buffer slots and Asset Manifest identity are fixed. */
  textureBinding(nodeId: string): { slot: 0 | 1 | 2 | 3; assetId: string; colorSpace: 'srgb' | 'linear' } | undefined;
  ir: NodeIrBuilder;
  value(key: string): unknown;
  addHelper(key: string, source: string): void;
}

export type GraphHostTarget = 'visual' | 'sound';
export type NodeGroupKind = 'pure' | 'contextual' | 'resource' | 'output';

export const BOTH_GRAPH_HOST_TARGETS = ['visual', 'sound'] as const satisfies readonly GraphHostTarget[];
export const VISUAL_GRAPH_HOST_TARGETS = ['visual'] as const satisfies readonly GraphHostTarget[];
export const SOUND_GRAPH_HOST_TARGETS = ['sound'] as const satisfies readonly GraphHostTarget[];

export interface NodeDefinition {
  type: string;
  version: number;
  title: string;
  category: string;
  /** Host shader ABIs where this node can be lowered without implicit undefined context. */
  hostTargets: readonly GraphHostTarget[];
  /** Only explicitly pure nodes may be persisted inside graph-backed Node Groups. */
  groupKind: NodeGroupKind;
  inputs: readonly SocketDefinition[];
  outputs: readonly SocketDefinition[];
  defaultValues: Readonly<Record<string, unknown>>;
  /** Non-socket persisted fields must be explicitly declared here. */
  valueFields?: Readonly<Record<string, NodeValueField>>;
  inferTypes(context: NodeTypeContext): Record<string, GraphValueType> | null;
  lower(context: NodeLowerContext): Record<string, IrExpr>;
  output?: boolean;
  outputTarget?: 'visual' | 'sound';
}

export type NodeDefinitionDraft = Omit<NodeDefinition, 'hostTargets' | 'groupKind'>;

export function defineNodePolicy(
  definition: NodeDefinitionDraft,
  hostTargets: readonly GraphHostTarget[],
  groupKind: NodeGroupKind,
): NodeDefinition {
  return { ...definition, hostTargets: [...hostTargets], groupKind };
}

export function defineNodesPolicy(
  definitions: readonly NodeDefinitionDraft[],
  hostTargets: readonly GraphHostTarget[],
  groupKind: NodeGroupKind,
): readonly NodeDefinition[] {
  return definitions.map((definition) => defineNodePolicy(definition, hostTargets, groupKind));
}

export function graphHostTarget(pass: GraphPassId): GraphHostTarget {
  return pass === 'sound' ? 'sound' : 'visual';
}

export function isNodeAvailableInPass(definition: NodeDefinition, pass: GraphPassId): boolean {
  return definition.hostTargets.includes(graphHostTarget(pass));
}

export function isNodeAllowedInPureGroup(definition: NodeDefinition): boolean {
  return definition.groupKind === 'pure'
    && definition.hostTargets.includes('visual')
    && definition.hostTargets.includes('sound');
}

export function compareStableStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function graphValueField(type: GraphValueType): NodeValueField {
  return {
    validate(value) {
      if (type === 'bool') return typeof value === 'boolean'
        ? undefined
        : valueIssue('graph.value-boolean-required', '必须是布尔值');
      if (type === 'int') return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
        ? undefined
        : valueIssue('graph.value-integer-required', '必须是有限整数');
      if (type === 'float') return typeof value === 'number' && Number.isFinite(value)
        ? undefined
        : valueIssue('graph.value-number-required', '必须是有限数字');
      const count = graphTypeComponents(type);
      return Array.isArray(value) && value.length === count && value.every((item) => typeof item === 'number' && Number.isFinite(item))
        ? undefined
        : valueIssue(
          'graph.value-components-required',
          `必须是包含 ${count} 个有限数字的数组`,
          { count },
        );
    },
  };
}

export function valueField(validate: NodeValueField['validate']): NodeValueField {
  return { validate };
}

function socketValueType(socket: SocketDefinition): GraphValueType | undefined {
  if (socket.defaultType) return socket.defaultType;
  if (socket.type === 'numeric') return 'float';
  if (socket.type === 'vector') return 'vec2';
  if (socket.type === 'any-value') return undefined;
  return socket.type;
}

export function validateNodeValues(node: GraphNode, definition: NodeDefinition): NodeValueIssue[] {
  const issues: NodeValueIssue[] = [];
  const inputMap = new Map(definition.inputs.map((socket) => [socket.id, socket]));
  for (const [field, value] of Object.entries(node.values)) {
    const socket = inputMap.get(field);
    const explicit = definition.valueFields?.[field];
    const type = socket ? socketValueType(socket) : undefined;
    const validators = [type ? graphValueField(type) : undefined, explicit].filter((item): item is NodeValueField => item !== undefined);
    if (validators.length === 0) {
      issues.push({
        field,
        ...(socket ? { socketId: socket.id } : {}),
        code: 'graph.value-undeclared',
        fallback: '未在节点定义中声明此字段',
        message: '未在节点定义中声明此字段',
      });
      continue;
    }
    for (const validator of validators) {
      const descriptor = validator.validate(value);
      if (descriptor) {
        issues.push({
          field,
          ...(socket ? { socketId: socket.id } : {}),
          ...descriptor,
          message: descriptor.fallback ?? descriptor.code,
        });
        break;
      }
    }
  }
  return issues;
}

export class NodeRegistry {
  private readonly definitions = new Map<string, NodeDefinition>();

  register(definition: NodeDefinition): this {
    const key = `${definition.type}@${definition.version}`;
    if (this.definitions.has(key)) throw new Error(`节点定义重复：${key}`);
    for (const [field, value] of Object.entries(definition.defaultValues)) {
      const synthetic: GraphNode = { id: key, type: definition.type, typeVersion: definition.version, position: { x: 0, y: 0 }, values: { [field]: value } };
      const issue = validateNodeValues(synthetic, definition)[0];
      if (issue) throw new Error(`节点 ${key} 的默认值 ${field} 无效：${issue.message}`);
    }
    for (const socket of definition.inputs) {
      if (socket.defaultValue === undefined) continue;
      const synthetic: GraphNode = { id: key, type: definition.type, typeVersion: definition.version, position: { x: 0, y: 0 }, values: { [socket.id]: socket.defaultValue } };
      const issue = validateNodeValues(synthetic, definition)[0];
      if (issue) throw new Error(`节点 ${key} 的 Socket 默认值 ${socket.id} 无效：${issue.message}`);
    }
    if (!Array.isArray(definition.hostTargets) || !definition.hostTargets.length || definition.hostTargets.some((target) => target !== 'visual' && target !== 'sound')) {
      throw new Error(`节点 ${key} 缺少有效的 hostTargets 策略`);
    }
    if (!['pure', 'contextual', 'resource', 'output'].includes(definition.groupKind)) {
      throw new Error(`节点 ${key} 缺少有效的 groupKind 策略`);
    }
    this.definitions.set(key, definition);
    return this;
  }

  registerAll(definitions: readonly NodeDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  get(type: string, version = 1): NodeDefinition | undefined {
    return this.definitions.get(`${type}@${version}`);
  }

  has(type: string, version = 1): boolean {
    return this.get(type, version) !== undefined;
  }

  list(): NodeDefinition[] {
    return [...this.definitions.values()].sort((a, b) =>
      compareStableStrings(a.type, b.type) || a.version - b.version,
    );
  }

  get size(): number {
    return this.definitions.size;
  }
}

export function fixedOutputs(outputs: Readonly<Record<string, GraphValueType>>): NodeDefinition['inferTypes'] {
  return () => ({ ...outputs });
}

export function firstInputType(outputId = 'out', inputId = 'value'): NodeDefinition['inferTypes'] {
  return ({ inputTypes }) => inputTypes[inputId] ? { [outputId]: inputTypes[inputId] } : null;
}

export function commonNumericType(types: readonly (GraphValueType | undefined)[]): GraphValueType | null {
  const present = types.filter((type): type is GraphValueType => type !== undefined);
  if (present.length === 0) return 'float';
  if (present.some((type) => type === 'bool' || type === 'int')) return null;
  const vectors = present.filter((type) => type !== 'float');
  if (vectors.length === 0) return 'float';
  const first = vectors[0];
  const firstCanonical = first === 'color3' ? 'vec3' : first === 'color4' ? 'vec4' : first;
  if (!vectors.every((type) => {
    const canonical = type === 'color3' ? 'vec3' : type === 'color4' ? 'vec4' : type;
    return canonical === firstCanonical;
  })) return null;
  return first;
}

export function asGraphParameterValue(value: unknown): GraphParameterValue {
  if (typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value)) return value as GraphParameterValue;
  throw new Error('Validated Graph value is unavailable');
}

export function createDefaultRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.registerAll(CORE_NODES);
  registry.registerAll(VECTOR_NODES);
  registry.registerAll(COLOR_NODES);
  registry.registerAll(SDF2D_NODES);
  registry.registerAll(TEXTURE_NODES);
  registry.registerAll(SDF3D_NODES);
  registry.registerAll(SOUND_NODES);
  return registry;
}

import { CORE_NODES } from './nodes/core';
import { VECTOR_NODES } from './nodes/vector';
import { COLOR_NODES } from './nodes/color';
import { SDF2D_NODES } from './nodes/sdf2d';
import { TEXTURE_NODES } from './nodes/texture';
import { SDF3D_NODES } from './nodes/sdf3d';
import { SOUND_NODES } from './nodes/sound';

export const DEFAULT_NODE_REGISTRY = createDefaultRegistry();
