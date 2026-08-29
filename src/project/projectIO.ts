import { ProductError, normalizeProductMessage, type ProductMessageParams } from '../productMessage';
import type { GraphPassId } from '../graph/model';
import type { CompileGraphOptions } from '../graph/compiler';
import { deterministicHash, stableStringify } from '../graph/compiler/hash';
import { createAssetManifest, normalizeAssetManifest, parseAssetManifest, resolveTextureEnvironment, serializeAssetManifest, type AssetManifest } from '../graph/assets';
import { accountProjectAssetBytes, assetContentHash } from '../graph/contentHash';
import { GRAPH_LIBRARY_VERSION, computeGraphLibraryRevision, createGraphLibrary, createProjectNodeRegistry, normalizeGraphLibrary, parseGraphLibrary, serializeGraphLibrary, type GraphLibraryDocument } from '../graph/library';
import { createGraphWorkspaceUi, normalizeGraphWorkspaceUi, parseGraphWorkspaceUi, serializeGraphWorkspaceUi, type GraphWorkspaceUiDocument } from '../graph/editor/workspaceState';
import {
  inspectPersistedGraph,
  isSafeProjectRelativePath,
  parseProjectGraph,
  validateGraphSave,
  type GraphProjectIssue,
  type ProjectGraphArtifacts,
  type ProjectGraphDocuments,
} from './graphIO';
import {
  BUFFER_IDS,
  type AutosaveGraphRecoveryState,
  type AutosavePayload,
  PASS_FILES,
  PROJECT_CONFIG_FILE,
  type ProjectSources,
  type ShaderlabProject,
  createProject,
  joinPath,
  serializeProject,
  sourcesWithDefaults,
} from './types';
import { parseProject } from './migrations';
import {
  createPassGraphDocument,
  legacyChannelsFromPassGraph,
  migratePassGraphFromLegacy,
  parsePassGraph,
  passGraphFromLegacy,
  passGraphReferenceIssues,
  projectWithPassGraphIdentity,
  resolvePassGraph,
  serializePassGraph,
  type PassGraphDocument,
  type ResolvedPassGraph,
} from './passGraph';
import { createDir, readBinaryFile, readTextFile, writeFilesAtomic, writeTextFilesAtomic, type AtomicFile } from './bridge';

export interface SessionState {
  cleanExit: boolean;
  projectDir: string | null;
  projectName: string;
  autosavePath?: string;
  autosaveAt?: number;
}

const SESSION_KEY = 'slp.session';
const SCRATCH_AUTOSAVE_KEY = 'slp.scratchAutosave';
const AUTOSAVE_DIR = '.shaderlab';
const AUTOSAVE_SUB = 'autosave';
const AUTOSAVE_VERSIONS = 5;
const GRAPH_PASS_IDS: GraphPassId[] = ['image', ...BUFFER_IDS, 'sound'];

export interface SaveProjectOptions {
  graphDocuments?: ProjectGraphDocuments;
  graphArtifacts?: ProjectGraphArtifacts;
  graphCompileOptions?: Partial<Record<GraphPassId, CompileGraphOptions>>;
  passGraph?: PassGraphDocument;
  assetManifest?: AssetManifest;
  /** Base64 payloads keyed by stable asset ID. Metadata is committed only after these copies succeed. */
  assetPayloads?: Readonly<Record<string, string>>;
  graphLibrary?: GraphLibraryDocument;
  graphWorkspace?: GraphWorkspaceUiDocument;
}

export function readSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionState) : null;
  } catch {
    return null;
  }
}

export function writeSession(s: SessionState): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    localStorage.removeItem(SESSION_KEY);
  }
}

function addAtomicFile(files: AtomicFile[], path: string, contents: string): void {
  if (files.some((file) => file.path === path)) throw new ProductError({ code: 'project.duplicate-target', params: { path }, fallback: `项目包含重复写入目标：${path}` });
  files.push({ kind: 'text', path, contents });
}

/** Graph/GLSL and other passes are staged first; shaderlab.json is the final commit marker. */
export async function saveProjectTo(
  dir: string,
  meta: ShaderlabProject,
  sources: ProjectSources,
  options: SaveProjectOptions = {},
): Promise<ShaderlabProject> {
  const now = new Date().toISOString();
  let full = parseProject(serializeProject({
    ...meta,
    modified: now,
    created: meta.created || now,
  }));
  const assetManifest = normalizeAssetManifest(options.assetManifest ?? createAssetManifest());
  const graphLibrary = normalizeGraphLibrary(options.graphLibrary ?? createGraphLibrary());
  const graphWorkspace = normalizeGraphWorkspaceUi(options.graphWorkspace ?? createGraphWorkspaceUi());
  const assetRevision = deterministicHash(stableStringify(assetManifest));
  const libraryRevision = computeGraphLibraryRevision(graphLibrary);
  full = parseProject(serializeProject({
    ...full,
    assetManifest: { file: full.assetManifest?.file ?? 'assets/manifest.json', formatVersion: assetManifest.version, revision: assetRevision },
    graphLibrary: { file: full.graphLibrary?.file ?? 'graphs/library.json', formatVersion: graphLibrary.version, revision: libraryRevision },
    graphWorkspace: { file: full.graphWorkspace?.file ?? 'graphs/workspace.json', formatVersion: graphWorkspace.version },
  }));
  const passGraph = options.passGraph ?? passGraphFromLegacy(full);
  const passGraphResolution = resolvePassGraph(passGraph, full, options.graphDocuments);
  if (!passGraphResolution.ok || !passGraphResolution.resolved) {
    const diagnostic = passGraphResolution.diagnostics[0];
    throw new ProductError({
      code: diagnostic?.code ?? 'project.pass-graph-invalid',
      ...(diagnostic?.params ? { params: diagnostic.params } : { params: { count: passGraphResolution.diagnostics.length } }),
      ...(diagnostic?.rawDetail !== undefined ? { rawDetail: diagnostic.rawDetail } : {}),
      fallback: diagnostic?.message ?? '项目 Pass Graph 无效',
    }, { cause: passGraphResolution.diagnostics });
  }
  const legacyChannels = legacyChannelsFromPassGraph(passGraphResolution.resolved);
  full = projectWithPassGraphIdentity({
    ...full,
    passes: Object.fromEntries(Object.entries(full.passes).map(([id, config]) => {
      if (id === 'common' || id === 'sound') return [id, { ...config, feedback: undefined }];
      const preserved = (config.channels ?? []).filter((channel) => channel.type !== 'buffer');
      return [id, { ...config, channels: [...preserved, ...(legacyChannels[id as GraphPassId] ?? [])], feedback: undefined }];
    })) as ShaderlabProject['passes'],
  }, passGraph, passGraphResolution.resolved);
  const validatedGraphs = new Map<GraphPassId, ReturnType<typeof validateGraphSave>>();

  for (const pass of GRAPH_PASS_IDS) {
    const authoring = full.passes[pass].authoring;
    if (authoring?.kind !== 'graph') continue;
    if (!isSafeProjectRelativePath(authoring.graphFile)) {
      throw new ProductError({ code: 'project.unsafe-path', params: { path: authoring.graphFile }, fallback: `Graph Pass ${pass} 的 graphFile 不是安全相对路径` });
    }
    const validated = validateGraphSave(
      pass,
      options.graphDocuments?.[pass],
      options.graphArtifacts?.[pass],
      {
        ...(options.graphCompileOptions?.[pass] ?? {}),
        ...(pass !== 'sound' && (options.passGraph || options.graphDocuments?.[pass]?.nodes.some((node) => node.type === 'input.channel-sample')) ? {
          channelEnvironment: passGraphResolution.resolved.channelEnvironment[pass],
          channelEnvironmentRevision: passGraphResolution.resolved.revision,
        } : {}),
        libraryRevision,
      },
    );
    validatedGraphs.set(pass, validated);
    full = {
      ...full,
      passes: {
        ...full.passes,
        [pass]: {
          ...full.passes[pass],
          authoring: {
            kind: 'graph',
            graphFile: authoring.graphFile,
            graphFormatVersion: validated.document.version,
            generatedHash: validated.artifact.sourceHash,
          },
        },
      },
    };
  }
  full = parseProject(serializeProject(full));

  await createDir(dir);
  await createDir(joinPath(dir, 'passes'));
  await createDir(joinPath(dir, 'graphs'));
  await createDir(joinPath(dir, 'assets'));
  await createDir(joinPath(dir, 'exports'));
  await createDir(joinPath(dir, AUTOSAVE_DIR));

  const files: AtomicFile[] = [];
  if (!full.passGraph || !isSafeProjectRelativePath(full.passGraph.file)) throw new ProductError({ code: 'project.unsafe-path', params: { path: full.passGraph?.file ?? 'passGraph' }, fallback: 'Pass Graph 路径不安全' });
  if (!full.assetManifest || !isSafeProjectRelativePath(full.assetManifest.file)) throw new ProductError({ code: 'project.unsafe-path', params: { path: full.assetManifest?.file ?? 'assetManifest' }, fallback: 'Asset Manifest 路径不安全' });
  if (!full.graphLibrary || !isSafeProjectRelativePath(full.graphLibrary.file)) throw new ProductError({ code: 'project.unsafe-path', params: { path: full.graphLibrary?.file ?? 'graphLibrary' }, fallback: 'Graph Library 路径不安全' });
  if (!full.graphWorkspace || !isSafeProjectRelativePath(full.graphWorkspace.file)) throw new ProductError({ code: 'project.unsafe-path', params: { path: full.graphWorkspace?.file ?? 'graphWorkspace' }, fallback: 'Graph Workspace 路径不安全' });
  addAtomicFile(files, joinPath(dir, full.passGraph.file), serializePassGraph(passGraph));
  addAtomicFile(files, joinPath(dir, full.assetManifest.file), serializeAssetManifest(assetManifest));
  addAtomicFile(files, joinPath(dir, full.graphLibrary.file), serializeGraphLibrary(graphLibrary));
  addAtomicFile(files, joinPath(dir, full.graphWorkspace.file), serializeGraphWorkspaceUi(graphWorkspace));
  for (const pass of GRAPH_PASS_IDS) {
    const graph = validatedGraphs.get(pass);
    if (!graph) continue;
    const config = full.passes[pass];
    const authoring = config.authoring;
    if (authoring?.kind !== 'graph') throw new ProductError({ code: 'project.graph-metadata-missing', params: { pass }, fallback: `Graph Pass ${pass} 元数据丢失` });
    addAtomicFile(files, joinPath(dir, authoring.graphFile), graph.serializedDocument);
    addAtomicFile(files, joinPath(dir, config.file ?? PASS_FILES[pass]), graph.artifact.source);
  }

  if (!validatedGraphs.has('image')) {
    addAtomicFile(files, joinPath(dir, full.passes.image.file ?? PASS_FILES.image), sources.image);
  }
  addAtomicFile(files, joinPath(dir, full.passes.common.file ?? PASS_FILES.common), sources.common);
  for (const buffer of BUFFER_IDS) {
    if (validatedGraphs.has(buffer)) continue;
    const config = full.passes[buffer];
    if (!config.enabled) continue;
    addAtomicFile(files, joinPath(dir, config.file ?? PASS_FILES[buffer]), sources[buffer] ?? '');
  }
  const sound = full.passes.sound;
  if (sound.enabled && !validatedGraphs.has('sound')) {
    addAtomicFile(files, joinPath(dir, sound.file ?? PASS_FILES.sound), sources.sound ?? '');
  }
  let totalAssetBytes = 0;
  for (const asset of assetManifest.assets) {
    const payload = options.assetPayloads?.[asset.id];
    if (payload === undefined) throw new ProductError({ code: 'project.asset-payload-missing', params: { asset: asset.id }, fallback: `纹理资产 ${asset.id} 缺少待保存二进制数据` });
    totalAssetBytes = accountProjectAssetBytes(totalAssetBytes, payload);
    if (assetContentHash(payload) !== asset.contentHash) throw new ProductError({ code: 'project.asset-hash-mismatch', params: { asset: asset.id }, fallback: `纹理资产 ${asset.id} contentHash 与二进制不一致` });
    files.push({ kind: 'binary', path: joinPath(dir, asset.file), dataBase64: payload });
  }
  addAtomicFile(files, joinPath(dir, PROJECT_CONFIG_FILE), serializeProject(full));
  await writeFilesAtomic(files);
  return full;
}

export interface OpenedProject {
  dir: string;
  meta: ShaderlabProject;
  sources: ProjectSources;
  graphDocuments: ProjectGraphDocuments;
  assetManifest: AssetManifest;
  assetPayloads: Record<string, string>;
  graphLibrary: GraphLibraryDocument;
  graphWorkspace: GraphWorkspaceUiDocument;
  passGraph: PassGraphDocument;
  resolvedPassGraph?: ResolvedPassGraph;
  passGraphIdentityValid: boolean;
  graphIssues: GraphProjectIssue[];
  needsResave: boolean;
}

async function readOptionalSource(dir: string, path: string): Promise<string> {
  try {
    return await readTextFile(joinPath(dir, path));
  } catch {
    return '';
  }
}

export async function openProjectFrom(dir: string): Promise<OpenedProject> {
  let configText: string;
  try {
    configText = await readTextFile(joinPath(dir, PROJECT_CONFIG_FILE));
  } catch (error) {
    throw new ProductError({
      code: 'project.config-missing',
      fallback: '所选文件夹不是有效的 ShaderLab 项目（缺少 shaderlab.json）',
      rawDetail: normalizeProductMessage(error).rawDetail ?? normalizeProductMessage(error).fallback,
    });
  }
  const meta = parseProject(configText);
  const imageFile = meta.passes.image.file ?? PASS_FILES.image;
  const commonFile = meta.passes.common.file ?? PASS_FILES.common;
  const sources: ProjectSources = { image: '', common: '' };
  try {
    sources.image = await readTextFile(joinPath(dir, imageFile));
  } catch (error) {
    throw new ProductError({
      code: 'project.main-pass-missing',
      params: { path: imageFile },
      fallback: `读取主 Pass 失败：${imageFile} 不存在`,
      rawDetail: normalizeProductMessage(error).rawDetail ?? normalizeProductMessage(error).fallback,
    });
  }
  sources.common = await readOptionalSource(dir, commonFile);
  for (const buffer of BUFFER_IDS) {
    const config = meta.passes[buffer];
    if (!config.enabled && config.authoring?.kind !== 'graph') continue;
    sources[buffer] = await readOptionalSource(dir, config.file ?? PASS_FILES[buffer]);
  }
  const sound = meta.passes.sound;
  if (sound.enabled) sources.sound = await readOptionalSource(dir, sound.file ?? PASS_FILES.sound);

  const assetManifest = meta.assetManifest
    ? parseAssetManifest(await readTextFile(joinPath(dir, meta.assetManifest.file)))
    : createAssetManifest();
  let graphLibraryStoredVersion: number | undefined;
  let graphLibraryStoredRevision: string | undefined;
  let graphLibrary: GraphLibraryDocument;
  if (meta.graphLibrary) {
    const text = await readTextFile(joinPath(dir, meta.graphLibrary.file));
    const raw = JSON.parse(text) as unknown;
    graphLibraryStoredVersion = isRecord(raw) && Number.isInteger(raw.version) ? Number(raw.version) : undefined;
    graphLibraryStoredRevision = deterministicHash(stableStringify(raw));
    graphLibrary = parseGraphLibrary(text);
  } else graphLibrary = createGraphLibrary();
  let graphWorkspaceMissing = false;
  let graphWorkspace = createGraphWorkspaceUi();
  if (meta.graphWorkspace) {
    try { graphWorkspace = parseGraphWorkspaceUi(await readTextFile(joinPath(dir, meta.graphWorkspace.file))); }
    catch { graphWorkspaceMissing = true; }
  }
  if (meta.assetManifest && (meta.assetManifest.formatVersion !== assetManifest.version || (meta.assetManifest.revision && meta.assetManifest.revision !== deterministicHash(stableStringify(assetManifest))))) {
    throw new ProductError({ code: 'project.identity-mismatch', params: { resource: 'Asset Manifest' }, fallback: 'Asset Manifest reference identity 不匹配' });
  }
  const graphLibraryMigrated = !!meta.graphLibrary && meta.graphLibrary.formatVersion === 1 && graphLibraryStoredVersion === 1 && graphLibrary.version === GRAPH_LIBRARY_VERSION;
  if (meta.graphLibrary) {
    const referenceRevision = graphLibraryMigrated ? graphLibraryStoredRevision : computeGraphLibraryRevision(graphLibrary);
    if ((!graphLibraryMigrated && meta.graphLibrary.formatVersion !== graphLibrary.version) || (meta.graphLibrary.revision && meta.graphLibrary.revision !== referenceRevision)) {
      throw new ProductError({ code: 'project.identity-mismatch', params: { resource: 'Graph Library' }, fallback: 'Graph Library reference identity 不匹配' });
    }
  }
  if (meta.graphWorkspace && !graphWorkspaceMissing && meta.graphWorkspace.formatVersion !== graphWorkspace.version) {
    throw new ProductError({ code: 'project.identity-mismatch', params: { resource: 'Graph Workspace' }, fallback: 'Graph Workspace reference version 不匹配' });
  }
  const assetPayloads: Record<string, string> = {};
  let totalAssetBytes = 0;
  for (const asset of assetManifest.assets) {
    const payload = await readBinaryFile(joinPath(dir, asset.file));
    totalAssetBytes = accountProjectAssetBytes(totalAssetBytes, payload);
    if (assetContentHash(payload) !== asset.contentHash) throw new ProductError({ code: 'project.asset-hash-mismatch', params: { asset: asset.id }, fallback: `纹理资产 ${asset.id} contentHash 校验失败` });
    assetPayloads[asset.id] = payload;
  }

  const graphDocuments: ProjectGraphDocuments = {};
  const graphIssues: GraphProjectIssue[] = [];
  for (const pass of GRAPH_PASS_IDS) {
    const authoring = meta.passes[pass].authoring;
    if (authoring?.kind !== 'graph') continue;
    if (!isSafeProjectRelativePath(authoring.graphFile)) {
      graphIssues.push({
        pass,
        severity: 'error',
        code: 'graph.unsafe-path',
        message: `Graph 路径不安全：${authoring.graphFile}`,
        params: { path: authoring.graphFile },
      });
      continue;
    }
    let graphText: string;
    try {
      graphText = await readTextFile(joinPath(dir, authoring.graphFile));
    } catch (error) {
      const descriptor = normalizeProductMessage(error, 'bridge.read-text-failed');
      graphIssues.push({
        pass,
        severity: 'error',
        code: 'graph.missing',
        message: `Graph 文件缺失：${authoring.graphFile}；已使用持久化 GLSL 只读恢复`,
        params: { path: authoring.graphFile },
        ...(descriptor.rawDetail !== undefined ? { rawDetail: descriptor.rawDetail } : {}),
      });
      continue;
    }
    const parsed = parseProjectGraph(graphText, pass);
    graphIssues.push(...parsed.issues);
    if (!parsed.document) continue;
    graphDocuments[pass] = parsed.document;
  }

  let passGraph: PassGraphDocument;
  let passGraphLoaded = true;
  const hasPassGraphReference = !!meta.passGraph;
  if (meta.passGraph) {
    try {
      if (!isSafeProjectRelativePath(meta.passGraph.file)) throw new ProductError({ code: 'project.unsafe-path', params: { path: meta.passGraph.file }, fallback: 'Pass Graph 路径不安全' });
      passGraph = parsePassGraph(await readTextFile(joinPath(dir, meta.passGraph.file)));
    } catch (error) {
      passGraphLoaded = false;
      passGraph = createPassGraphDocument();
      graphIssues.push({
        pass: 'image', severity: 'error', code: error instanceof ProductError ? error.code : 'pass-graph.load-failed', stage: 'graph-schema',
        message: error instanceof ProductError ? error.fallback ?? error.code : '项目 Pass Graph 无法加载',
        ...(error instanceof ProductError && error.params ? { params: error.params } : {}),
        ...(error instanceof ProductError && error.rawDetail ? { rawDetail: error.rawDetail } : !(error instanceof ProductError) ? { rawDetail: error instanceof Error ? error.message : String(error) } : {}),
      });
    }
  } else {
    const migration = migratePassGraphFromLegacy(meta, graphDocuments);
    passGraph = migration.passGraph;
    Object.assign(graphDocuments, migration.graphDocuments);
  }
  const passGraphResolution = resolvePassGraph(passGraph, meta, graphDocuments);
  const identityIssues = hasPassGraphReference
    ? passGraphReferenceIssues(meta.passGraph, passGraph, passGraphResolution.resolved)
    : [];
  graphIssues.push(...identityIssues.map((item) => ({
    pass: 'image' as const,
    severity: 'error' as const,
    code: item.code,
    stage: 'graph-schema' as const,
    message: item.message,
    ...(item.params ? { params: item.params } : {}),
    ...(item.rawDetail !== undefined ? { rawDetail: item.rawDetail } : {}),
  })));
  const passGraphIdentityValid = passGraphLoaded && identityIssues.length === 0;
  graphIssues.push(...passGraphResolution.diagnostics.map((item) => ({
    pass: item.origin.pass as GraphPassId,
    severity: item.severity === 'error' ? 'error' as const : 'warning' as const,
    code: item.code ?? 'pass-graph.invalid',
    message: item.message,
    stage: item.stage,
    ...(item.params ? { params: item.params } : {}),
    ...(item.rawDetail !== undefined ? { rawDetail: item.rawDetail } : {}),
    origin: item.origin,
    ...(item.relatedOrigins ? { relatedOrigins: item.relatedOrigins } : {}),
  })));
  const registry = createProjectNodeRegistry(graphLibrary);
  const libraryRevision = computeGraphLibraryRevision(graphLibrary);
  for (const pass of GRAPH_PASS_IDS) {
    const document = graphDocuments[pass];
    const authoring = meta.passes[pass].authoring;
    if (!document || authoring?.kind !== 'graph') continue;
    const fallback = sources[pass] ?? '';
    try {
      const occupied = pass === 'sound' ? [] : (passGraphResolution.resolved?.edges.filter((edge) => edge.target === pass).map((edge) => edge.slot) ?? []);
      const textures = resolveTextureEnvironment(document, assetManifest, occupied);
      graphIssues.push(...inspectPersistedGraph(
        pass, document, authoring.graphFormatVersion, authoring.generatedHash, fallback,
        {
          registry,
          libraryRevision,
          channelEnvironment: passGraphResolution.resolved?.channelEnvironment[pass],
          channelEnvironmentRevision: pass === 'sound' ? undefined : passGraphResolution.resolved?.revision,
          textureEnvironment: textures.bindings,
          textureEnvironmentRevision: textures.revision,
        },
      ));
    } catch (error) {
      graphIssues.push({
        pass,
        severity: 'error',
        code: 'asset.binding-invalid',
        stage: 'graph-validate',
        message: 'Graph 纹理资产绑定无效',
        rawDetail: normalizeProductMessage(error).rawDetail ?? normalizeProductMessage(error).fallback,
      });
    }
  }

  return {
    dir,
    meta,
    sources: sourcesWithDefaults(sources),
    graphDocuments,
    assetManifest,
    assetPayloads,
    graphLibrary,
    graphWorkspace,
    passGraph,
    resolvedPassGraph: passGraphResolution.resolved,
    passGraphIdentityValid,
    graphIssues,
    needsResave: !hasPassGraphReference || !meta.assetManifest || !meta.graphLibrary || graphLibraryMigrated || !meta.graphWorkspace || graphWorkspaceMissing || graphIssues.length > 0,
  };
}

function autosaveRotationIndex(storageKey: string): number {
  try {
    const value = Number(localStorage.getItem(storageKey) ?? '-1');
    return Number.isFinite(value) ? value : -1;
  } catch {
    return -1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedMessageParams(value: unknown): ProductMessageParams | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string | number] => (
    typeof entry[1] === 'string' || typeof entry[1] === 'number'
  ));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

const RECOVERY_REASONS = new Set(['identity-mismatch', 'compiler-invalid', 'runtime-rejected']);
const DIAGNOSTIC_SEVERITIES = new Set(['error', 'warning', 'info']);
const DIAGNOSTIC_STAGES = new Set(['graph-schema', 'graph-validate', 'graph-typecheck', 'glsl-compile', 'runtime']);

/** Autosave recovery metadata is untrusted input; retain only the graph-local diagnostic shape the App consumes. */
function normalizeGraphRecoveryState(value: unknown): AutosaveGraphRecoveryState | undefined {
  if (!isRecord(value)) return undefined;
  const rawReasons = isRecord(value.reasons) ? value.reasons : {};
  const rawDiagnostics = isRecord(value.diagnostics) ? value.diagnostics : {};
  const reasons: NonNullable<AutosaveGraphRecoveryState['reasons']> = {};
  const diagnostics: NonNullable<AutosaveGraphRecoveryState['diagnostics']> = {};

  for (const pass of GRAPH_PASS_IDS) {
    const reason = rawReasons[pass];
    if (typeof reason === 'string' && RECOVERY_REASONS.has(reason)) {
      reasons[pass] = reason as NonNullable<AutosaveGraphRecoveryState['reasons']>[GraphPassId];
    }
    const items = rawDiagnostics[pass];
    if (!Array.isArray(items)) continue;
    const normalized = items.flatMap((item) => {
      if (!isRecord(item) || typeof item.message !== 'string') return [];
      if (typeof item.severity !== 'string' || !DIAGNOSTIC_SEVERITIES.has(item.severity)) return [];
      if (typeof item.stage !== 'string' || !DIAGNOSTIC_STAGES.has(item.stage)) return [];
      const rawOrigin = isRecord(item.origin) ? item.origin : {};
      const origin = {
        kind: 'graph' as const,
        pass,
        ...(typeof rawOrigin.nodeId === 'string' ? { nodeId: rawOrigin.nodeId } : {}),
        ...(typeof rawOrigin.socketId === 'string' ? { socketId: rawOrigin.socketId } : {}),
        ...(typeof rawOrigin.edgeId === 'string' ? { edgeId: rawOrigin.edgeId } : {}),
        ...(typeof rawOrigin.parameterId === 'string' ? { parameterId: rawOrigin.parameterId } : {}),
      };
      const params = normalizedMessageParams(item.params);
      return [{
        message: item.message,
        severity: item.severity as 'error' | 'warning' | 'info',
        stage: item.stage as 'graph-schema' | 'graph-validate' | 'graph-typecheck' | 'glsl-compile' | 'runtime',
        ...(typeof item.code === 'string' ? { code: item.code } : {}),
        ...(params ? { params } : {}),
        ...(typeof item.rawDetail === 'string' ? { rawDetail: item.rawDetail } : {}),
        origin,
      }];
    });
    if (normalized.length) diagnostics[pass] = normalized;
  }

  if (!Object.keys(reasons).length && !Object.keys(diagnostics).length) return undefined;
  return {
    ...(Object.keys(reasons).length ? { reasons } : {}),
    ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
  };
}

/** Converts both legacy source-only snapshots and V2 snapshots to the current shape. */
export function normalizeAutosavePayload(value: unknown): AutosavePayload | null {
  if (!isRecord(value) || !isRecord(value.sources)) return null;
  const payloadVersion = value.version === undefined ? 1 : Number(value.version);
  if (!Number.isInteger(payloadVersion) || payloadVersion < 1 || payloadVersion > 2) return null;
  const savedAt = Number(value.savedAt);
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null;
  const name = typeof value.name === 'string' ? value.name : '未命名项目';
  const hasMeta = isRecord(value.meta);
  let meta: ShaderlabProject;
  try {
    meta = hasMeta ? parseProject(JSON.stringify(value.meta)) : createProject(name);
  } catch {
    return null;
  }
  meta = {
    ...meta,
    name: name || meta.name,
    uniforms: Array.isArray(value.uniforms) ? value.uniforms : meta.uniforms,
  };
  const graphRecovery = normalizeGraphRecoveryState(value.graphRecovery);
  let assetManifest: AssetManifest | undefined;
  let graphLibrary: GraphLibraryDocument | undefined;
  let graphWorkspace: GraphWorkspaceUiDocument | undefined;
  const assetPayloads: Record<string, string> = {};
  try {
    if (value.assetManifest !== undefined) assetManifest = normalizeAssetManifest(value.assetManifest);
    if (value.graphLibrary !== undefined) graphLibrary = normalizeGraphLibrary(value.graphLibrary);
    if (value.graphWorkspace !== undefined) graphWorkspace = normalizeGraphWorkspaceUi(value.graphWorkspace);
    if (assetManifest) {
      const reference = meta.assetManifest;
      const revision = deterministicHash(stableStringify(assetManifest));
      if (reference && (reference.formatVersion !== assetManifest.version || (reference.revision && reference.revision !== revision))) return null;
      const rawPayloads = isRecord(value.assetPayloads) ? value.assetPayloads : {};
      let totalAssetBytes = 0;
      for (const asset of assetManifest.assets) {
        const payload = rawPayloads[asset.id];
        if (typeof payload !== 'string') return null;
        totalAssetBytes = accountProjectAssetBytes(totalAssetBytes, payload);
        if (assetContentHash(payload) !== asset.contentHash) return null;
        assetPayloads[asset.id] = payload;
      }
    }
    if (graphLibrary) {
      const reference = meta.graphLibrary;
      const rawLibrary = isRecord(value.graphLibrary) ? value.graphLibrary : undefined;
      const migrated = reference?.formatVersion === 1 && rawLibrary?.version === 1 && graphLibrary.version === GRAPH_LIBRARY_VERSION;
      const revision = migrated ? deterministicHash(stableStringify(rawLibrary)) : computeGraphLibraryRevision(graphLibrary);
      if (reference && ((!migrated && reference.formatVersion !== graphLibrary.version) || (reference.revision && reference.revision !== revision))) return null;
    }
    if (graphWorkspace) {
      const reference = meta.graphWorkspace;
      if (reference && reference.formatVersion !== graphWorkspace.version) return null;
    }
  } catch { return null; }
  return {
    version: 2,
    savedAt,
    name: meta.name || name,
    meta,
    sources: sourcesWithDefaults(value.sources as Partial<ProjectSources>),
    uniforms: Array.isArray(value.uniforms) ? value.uniforms : meta.uniforms,
    ...(isRecord(value.graphDocuments) ? { graphDocuments: value.graphDocuments } : {}),
    ...(value.passGraph !== undefined ? { passGraph: value.passGraph } : {}),
    ...(graphRecovery ? { graphRecovery } : {}),
    ...(assetManifest ? { assetManifest, assetPayloads } : {}),
    ...(graphLibrary ? { graphLibrary } : {}),
    ...(graphWorkspace ? { graphWorkspace } : {}),
    ...(!hasMeta ? { legacy: true } : {}),
  };
}

/** Selects by payload timestamp, independently of ring-buffer file numbering. */
export function selectLatestAutosavePayload(values: unknown[]): AutosavePayload | null {
  let latest: AutosavePayload | null = null;
  for (const value of values) {
    const payload = normalizeAutosavePayload(value);
    if (payload && (!latest || payload.savedAt > latest.savedAt)) latest = payload;
  }
  return latest;
}

export async function writeAutosave(
  projectDir: string | null,
  meta: ShaderlabProject,
  sources: ProjectSources,
  uniforms: unknown[] = [],
  graphDocuments?: Record<string, unknown>,
  passGraph?: PassGraphDocument,
  graphRecovery?: unknown,
  resources?: { assetManifest: AssetManifest; assetPayloads: Readonly<Record<string, string>>; graphLibrary: GraphLibraryDocument; graphWorkspace?: GraphWorkspaceUiDocument },
): Promise<{ path: string; savedAt: number }> {
  let normalizedMeta = parseProject(serializeProject({ ...meta, uniforms }));
  if (passGraph) {
    const resolution = resolvePassGraph(
      passGraph,
      normalizedMeta,
      (graphDocuments ?? {}) as ProjectGraphDocuments,
    );
    if (!resolution.ok || !resolution.resolved) {
      const diagnostic = resolution.diagnostics[0];
      throw new ProductError({
        code: diagnostic?.code ?? 'project.autosave-invalid',
        ...(diagnostic?.params ? { params: diagnostic.params } : {}),
        ...(diagnostic?.rawDetail !== undefined ? { rawDetail: diagnostic.rawDetail } : {}),
        fallback: diagnostic?.message ?? 'Autosave Pass Graph 无效',
      }, { cause: resolution.diagnostics });
    }
    normalizedMeta = projectWithPassGraphIdentity(normalizedMeta, passGraph, resolution.resolved);
  }
  const normalizedGraphRecovery = normalizeGraphRecoveryState(graphRecovery);
  const normalizedAssets = resources ? normalizeAssetManifest(resources.assetManifest) : undefined;
  const normalizedLibrary = resources ? normalizeGraphLibrary(resources.graphLibrary) : undefined;
  const normalizedWorkspace = resources?.graphWorkspace ? normalizeGraphWorkspaceUi(resources.graphWorkspace) : undefined;
  if (normalizedAssets && normalizedLibrary) {
    normalizedMeta = parseProject(serializeProject({
      ...normalizedMeta,
      assetManifest: {
        file: normalizedMeta.assetManifest?.file ?? 'assets/manifest.json',
        formatVersion: normalizedAssets.version,
        revision: deterministicHash(stableStringify(normalizedAssets)),
      },
      graphLibrary: {
        file: normalizedMeta.graphLibrary?.file ?? 'graphs/library.json',
        formatVersion: normalizedLibrary.version,
        revision: computeGraphLibraryRevision(normalizedLibrary),
      },
      ...(normalizedWorkspace ? {
        graphWorkspace: {
          file: normalizedMeta.graphWorkspace?.file ?? 'graphs/workspace.json',
          formatVersion: normalizedWorkspace.version,
        },
      } : {}),
    }));
  }
  const normalizedPayloads: Record<string, string> = {};
  let totalAssetBytes = 0;
  for (const asset of normalizedAssets?.assets ?? []) {
    const payload = resources?.assetPayloads[asset.id];
    if (!payload) throw new ProductError({
      code: 'project.autosave-invalid',
      params: { asset: asset.id },
      fallback: `Autosave 纹理 ${asset.id} payload 无效`,
    });
    totalAssetBytes = accountProjectAssetBytes(totalAssetBytes, payload);
    if (assetContentHash(payload) !== asset.contentHash) throw new ProductError({
      code: 'project.autosave-invalid',
      params: { asset: asset.id },
      fallback: `Autosave 纹理 ${asset.id} payload hash 不匹配`,
    });
    normalizedPayloads[asset.id] = payload;
  }
  const payload: AutosavePayload = {
    version: 2,
    savedAt: Date.now(),
    name: normalizedMeta.name,
    meta: normalizedMeta,
    sources: sourcesWithDefaults(sources),
    uniforms,
    ...(graphDocuments ? { graphDocuments } : {}),
    ...(passGraph ? { passGraph } : {}),
    ...(normalizedGraphRecovery ? { graphRecovery: normalizedGraphRecovery } : {}),
    ...(normalizedAssets ? { assetManifest: normalizedAssets, assetPayloads: normalizedPayloads } : {}),
    ...(normalizedLibrary ? { graphLibrary: normalizedLibrary } : {}),
    ...(normalizedWorkspace ? { graphWorkspace: normalizedWorkspace } : {}),
  };
  const text = JSON.stringify(payload);
  if (projectDir) {
    const storageKey = `slp.ac.${projectDir}`;
    const next = (autosaveRotationIndex(storageKey) + 1) % AUTOSAVE_VERSIONS;
    const autosaveDir = joinPath(projectDir, AUTOSAVE_DIR, AUTOSAVE_SUB);
    await createDir(autosaveDir);
    const path = joinPath(autosaveDir, `auto_0${next}.json`);
    await writeTextFilesAtomic([{ path, contents: text }]);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // The file is already safely written; rotation metadata is only an optimization.
    }
    return { path, savedAt: payload.savedAt };
  }
  localStorage.setItem(SCRATCH_AUTOSAVE_KEY, text);
  return { path: '', savedAt: payload.savedAt };
}

export async function readLatestAutosave(projectDir: string | null): Promise<AutosavePayload | null> {
  if (projectDir) {
    const candidates: unknown[] = [];
    for (let index = 0; index < AUTOSAVE_VERSIONS; index++) {
      try {
        const raw = await readTextFile(joinPath(projectDir, AUTOSAVE_DIR, AUTOSAVE_SUB, `auto_0${index}.json`));
        candidates.push(JSON.parse(raw));
      } catch {
        // Missing or corrupt rotation entries do not invalidate other snapshots.
      }
    }
    return selectLatestAutosavePayload(candidates);
  }
  try {
    const raw = localStorage.getItem(SCRATCH_AUTOSAVE_KEY);
    return raw ? normalizeAutosavePayload(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearScratchAutosave(): void {
  try {
    localStorage.removeItem(SCRATCH_AUTOSAVE_KEY);
  } catch {
    return;
  }
}
