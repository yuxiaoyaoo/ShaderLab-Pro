import { ProductError, type ProductMessageDescriptor, type ProductMessageParams } from '../productMessage';
import type { UnifiedDiagnostic } from '../diagnostics/model';
import { deterministicHash, stableStringify } from '../graph/compiler/hash';
import type { GraphDocument, GraphPassId, VisualGraphPassId } from '../graph/model';
import { BUFFER_IDS, type BufferId, type PassChannelCfg, type PassGraphReference, type ShaderlabProject } from './types';

export const PASS_GRAPH_FORMAT = 'shaderlab-pass-graph' as const;
export const CURRENT_PASS_GRAPH_VERSION = 1 as const;
export const DEFAULT_PASS_GRAPH_FILE = 'graphs/pass-graph.json';

export type ChannelTiming = 'current' | 'previous';
export type ChannelFilter = 'linear' | 'nearest';
export type ChannelWrap = 'repeat' | 'clamp';

export type PassGraphEndpoint =
  | { kind: 'graph-channel'; nodeId: string }
  | { kind: 'code-slot'; slot: 0 | 1 | 2 | 3 };

export type PassGraphSlot =
  | { mode: 'auto' }
  | { mode: 'manual'; index: 0 | 1 | 2 | 3 };

export interface PassGraphEdge {
  id: string;
  source: BufferId;
  target: VisualGraphPassId;
  endpoint: PassGraphEndpoint;
  slot: PassGraphSlot;
  filter: ChannelFilter;
  wrap: ChannelWrap;
  timing: ChannelTiming;
}

export interface PassGraphDocument {
  format: typeof PASS_GRAPH_FORMAT;
  version: typeof CURRENT_PASS_GRAPH_VERSION;
  edges: PassGraphEdge[];
  ui: {
    positions: Partial<Record<VisualGraphPassId, { x: number; y: number }>>;
  };
}

export interface ResolvedPassGraphEdge extends Omit<PassGraphEdge, 'slot'> {
  slot: 0 | 1 | 2 | 3;
}

export interface ResolvedPassGraph {
  revision: string;
  edges: ResolvedPassGraphEdge[];
  bufferOrder: BufferId[];
  channelEnvironment: Partial<Record<GraphPassId, Readonly<Record<string, 0 | 1 | 2 | 3>>>>;
}

export interface PassGraphResolution {
  ok: boolean;
  diagnostics: UnifiedDiagnostic[];
  resolved?: ResolvedPassGraph;
}

const graphPasses = ['image', ...BUFFER_IDS] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isGraphPass = (value: unknown): value is VisualGraphPassId => typeof value === 'string' && (graphPasses as readonly string[]).includes(value);
const isBuffer = (value: unknown): value is BufferId => typeof value === 'string' && (BUFFER_IDS as readonly string[]).includes(value);
const slotValue = (value: unknown): value is 0 | 1 | 2 | 3 => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;

export function createPassGraphDocument(): PassGraphDocument {
  return { format: PASS_GRAPH_FORMAT, version: CURRENT_PASS_GRAPH_VERSION, edges: [], ui: { positions: {} } };
}

function normalizeEndpoint(value: unknown): PassGraphEndpoint | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'graph-channel' && typeof value.nodeId === 'string' && value.nodeId.trim()) {
    return { kind: 'graph-channel', nodeId: value.nodeId.trim() };
  }
  if (value.kind === 'code-slot' && slotValue(value.slot)) return { kind: 'code-slot', slot: value.slot };
  return undefined;
}

function normalizeEdge(value: unknown): PassGraphEdge | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || !isBuffer(value.source) || !isGraphPass(value.target)) return undefined;
  const endpoint = normalizeEndpoint(value.endpoint);
  if (!endpoint) return undefined;
  const rawSlot = isRecord(value.slot) ? value.slot : {};
  const slot: PassGraphSlot | undefined = rawSlot.mode === 'auto'
    ? { mode: 'auto' }
    : rawSlot.mode === 'manual' && slotValue(rawSlot.index)
      ? { mode: 'manual', index: rawSlot.index }
      : undefined;
  if (!slot) return undefined;
  return {
    id: value.id.trim(),
    source: value.source,
    target: value.target,
    endpoint,
    slot,
    filter: value.filter === 'nearest' ? 'nearest' : 'linear',
    wrap: value.wrap === 'clamp' ? 'clamp' : 'repeat',
    timing: value.timing === 'previous' ? 'previous' : 'current',
  };
}

/** Future versions fail closed; malformed edges are rejected instead of guessed. */
export function parsePassGraph(input: unknown): PassGraphDocument {
  let value: unknown;
  try {
    value = typeof input === 'string' ? JSON.parse(input) as unknown : input;
  } catch (error) {
    throw new ProductError({
      code: 'pass-graph.invalid-json',
      fallback: 'Pass Graph JSON 无效',
      rawDetail: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(value) || value.format !== PASS_GRAPH_FORMAT) throw new ProductError({ code: 'pass-graph.invalid-format', fallback: '无效的 Pass Graph 文档格式' });
  const version = Number(value.version);
  if (!Number.isInteger(version) || version < 1) throw new ProductError({ code: 'pass-graph.invalid-version', fallback: '无效的 Pass Graph 版本' });
  if (version > CURRENT_PASS_GRAPH_VERSION) throw new ProductError({ code: 'pass-graph.future-version', params: { version, supported: CURRENT_PASS_GRAPH_VERSION }, fallback: `Pass Graph 版本 ${version} 高于当前支持版本 ${CURRENT_PASS_GRAPH_VERSION}` });
  if (!Array.isArray(value.edges)) throw new ProductError({ code: 'pass-graph.edges-missing', fallback: 'Pass Graph 缺少 edges' });
  const edges = value.edges.map(normalizeEdge);
  if (edges.some((edge) => !edge)) throw new ProductError({ code: 'pass-graph.invalid-edge', fallback: 'Pass Graph 包含无效连接' });
  const positions: PassGraphDocument['ui']['positions'] = {};
  const rawPositions = isRecord(value.ui) && isRecord(value.ui.positions) ? value.ui.positions : {};
  for (const pass of graphPasses) {
    const point = rawPositions[pass];
    if (isRecord(point) && Number.isFinite(point.x) && Number.isFinite(point.y)) positions[pass] = { x: Number(point.x), y: Number(point.y) };
  }
  return { format: PASS_GRAPH_FORMAT, version: CURRENT_PASS_GRAPH_VERSION, edges: edges as PassGraphEdge[], ui: { positions } };
}

export const serializePassGraph = (document: PassGraphDocument): string => `${JSON.stringify(parsePassGraph(document), null, 2)}\n`;

function endpointKey(edge: PassGraphEdge): string {
  return edge.endpoint.kind === 'graph-channel'
    ? `${edge.target}:graph:${edge.endpoint.nodeId}`
    : `${edge.target}:code:${edge.endpoint.slot}`;
}

function diagnostic(
  edge: PassGraphEdge | undefined,
  code: string,
  message: string,
  pass: GraphPassId = edge?.target ?? 'image',
  details: { params?: ProductMessageParams; rawDetail?: string } = {},
): UnifiedDiagnostic {
  return {
    severity: 'error', stage: 'graph-validate', code, message,
    ...(details.params ? { params: details.params } : {}),
    ...(details.rawDetail ? { rawDetail: details.rawDetail } : {}),
    origin: edge?.endpoint.kind === 'graph-channel'
      ? { kind: 'graph', pass, nodeId: edge.endpoint.nodeId }
      : { kind: 'code', pass, line: 1, column: 1 },
  };
}

function defaultGraphChannelNodes(document: GraphDocument | undefined): Set<string> {
  return new Set((document?.nodes ?? []).filter((node) => node.type === 'input.channel-sample').map((node) => node.id));
}

/** Pure validation and resolution. No Runtime state or array-order timing assumptions are used. */
export function resolvePassGraph(
  document: PassGraphDocument,
  project: ShaderlabProject,
  graphDocuments: Partial<Record<GraphPassId, GraphDocument>> = {},
): PassGraphResolution {
  let normalized: PassGraphDocument;
  try { normalized = parsePassGraph(document); } catch (error) {
    if (error instanceof ProductError) {
      return { ok: false, diagnostics: [diagnostic(undefined, error.code, error.fallback ?? error.code, 'image', { params: error.params, rawDetail: error.rawDetail })] };
    }
    return { ok: false, diagnostics: [diagnostic(undefined, 'pass-graph.invalid', 'Pass Graph 无效', 'image', { rawDetail: error instanceof Error ? error.message : String(error) })] };
  }
  const diagnostics: UnifiedDiagnostic[] = [];
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  const manualByTarget = new Map<GraphPassId, Map<number, PassGraphEdge>>();
  const sorted = [...normalized.edges].sort((a, b) => a.target.localeCompare(b.target) || endpointKey(a).localeCompare(endpointKey(b)) || a.id.localeCompare(b.id));

  for (const edge of sorted) {
    if (ids.has(edge.id)) diagnostics.push(diagnostic(edge, 'pass-graph.duplicate-edge', `重复连接 ID：${edge.id}`));
    ids.add(edge.id);
    const endpoint = endpointKey(edge);
    if (endpoints.has(endpoint)) diagnostics.push(diagnostic(edge, 'pass-graph.duplicate-endpoint', `目标 endpoint 重复：${endpoint}`));
    endpoints.add(endpoint);
    if (!project.passes[edge.source]?.enabled) diagnostics.push(diagnostic(edge, 'pass-graph.source-disabled', `来源 ${edge.source} 已禁用或缺失`));
    if (!project.passes[edge.target]?.enabled) diagnostics.push(diagnostic(edge, 'pass-graph.target-disabled', `目标 ${edge.target} 已禁用或缺失`));
    if (edge.source === edge.target && edge.timing === 'current') diagnostics.push(diagnostic(edge, 'pass-graph.current-self-loop', `${edge.target} 不允许 current self-loop；反馈必须使用 previous`));
    const authoring = project.passes[edge.target].authoring?.kind ?? 'code';
    if (edge.endpoint.kind === 'graph-channel') {
      if (authoring !== 'graph') diagnostics.push(diagnostic(edge, 'pass-graph.endpoint-authoring', `${edge.target} 是 Code Pass，不能连接 Graph channel endpoint`));
      else if (!defaultGraphChannelNodes(graphDocuments[edge.target]).has(edge.endpoint.nodeId)) diagnostics.push(diagnostic(edge, 'pass-graph.endpoint-missing', `${edge.target} 缺少 channel 节点 ${edge.endpoint.nodeId}`));
    } else if (authoring === 'graph') {
      diagnostics.push(diagnostic(edge, 'pass-graph.endpoint-authoring', `${edge.target} 是 Graph Pass，必须连接稳定 Graph channel endpoint`));
    } else if (edge.slot.mode !== 'manual' || edge.slot.index !== edge.endpoint.slot) {
      diagnostics.push(diagnostic(edge, 'pass-graph.code-slot-mismatch', `${edge.target} Code endpoint iChannel${edge.endpoint.slot} 必须使用相同的 manual slot`));
    }
    if (edge.slot.mode === 'manual') {
      const occupied = manualByTarget.get(edge.target) ?? new Map<number, PassGraphEdge>();
      const previous = occupied.get(edge.slot.index);
      if (previous) diagnostics.push(diagnostic(edge, 'pass-graph.duplicate-slot', `${edge.target} 的 iChannel${edge.slot.index} 被重复占用`));
      occupied.set(edge.slot.index, edge);
      manualByTarget.set(edge.target, occupied);
    }
  }

  for (const target of graphPasses) {
    if (sorted.filter((edge) => edge.target === target).length > 4) diagnostics.push(diagnostic(undefined, 'pass-graph.too-many-channels', `${target} 超过 4 个 channel`, target));
  }

  const currentAdj = new Map<BufferId, BufferId[]>();
  const indegree = new Map<BufferId, number>();
  const enabledBuffers = BUFFER_IDS.filter((pass) => project.passes[pass].enabled);
  for (const pass of enabledBuffers) { currentAdj.set(pass, []); indegree.set(pass, 0); }
  for (const edge of sorted) {
    if (edge.timing !== 'current' || edge.target === 'image' || !indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    currentAdj.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  const ready = enabledBuffers.filter((pass) => indegree.get(pass) === 0).sort();
  const bufferOrder: BufferId[] = [];
  while (ready.length) {
    const source = ready.shift()!;
    bufferOrder.push(source);
    for (const target of [...(currentAdj.get(source) ?? [])].sort()) {
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) { ready.push(target); ready.sort(); }
    }
  }
  if (bufferOrder.length !== enabledBuffers.length) diagnostics.push(diagnostic(undefined, 'pass-graph.current-cycle', 'current Buffer 连接形成有向环；请将反馈边改为 previous'));
  if (diagnostics.length) return { ok: false, diagnostics };

  const resolvedEdges: ResolvedPassGraphEdge[] = [];
  for (const target of graphPasses) {
    const targetEdges = sorted.filter((edge) => edge.target === target);
    const used = new Set(targetEdges.flatMap((edge) => edge.slot.mode === 'manual' ? [edge.slot.index] : []));
    for (const edge of targetEdges) {
      let index: 0 | 1 | 2 | 3;
      if (edge.slot.mode === 'manual') index = edge.slot.index;
      else {
        const available = ([0, 1, 2, 3] as const).find((candidate) => !used.has(candidate));
        if (available === undefined) return { ok: false, diagnostics: [diagnostic(edge, 'pass-graph.no-slot', `${target} 没有可用 channel slot`)] };
        index = available;
        used.add(index);
      }
      resolvedEdges.push({ ...edge, slot: index });
    }
  }
  resolvedEdges.sort((a, b) => a.target.localeCompare(b.target) || a.slot - b.slot || a.id.localeCompare(b.id));
  const channelEnvironment: ResolvedPassGraph['channelEnvironment'] = {};
  for (const edge of resolvedEdges) {
    if (edge.endpoint.kind !== 'graph-channel') continue;
    channelEnvironment[edge.target] = { ...(channelEnvironment[edge.target] ?? {}), [edge.endpoint.nodeId]: edge.slot };
  }
  const semantic = resolvedEdges.map(({ id: _id, ...edge }) => edge);
  const revision = deterministicHash(stableStringify({ version: normalized.version, edges: semantic, bufferOrder }));
  return { ok: true, diagnostics: [], resolved: { revision, edges: resolvedEdges, bufferOrder, channelEnvironment } };
}

/** A persisted reference is valid only when it identifies this exact resolved document. */
export function passGraphReferenceIssues(
  reference: PassGraphReference | undefined,
  document: PassGraphDocument,
  resolved: ResolvedPassGraph | undefined,
): { code: string; message: string; params?: ProductMessageParams; rawDetail?: string }[] {
  if (!reference) return [];
  const issues: { code: string; message: string; params?: ProductMessageParams; rawDetail?: string }[] = [];
  if (reference.formatVersion !== document.version || reference.formatVersion !== CURRENT_PASS_GRAPH_VERSION) {
    issues.push({
      code: 'pass-graph.reference-format-mismatch',
      message: `Pass Graph 引用版本 ${reference.formatVersion} 与文档版本 ${document.version} 不一致`,
      params: { referenceVersion: reference.formatVersion, documentVersion: document.version },
    });
  }
  if (!reference.revision) {
    issues.push({ code: 'pass-graph.reference-revision-missing', message: 'Pass Graph 引用缺少 revision，无法验证拓扑 identity' });
  } else if (!resolved || reference.revision !== resolved.revision) {
    issues.push({
      code: 'pass-graph.reference-revision-mismatch',
      message: `Pass Graph 引用 revision ${reference.revision} 与实际解析结果 ${resolved?.revision ?? 'invalid'} 不一致`,
      params: { referenceRevision: reference.revision, actualRevision: resolved?.revision ?? 'invalid' },
    });
  }
  return issues;
}

/** Materializes the reference from the exact PassGraph snapshot being persisted. */
export function projectWithPassGraphIdentity(
  project: ShaderlabProject,
  document: PassGraphDocument,
  resolved: ResolvedPassGraph,
): ShaderlabProject {
  return {
    ...project,
    passGraph: {
      file: project.passGraph?.file ?? DEFAULT_PASS_GRAPH_FILE,
      formatVersion: document.version,
      revision: resolved.revision,
    },
  };
}

function stableChannelNodeId(document: GraphDocument, target: GraphPassId, key: string): string {
  const base = `passgraph-channel-${target}-${deterministicHash(key)}`;
  if (!document.nodes.some((node) => node.id === base)) return base;
  const existing = document.nodes.find((node) => node.id === base);
  if (existing?.type === 'input.channel-sample') return base;
  let suffix = 1;
  while (document.nodes.some((node) => node.id === `${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function ensureChannelNode(
  document: GraphDocument,
  target: GraphPassId,
  key: string,
  row: number,
  replaceNodeId?: string,
): { document: GraphDocument; nodeId: string } {
  const nodeId = stableChannelNodeId(document, target, key);
  if (document.nodes.some((node) => node.id === nodeId && node.type === 'input.channel-sample')) return { document, nodeId };
  if (replaceNodeId) {
    const replacement = document.nodes.find((node) => node.id === replaceNodeId && node.type === 'input.channel-sample');
    if (replacement) {
      return {
        nodeId,
        document: {
          ...document,
          nodes: document.nodes.map((node) => node.id === replaceNodeId ? { ...node, id: nodeId } : node),
          edges: document.edges.map((edge) => ({
            ...edge,
            from: edge.from.nodeId === replaceNodeId ? { ...edge.from, nodeId } : edge.from,
            to: edge.to.nodeId === replaceNodeId ? { ...edge.to, nodeId } : edge.to,
          })),
        },
      };
    }
  }
  return {
    nodeId,
    document: {
      ...document,
      nodes: [...document.nodes, {
        id: nodeId,
        type: 'input.channel-sample',
        typeVersion: 1,
        position: { x: -360, y: row * 140 },
        values: { uv: [0, 0] },
      }],
    },
  };
}

export interface LegacyPassGraphMigration {
  passGraph: PassGraphDocument;
  graphDocuments: Partial<Record<GraphPassId, GraphDocument>>;
  migratedGraphPasses: GraphPassId[];
}

/**
 * Compatibility-only M3 migration. Graph targets receive dedicated stable sample
 * nodes, so legacy slots are retained without weakening the normal endpoint contract.
 */
export function migratePassGraphFromLegacy(
  project: ShaderlabProject,
  graphDocuments: Partial<Record<GraphPassId, GraphDocument>> = {},
): LegacyPassGraphMigration {
  const document = createPassGraphDocument();
  const migratedDocuments = { ...graphDocuments };
  const migratedGraphPasses = new Set<GraphPassId>();
  const legacySamples = new Map<GraphPassId, string[]>();
  const legacySampleCursor = new Map<GraphPassId, number>();
  for (const target of graphPasses) {
    legacySamples.set(target, [...(graphDocuments[target]?.nodes ?? [])]
      .filter((node) => node.type === 'input.channel-sample')
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id))
      .map((node) => node.id));
  }
  const append = (
    target: GraphPassId,
    edge: Omit<PassGraphEdge, 'endpoint'>,
    slot: 0 | 1 | 2 | 3,
  ) => {
    if (project.passes[target].authoring?.kind !== 'graph') {
      document.edges.push({ ...edge, endpoint: { kind: 'code-slot', slot } });
      return;
    }
    const sourceDocument = migratedDocuments[target];
    if (!sourceDocument) {
      // The missing Graph document is reported by project I/O; keep a strict endpoint
      // so resolution fails closed rather than silently dropping the legacy channel.
      document.edges.push({ ...edge, endpoint: { kind: 'graph-channel', nodeId: `missing-legacy-channel-${slot}` } });
      return;
    }
    const cursor = legacySampleCursor.get(target) ?? 0;
    const replaceNodeId = legacySamples.get(target)?.[cursor];
    legacySampleCursor.set(target, cursor + 1);
    const injected = ensureChannelNode(sourceDocument, target, `legacy:${target}:${slot}`, slot, replaceNodeId);
    migratedDocuments[target] = injected.document;
    migratedGraphPasses.add(target);
    document.edges.push({ ...edge, endpoint: { kind: 'graph-channel', nodeId: injected.nodeId } });
  };

  for (const target of graphPasses) {
    const config = project.passes[target];
    for (const channel of config.channels ?? []) {
      if (channel.type !== 'buffer' || !isBuffer(channel.src) || !slotValue(channel.index)) continue;
      append(target, {
        id: `legacy-${target}-${channel.index}-${channel.src}`,
        source: channel.src,
        target,
        slot: { mode: 'manual', index: channel.index },
        filter: channel.filter,
        wrap: channel.wrap,
        timing: target === 'image' ? 'current' : 'previous',
      }, channel.index);
    }
    if (target !== 'image' && config.feedback && !document.edges.some((edge) => edge.target === target && edge.source === target)) {
      const used = new Set(document.edges.flatMap((edge) => edge.target === target && edge.slot.mode === 'manual' ? [edge.slot.index] : []));
      const index = ([0, 1, 2, 3] as const).find((candidate) => !used.has(candidate));
      const feedbackSlot = index ?? 0;
      append(target, {
        id: `legacy-${target}-feedback`, source: target, target,
        slot: { mode: 'manual', index: feedbackSlot },
        filter: 'linear', wrap: 'repeat', timing: 'previous',
      }, feedbackSlot);
    }
  }
  return { passGraph: document, graphDocuments: migratedDocuments, migratedGraphPasses: [...migratedGraphPasses] };
}

/** Compatibility shorthand for Code-only callers. */
export function passGraphFromLegacy(
  project: ShaderlabProject,
  graphDocuments: Partial<Record<GraphPassId, GraphDocument>> = {},
): PassGraphDocument {
  return migratePassGraphFromLegacy(project, graphDocuments).passGraph;
}

/** Injects one stable sample node per existing input and atomically switches endpoints to Graph authoring. */
export function convertPassGraphTargetToGraph(
  document: PassGraphDocument,
  target: GraphPassId,
  graphDocument: GraphDocument,
): { passGraph: PassGraphDocument; graphDocument: GraphDocument } {
  let nextGraph = graphDocument;
  const edges = document.edges.map((edge, row) => {
    if (edge.target !== target) return edge;
    const injected = ensureChannelNode(nextGraph, target, `authoring:${edge.id}`, row);
    nextGraph = injected.document;
    return { ...edge, endpoint: { kind: 'graph-channel' as const, nodeId: injected.nodeId } };
  });
  return { passGraph: { ...document, edges }, graphDocument: nextGraph };
}

/** Uses the already-resolved physical slots so Graph→Code never changes a binding. */
export function convertPassGraphTargetToCode(
  document: PassGraphDocument,
  target: GraphPassId,
  resolved: ResolvedPassGraph | undefined,
): PassGraphDocument {
  const slots = new Map((resolved?.edges ?? []).filter((edge) => edge.target === target).map((edge) => [edge.id, edge.slot]));
  const incoming = document.edges.filter((edge) => edge.target === target);
  if (incoming.some((edge) => !slots.has(edge.id))) throw new ProductError({
    code: 'pass-graph.code-conversion-unresolved',
    params: { target },
    fallback: `${target} 的 Pass Graph 尚未成功解析，不能无损转为 Code`,
  });
  return {
    ...document,
    edges: document.edges.map((edge) => {
      if (edge.target !== target) return edge;
      const slot = slots.get(edge.id)!;
      return { ...edge, endpoint: { kind: 'code-slot' as const, slot }, slot: { mode: 'manual' as const, index: slot } };
    }),
  };
}

export interface PassGraphEndpointSelection {
  endpoint: PassGraphEndpoint;
  slot: PassGraphSlot;
}

/** Shared UI constructor: the target's current authoring always determines the union branch. */
export function endpointSelectionForTarget(
  document: PassGraphDocument,
  project: ShaderlabProject,
  graphDocuments: Partial<Record<GraphPassId, GraphDocument>>,
  target: VisualGraphPassId,
  preferredSlot = 0,
  excludeEdgeId?: string,
): PassGraphEndpointSelection | undefined {
  const otherEdges = document.edges.filter((edge) => edge.target === target && edge.id !== excludeEdgeId);
  if (project.passes[target].authoring?.kind === 'graph') {
    const used = new Set(otherEdges.flatMap((edge) => edge.endpoint.kind === 'graph-channel' ? [edge.endpoint.nodeId] : []));
    const node = [...(graphDocuments[target]?.nodes ?? [])]
      .filter((item) => item.type === 'input.channel-sample' && !used.has(item.id))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    return node ? { endpoint: { kind: 'graph-channel', nodeId: node.id }, slot: { mode: 'auto' } } : undefined;
  }
  const occupied = new Set(otherEdges.flatMap((edge) => edge.slot.mode === 'manual' ? [edge.slot.index] : []));
  const normalized = Math.max(0, Math.min(3, preferredSlot)) as 0 | 1 | 2 | 3;
  const slot = !occupied.has(normalized) ? normalized : ([0, 1, 2, 3] as const).find((candidate) => !occupied.has(candidate));
  return slot === undefined ? undefined : { endpoint: { kind: 'code-slot', slot }, slot: { mode: 'manual', index: slot } };
}

export function retargetPassGraphEdge(
  document: PassGraphDocument,
  edge: PassGraphEdge,
  target: VisualGraphPassId,
  project: ShaderlabProject,
  graphDocuments: Partial<Record<GraphPassId, GraphDocument>>,
): PassGraphEdge | undefined {
  const preferred = edge.slot.mode === 'manual' ? edge.slot.index : 0;
  const selection = endpointSelectionForTarget(document, project, graphDocuments, target, preferred, edge.id);
  return selection ? {
    ...edge,
    target,
    ...selection,
    timing: target === 'image' ? 'current' : edge.target === 'image' ? 'previous' : edge.timing,
  } : undefined;
}

export function endpointChangedForTarget(
  edge: PassGraphEdge,
  project: ShaderlabProject,
  value: string,
): PassGraphEdge {
  if (project.passes[edge.target].authoring?.kind === 'graph') {
    return { ...edge, endpoint: { kind: 'graph-channel', nodeId: value } };
  }
  const slot = Math.max(0, Math.min(3, Number(value))) as 0 | 1 | 2 | 3;
  return { ...edge, endpoint: { kind: 'code-slot', slot }, slot: { mode: 'manual', index: slot } };
}

export function legacyChannelsFromPassGraph(resolved: ResolvedPassGraph): Partial<Record<GraphPassId, PassChannelCfg[]>> {
  const result: Partial<Record<GraphPassId, PassChannelCfg[]>> = {};
  for (const edge of resolved.edges) {
    (result[edge.target] ??= []).push({ index: edge.slot, type: 'buffer', src: edge.source, filter: edge.filter, wrap: edge.wrap, timing: edge.timing });
  }
  return result;
}

/** Shadertoy has implicit timing: Buffer inputs are previous-frame and Image inputs are current-frame. */
export function shadertoyPassGraphIssue(resolved: ResolvedPassGraph): ProductMessageDescriptor | undefined {
  const edge = resolved.edges.find((item) => item.target === 'image' ? item.timing !== 'current' : item.timing !== 'previous');
  return edge
    ? {
        code: 'export.shadertoy-timing-unsupported',
        params: { source: edge.source, target: edge.target, timing: edge.timing },
        fallback: `Shadertoy 无法表示 ${edge.source} → ${edge.target} 的 ${edge.timing} timing`,
      }
    : undefined;
}

export function projectWithResolvedPassGraph(project: ShaderlabProject, resolved: ResolvedPassGraph): ShaderlabProject {
  const channels = legacyChannelsFromPassGraph(resolved);
  const passes = { ...project.passes };
  for (const pass of ['image', ...BUFFER_IDS] as GraphPassId[]) {
    const preserved = (passes[pass].channels ?? []).filter((channel) => channel.type !== 'buffer');
    passes[pass] = { ...passes[pass], channels: [...preserved, ...(channels[pass] ?? [])], feedback: undefined };
  }
  return { ...project, passes };
}
