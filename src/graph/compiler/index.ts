import type { DiagnosticOrigin, UnifiedDiagnostic } from '../../diagnostics/model';
import { EMPTY_GRAPH_LIBRARY_REVISION } from '../library';
import type { GraphDocument, GraphParameter, GraphPassId, GraphValueType } from '../model';
import { compareStableStrings, DEFAULT_NODE_REGISTRY, NodeRegistry, type SocketDefinition } from '../registry';
import { normalizeGraphDocument, parseGraphJson, type GraphSchemaIssue } from '../schema';
import { canConvertType, defaultWidget, emitTypedIr, lowerUniformType, parameterDefault } from './emitGlsl';
import { deterministicHash, stableStringify } from './hash';
import { createNodeIrBuilder, type IrBinding, type IrExpr, type IrTrustedHelper, type TypedIrModule } from './ir';
import { createEmptySourceMap } from './sourceMap';
import type { GeneratedUniform, GraphCompileResult } from './types';
import { validateGraph } from './validate';

export * from './types';
export * from './sourceMap';
export * from './ir';
export * from './hash';
export { emitTypedIr } from './emitGlsl';
export { validateGraph } from './validate';

export interface CompileGraphOptions {
  registry?: NodeRegistry;
  /** Stable node ID -> physical slot, produced only by a resolved project Pass Graph. */
  channelEnvironment?: Readonly<Record<string, 0 | 1 | 2 | 3>>;
  channelEnvironmentRevision?: string;
  /** Stable Texture2D node ID -> asset binding, resolved after Buffer slots. */
  textureEnvironment?: Readonly<Record<string, { slot: 0 | 1 | 2 | 3; assetId: string; colorSpace: 'srgb' | 'linear' }>>;
  textureEnvironmentRevision?: string;
  /** Hash of normalized project Graph Library definitions. */
  libraryRevision?: string;
}

export interface GraphIrBuildResult {
  ok: boolean;
  pass: GraphPassId;
  semanticHash: string;
  revision: string;
  uniforms: GeneratedUniform[];
  diagnostics: UnifiedDiagnostic[];
  ir?: TypedIrModule;
}

function graphOrigin(pass: GraphPassId, detail: { nodeId?: string; socketId?: string; edgeId?: string; parameterId?: string } = {}): DiagnosticOrigin {
  return { kind: 'graph', pass, ...detail };
}

function typeDiagnostic(
  pass: GraphPassId,
  code: string,
  message: string,
  detail: {
    nodeId?: string;
    socketId?: string;
    edgeId?: string;
    parameterId?: string;
    params?: UnifiedDiagnostic['params'];
    rawDetail?: string;
  } = {},
): UnifiedDiagnostic {
  return {
    message,
    severity: 'error',
    stage: 'graph-typecheck',
    code,
    ...(detail.params ? { params: detail.params } : {}),
    ...(detail.rawDetail !== undefined ? { rawDetail: detail.rawDetail } : {}),
    origin: graphOrigin(pass, detail),
  };
}

function internalDiagnostic(pass: GraphPassId, error: unknown): UnifiedDiagnostic {
  return {
    message: 'Graph 编译器发生内部错误',
    severity: 'error',
    stage: 'graph-validate',
    code: 'compiler.internal',
    rawDetail: error instanceof Error ? error.message : String(error),
    origin: graphOrigin(pass),
  };
}

function schemaDiagnostic(pass: GraphPassId, value: GraphSchemaIssue): UnifiedDiagnostic {
  return {
    message: value.message,
    severity: 'error',
    stage: 'graph-schema',
    code: value.code,
    ...(value.params ? { params: value.params } : {}),
    ...(value.rawDetail !== undefined ? { rawDetail: value.rawDetail } : {}),
    origin: graphOrigin(pass, {
      ...(value.nodeId ? { nodeId: value.nodeId } : {}),
      ...(value.edgeId ? { edgeId: value.edgeId } : {}),
      ...(value.parameterId ? { parameterId: value.parameterId } : {}),
    }),
  };
}

function canonicalType(type: GraphValueType): GraphValueType {
  if (type === 'color3') return 'vec3';
  if (type === 'color4') return 'vec4';
  return type;
}

function socketAccepts(socket: SocketDefinition, actual: GraphValueType): boolean {
  if (socket.type === 'any-value') return true;
  if (socket.type === 'numeric') return !['bool', 'int'].includes(actual);
  if (socket.type === 'vector') return ['vec2', 'vec3', 'vec4', 'color3', 'color4'].includes(actual);
  return canConvertType(actual, socket.type);
}

function defaultInputType(socket: SocketDefinition): GraphValueType {
  if (socket.defaultType) return socket.defaultType;
  if (!['numeric', 'vector', 'any-value'].includes(socket.type)) return socket.type as GraphValueType;
  return 'float';
}

function inputKey(nodeId: string, socketId: string): string {
  return `${nodeId}\u0000${socketId}`;
}

function outputKey(nodeId: string, socketId: string): string {
  return `${nodeId}\u0000${socketId}`;
}

function collectReachable(outputNodeId: string, inputEdges: Map<string, { from: { nodeId: string } }>): Set<string> {
  const reachable = new Set<string>();
  const stack = [outputNodeId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const [key, edge] of inputEdges) {
      if (key.startsWith(`${nodeId}\u0000`)) stack.push(edge.from.nodeId);
    }
  }
  return reachable;
}

function semanticRepresentation(document: GraphDocument): unknown {
  return {
    format: document.format,
    version: document.version,
    pass: document.pass,
    nodes: document.nodes
      .map((node) => ({ id: node.id, type: node.type, typeVersion: node.typeVersion, values: node.values }))
      .sort((a, b) => compareStableStrings(a.id, b.id)),
    edges: document.edges
      .map((edge) => ({ from: edge.from, to: edge.to }))
      .sort((a, b) =>
        compareStableStrings(a.from.nodeId, b.from.nodeId) ||
        compareStableStrings(a.from.socketId, b.from.socketId) ||
        compareStableStrings(a.to.nodeId, b.to.nodeId) ||
        compareStableStrings(a.to.socketId, b.to.socketId),
      ),
    parameters: document.parameters
      .map((parameter) => ({
        id: parameter.id,
        name: parameter.name,
        valueType: parameter.valueType,
        defaultValue: parameter.defaultValue,
        ui: parameter.ui,
      }))
      .sort((a, b) => compareStableStrings(a.id, b.id)),
  };
}

/** Injective GLSL-safe encoding: emitted identity depends on parameter ID only. */
function stableUniformName(parameterId: string): string {
  const encoded = Array.from(parameterId, (character) => character.codePointAt(0)!.toString(16)).join('_');
  return `_sg_u_id_${encoded || 'empty'}`;
}

function makeUniforms(
  document: GraphDocument,
  reachableNodeIds: Set<string>,
): { uniforms: GeneratedUniform[]; names: Map<string, string> } {
  const parameterMap = new Map(document.parameters.map((parameter) => [parameter.id, parameter]));
  const references = new Map<string, string[]>();
  for (const node of document.nodes) {
    if (!reachableNodeIds.has(node.id) || node.type !== 'core.parameter') continue;
    const parameterId = node.values.parameterId;
    if (typeof parameterId !== 'string' || !parameterMap.has(parameterId)) continue;
    const list = references.get(parameterId) ?? [];
    list.push(node.id);
    references.set(parameterId, list);
  }
  const names = new Map<string, string>();
  const uniforms = [...references.keys()].sort(compareStableStrings).map((id): GeneratedUniform => {
    const parameter = parameterMap.get(id)!;
    const emittedName = stableUniformName(id);
    names.set(id, emittedName);
    const nodeIds = references.get(id)!.sort(compareStableStrings);
    return {
      id,
      displayName: parameter.name,
      emittedName,
      type: lowerUniformType(parameter.valueType),
      defaultValue: parameterDefault(parameter.defaultValue),
      ...(parameter.ui?.min !== undefined ? { min: parameter.ui.min } : {}),
      ...(parameter.ui?.max !== undefined ? { max: parameter.ui.max } : {}),
      ...(parameter.ui?.step !== undefined ? { step: parameter.ui.step } : {}),
      widget: parameter.ui?.widget ?? defaultWidget(parameter.valueType),
      pass: document.pass,
      nodeId: nodeIds[0],
    };
  });
  return { uniforms, names };
}

function parameterForNode(nodeValues: Record<string, unknown>, parameters: Map<string, GraphParameter>): GraphParameter | undefined {
  return typeof nodeValues.parameterId === 'string' ? parameters.get(nodeValues.parameterId) : undefined;
}

function initialPass(input: unknown): GraphPassId {
  if (input && typeof input === 'object') {
    const candidate = (input as { pass?: unknown }).pass;
    if (['image', 'bufferA', 'bufferB', 'bufferC', 'bufferD', 'sound'].includes(String(candidate))) return candidate as GraphPassId;
  }
  return 'image';
}

function failedBuild(pass: GraphPassId, diagnostics: UnifiedDiagnostic[], semanticHash = deterministicHash('invalid-graph')): GraphIrBuildResult {
  return { ok: false, pass, semanticHash, revision: semanticHash, uniforms: [], diagnostics };
}

export function buildTypedIr(
  input: unknown,
  options: CompileGraphOptions | NodeRegistry = {},
): GraphIrBuildResult {
  let pass = initialPass(input);
  try {
    const schema = typeof input === 'string' ? parseGraphJson(input) : normalizeGraphDocument(input);
    if (!schema.ok || !schema.document) return failedBuild(pass, schema.diagnostics.map((item) => schemaDiagnostic(pass, item)));

    const document = schema.document;
    pass = document.pass;
    const compileOptions: CompileGraphOptions = options instanceof NodeRegistry ? { registry: options } : options;
    const channelEnvironment = compileOptions.channelEnvironment ?? {};
    const textureEnvironment = compileOptions.textureEnvironment ?? {};
    const graphSemanticHash = deterministicHash(stableStringify(semanticRepresentation(document)));
    const channelEnvironmentRevision = compileOptions.channelEnvironmentRevision
      ?? deterministicHash(stableStringify(channelEnvironment));
    const textureEnvironmentRevision = compileOptions.textureEnvironmentRevision
      ?? deterministicHash(stableStringify(textureEnvironment));
    const libraryRevision = compileOptions.libraryRevision ?? EMPTY_GRAPH_LIBRARY_REVISION;
    const semanticHash = deterministicHash(stableStringify({ graphSemanticHash, channelEnvironment, channelEnvironmentRevision, textureEnvironment, textureEnvironmentRevision, libraryRevision }));
    const revision = semanticHash;
    const registry = compileOptions.registry ?? DEFAULT_NODE_REGISTRY;
    const validated = validateGraph(document, registry);
    if (validated.diagnostics.length > 0 || !validated.outputNodeId) return failedBuild(pass, validated.diagnostics, semanticHash);

    const reachable = collectReachable(validated.outputNodeId, validated.inputEdges);
    const fullTopological = validated.topologicalOrder;
    const topological = fullTopological.filter((nodeId) => reachable.has(nodeId));
    const parameterMap = new Map(document.parameters.map((parameter) => [parameter.id, parameter]));
    const { uniforms, names: uniformNames } = makeUniforms(document, reachable);
    const outputTypes = new Map<string, GraphValueType>();
    const nodeInputTypes = new Map<string, Record<string, GraphValueType>>();
    const nodeOutputTypes = new Map<string, Record<string, GraphValueType>>();
    const diagnostics: UnifiedDiagnostic[] = [];

    for (const nodeId of fullTopological) {
      const node = validated.nodeMap.get(nodeId)!;
      const definition = validated.definitionMap.get(nodeId)!;
      const inputTypes: Record<string, GraphValueType> = {};
      for (const socket of definition.inputs) {
        const edge = validated.inputEdges.get(inputKey(nodeId, socket.id));
        if (!edge && socket.required) {
          diagnostics.push(typeDiagnostic(pass, 'type.required-input', `输入 ${socket.title} 必须连接`, {
            nodeId,
            socketId: socket.id,
            params: { input: socket.title },
          }));
        }
        const actual = edge ? outputTypes.get(outputKey(edge.from.nodeId, edge.from.socketId)) : defaultInputType(socket);
        if (!actual) {
          diagnostics.push(typeDiagnostic(pass, 'type.missing-source-type', '无法确定连接来源的类型', { nodeId, socketId: socket.id, edgeId: edge?.id }));
          continue;
        }
        inputTypes[socket.id] = actual;
        if (!socketAccepts(socket, actual)) {
          diagnostics.push(typeDiagnostic(pass, 'type.incompatible', `类型 ${actual} 不能连接到 ${socket.type}`, {
            nodeId,
            socketId: socket.id,
            edgeId: edge?.id,
            params: { actual, expected: socket.type },
          }));
        }
      }
      const parameter = parameterForNode(node.values, parameterMap);
      const inferred = definition.inferTypes({ node, inputTypes, parameterType: parameter?.valueType });
      if (!inferred) {
        diagnostics.push(typeDiagnostic(pass, 'type.inference-failed', `节点 ${definition.title} 的输入类型不兼容`, {
          nodeId,
          params: { node: definition.title },
        }));
        continue;
      }
      for (const socket of definition.outputs) {
        const inferredType = inferred[socket.id];
        if (!inferredType) {
          diagnostics.push(typeDiagnostic(pass, 'type.output-unresolved', `无法推导输出 ${socket.id} 的类型`, {
            nodeId,
            socketId: socket.id,
            params: { output: socket.id },
          }));
          continue;
        }
        outputTypes.set(outputKey(nodeId, socket.id), inferredType);
      }
      nodeInputTypes.set(nodeId, inputTypes);
      nodeOutputTypes.set(nodeId, inferred);
    }
    if (diagnostics.length > 0) return failedBuild(pass, diagnostics, semanticHash);

    const references = new Map<string, IrExpr>();
    const bindings: IrBinding[] = [];
    const helpers = new Map<string, IrTrustedHelper>();
    let fragmentExpression: IrExpr | undefined;

    topological.forEach((nodeId, nodeIndex) => {
      const node = validated.nodeMap.get(nodeId)!;
      const definition = validated.definitionMap.get(nodeId)!;
      const inferredInputs = nodeInputTypes.get(nodeId)!;
      const inferredOutputs = nodeOutputTypes.get(nodeId)!;
      const inputs: Record<string, IrExpr> = {};
      const ir = createNodeIrBuilder({ nodeId });

      for (const socket of definition.inputs) {
        const edge = validated.inputEdges.get(inputKey(nodeId, socket.id));
        const fromType = inferredInputs[socket.id];
        let expression: IrExpr;
        if (edge) {
          const reference = references.get(outputKey(edge.from.nodeId, edge.from.socketId));
          if (!reference) throw new Error(`IR reference missing for ${edge.from.nodeId}.${edge.from.socketId}`);
          expression = reference;
        } else {
          const value = Object.prototype.hasOwnProperty.call(node.values, socket.id)
            ? node.values[socket.id]
            : Object.prototype.hasOwnProperty.call(definition.defaultValues, socket.id)
              ? definition.defaultValues[socket.id]
              : socket.defaultValue;
          expression = ir.literal(value as never, fromType);
        }

        let targetType = fromType;
        if (!['numeric', 'vector', 'any-value'].includes(socket.type)) {
          targetType = socket.type as GraphValueType;
        } else if (socket.type === 'numeric') {
          const primary = Object.values(inferredOutputs)[0];
          if (primary && canonicalType(primary) !== 'float' && fromType === 'float') targetType = primary;
        }
        if (expression.type !== targetType) expression = ir.convert(expression, targetType);
        inputs[socket.id] = expression;
      }

      const parameter = parameterForNode(node.values, parameterMap);
      const lowered = definition.lower({
        node,
        inputs,
        inputTypes: inferredInputs,
        outputTypes: inferredOutputs,
        parameterName: parameter ? uniformNames.get(parameter.id) : undefined,
        parameterType: parameter?.valueType,
        channelSlot: (stableNodeId) => channelEnvironment[stableNodeId],
        textureBinding: (stableNodeId) => textureEnvironment[stableNodeId],
        ir,
        value(key) {
          if (Object.prototype.hasOwnProperty.call(node.values, key)) return node.values[key];
          if (Object.prototype.hasOwnProperty.call(definition.defaultValues, key)) return definition.defaultValues[key];
          return definition.inputs.find((socket) => socket.id === key)?.defaultValue;
        },
        addHelper(key, source) {
          const current = helpers.get(key);
          if (current && current.source !== source) throw new Error(`Helper ${key} has conflicting declarations`);
          if (!current) helpers.set(key, { key, source, origin: { nodeId } });
        },
      });

      if (definition.output) {
        fragmentExpression = lowered.output ?? lowered.fragment ?? inputs.color ?? inputs.sample;
        if (!fragmentExpression) throw new Error(`${definition.title} did not lower an output expression`);
        return;
      }

      definition.outputs.forEach((socket, socketIndex) => {
        const type = inferredOutputs[socket.id];
        const expression = lowered[socket.id];
        if (!expression) throw new Error(`Node ${node.type} did not lower output ${socket.id}`);
        if (canonicalType(expression.type) !== canonicalType(type) && !canConvertType(expression.type, type)) {
          throw new Error(`Node ${node.type}.${socket.id} lowered ${expression.type}, expected ${type}`);
        }
        if (type === 'sdf3') {
          references.set(outputKey(nodeId, socket.id), expression);
          return;
        }
        const safeSocket = socket.id.replace(/[^A-Za-z0-9_]/g, '_');
        const id = `_sg_n${nodeIndex}_${safeSocket || socketIndex}`;
        const binding: IrBinding = { id, type, expression, origin: { nodeId, socketId: socket.id } };
        bindings.push(binding);
        references.set(outputKey(nodeId, socket.id), { kind: 'reference', bindingId: id, type, origin: binding.origin });
      });
    });

    if (!fragmentExpression) throw new Error('Typed IR has no fragment output');
    const ir: TypedIrModule = {
      version: 1,
      pass,
      target: pass === 'sound' ? 'sound' : 'visual',
      revision,
      semanticHash,
      uniforms,
      helpers: [...helpers.values()].sort((a, b) => compareStableStrings(a.key, b.key)),
      bindings,
      output: fragmentExpression,
      outputNodeId: validated.outputNodeId,
    };
    return { ok: true, pass, semanticHash, revision, uniforms, diagnostics: [], ir };
  } catch (error) {
    return failedBuild(pass, [internalDiagnostic(pass, error)]);
  }
}

function failed(
  pass: GraphPassId,
  diagnostics: UnifiedDiagnostic[],
  semanticHash = deterministicHash('invalid-graph'),
): GraphCompileResult {
  const source = '';
  return {
    ok: false,
    source,
    sourceMap: createEmptySourceMap(pass, semanticHash),
    uniforms: [],
    diagnostics,
    semanticHash,
    sourceHash: deterministicHash(source),
  };
}

export function compileGraph(
  input: unknown,
  options: CompileGraphOptions | NodeRegistry = {},
): GraphCompileResult {
  const built = buildTypedIr(input, options);
  if (!built.ok || !built.ir) return failed(built.pass, built.diagnostics, built.semanticHash);
  try {
    const emission = emitTypedIr(built.ir);
    const compileOptions: CompileGraphOptions = options instanceof NodeRegistry ? { registry: options } : options;
    const channelEnvironmentRevision = compileOptions.channelEnvironmentRevision
      ?? deterministicHash(stableStringify(compileOptions.channelEnvironment ?? {}));
    const textureEnvironmentRevision = compileOptions.textureEnvironmentRevision
      ?? deterministicHash(stableStringify(compileOptions.textureEnvironment ?? {}));
    const libraryRevision = compileOptions.libraryRevision ?? EMPTY_GRAPH_LIBRARY_REVISION;
    const artifact = {
      pass: built.pass,
      revision: built.revision,
      semanticHash: built.semanticHash,
      channelEnvironmentRevision,
      textureEnvironmentRevision,
      libraryRevision,
      sourceHash: emission.sourceHash,
      source: emission.source,
      sourceMap: emission.sourceMap,
      uniforms: built.uniforms,
    };
    return {
      ok: true,
      source: emission.source,
      sourceMap: emission.sourceMap,
      uniforms: built.uniforms,
      diagnostics: [],
      semanticHash: built.semanticHash,
      sourceHash: emission.sourceHash,
      ir: built.ir,
      artifact,
    };
  } catch (error) {
    return failed(built.pass, [internalDiagnostic(built.pass, error)], built.semanticHash);
  }
}
