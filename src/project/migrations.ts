import {
  BUFFER_IDS,
  CURRENT_PROJECT_VERSION,
  PASS_FILES,
  createProject,
  type PassAuthoring,
  type PassChannelCfg,
  type PassConfig,
  type PassId,
  type PassGraphReference,
  type ShaderlabProject,
} from './types';

const PASS_IDS: PassId[] = ['common', 'image', ...BUFFER_IDS, 'sound'];
const CHANNEL_TYPES = new Set<PassChannelCfg['type']>(['texture', 'buffer', 'keyboard', 'volume']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function projectVersionParts(version: string): [number, number] {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(version.trim());
  if (!match) throw new Error(`不支持的项目版本格式：${version}`);
  return [Number(match[1]), Number(match[2] ?? 0)];
}

function majorVersion(version: string): number {
  return projectVersionParts(version)[0];
}

function normalizeRelativePath(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const path = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return fallback;
  if (path.split('/').some((part) => part === '..' || part === '')) return fallback;
  return path;
}

function normalizeAuthoring(id: PassId, value: unknown): PassAuthoring {
  if (!isRecord(value) || value.kind !== 'graph') return { kind: 'code' };
  if (id === 'common') {
    throw new Error(`${id} Pass 仅支持 Code authoring`);
  }
  const graphFile = normalizeRelativePath(value.graphFile, '');
  const graphFormatVersion = Number(value.graphFormatVersion);
  if (!graphFile || !Number.isInteger(graphFormatVersion) || graphFormatVersion < 1) {
    throw new Error('无效的 Graph authoring 配置：缺少 graphFile 或 graphFormatVersion');
  }
  return {
    kind: 'graph',
    graphFile,
    graphFormatVersion,
    ...(typeof value.generatedHash === 'string' && value.generatedHash
      ? { generatedHash: value.generatedHash }
      : {}),
  };
}

function normalizeChannels(id: PassId, value: unknown): PassChannelCfg[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const channels: PassChannelCfg[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0 || index > 3) continue;
    const type = CHANNEL_TYPES.has(raw.type as PassChannelCfg['type'])
      ? (raw.type as PassChannelCfg['type'])
      : 'buffer';
    const src = typeof raw.src === 'string' ? raw.src.trim() : '';
    if (type !== 'keyboard' && !src) continue;
    channels.push({
      index,
      type,
      src,
      filter: raw.filter === 'nearest' ? 'nearest' : 'linear',
      wrap: raw.wrap === 'clamp' ? 'clamp' : 'repeat',
      ...(raw.timing === 'previous' || raw.timing === 'current' ? { timing: raw.timing } : {}),
    });
  }
  channels.sort((a, b) => a.index - b.index || a.src.localeCompare(b.src));
  return channels.length ? channels : undefined;
}

function normalizePass(id: PassId, value: unknown, fallback: PassConfig): PassConfig {
  const raw = isRecord(value) ? value : {};
  const channels = normalizeChannels(id, raw.channels);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    file: normalizeRelativePath(raw.file, PASS_FILES[id]),
    ...(raw.feedback === true ? { feedback: true } : {}),
    ...(channels ? { channels } : {}),
    authoring: normalizeAuthoring(id, raw.authoring),
  };
}

function normalizePassGraph(value: unknown): PassGraphReference | undefined {
  if (!isRecord(value)) return undefined;
  const file = normalizeRelativePath(value.file, '');
  const formatVersion = Number(value.formatVersion);
  if (!file || !Number.isInteger(formatVersion) || formatVersion < 1) throw new Error('无效的 Pass Graph 引用');
  return {
    file,
    formatVersion,
    ...(typeof value.revision === 'string' && value.revision ? { revision: value.revision } : {}),
  };
}

/** Basic structural validation before version migration. */
export function validateProjectDocument(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error('无效的项目配置：根节点必须是对象');
  if (typeof value.name !== 'string') throw new Error('无效的项目配置：缺少 name 字段');
  if (!isRecord(value.passes)) throw new Error('无效的项目配置：缺少 passes 字段');
  const version = typeof value.version === 'string' ? value.version : '1.0';
  const [currentMajor, currentMinor] = projectVersionParts(CURRENT_PROJECT_VERSION);
  const [incomingMajor, incomingMinor] = projectVersionParts(version);
  if (incomingMajor > currentMajor || (incomingMajor === currentMajor && incomingMinor > currentMinor)) {
    throw new Error(`项目版本 ${version} 高于当前支持的 ${CURRENT_PROJECT_VERSION}，为避免损坏已拒绝加载`);
  }
}

/** Migrates legacy documents into the current structural shape; normalization follows separately. */
export function migrateProjectDocument(value: Record<string, unknown>): Record<string, unknown> {
  const version = typeof value.version === 'string' ? value.version : '1.0';
  const incomingMajor = majorVersion(version);
  if (incomingMajor >= 2) return { ...value, version: CURRENT_PROJECT_VERSION };
  const rawPasses = isRecord(value.passes) ? value.passes : {};
  const passes: Record<string, unknown> = {};
  for (const id of PASS_IDS) {
    const raw = isRecord(rawPasses[id]) ? rawPasses[id] : {};
    passes[id] = { ...raw, authoring: { kind: 'code' } };
  }
  return { ...value, version: CURRENT_PROJECT_VERSION, passes };
}

/** Produces a complete, deterministic current-version project object. */
export function normalizeProjectDocument(value: Record<string, unknown>): ShaderlabProject {
  const name = typeof value.name === 'string' ? value.name : '';
  const base = createProject(name);
  const rawPasses = isRecord(value.passes) ? value.passes : {};
  const passes = {} as Record<PassId, PassConfig>;
  for (const id of PASS_IDS) passes[id] = normalizePass(id, rawPasses[id], base.passes[id]);
  const render = isRecord(value.render) ? value.render : {};
  const fps = Number(render.fps);
  return {
    version: CURRENT_PROJECT_VERSION,
    name,
    description: typeof value.description === 'string' ? value.description : '',
    created: typeof value.created === 'string' && value.created ? value.created : base.created,
    modified: typeof value.modified === 'string' && value.modified ? value.modified : base.modified,
    render: { fps: Number.isFinite(fps) && fps > 0 ? fps : base.render.fps },
    passes,
    ...(value.passGraph !== undefined ? { passGraph: normalizePassGraph(value.passGraph) } : {}),
    ...(value.assetManifest !== undefined ? { assetManifest: normalizePassGraph(value.assetManifest) } : {}),
    ...(value.graphLibrary !== undefined ? { graphLibrary: normalizePassGraph(value.graphLibrary) } : {}),
    ...(value.graphWorkspace !== undefined ? { graphWorkspace: normalizePassGraph(value.graphWorkspace) } : {}),
    uniforms: Array.isArray(value.uniforms) ? value.uniforms : [],
  };
}

/** JSON parse -> validate -> migrate -> normalize entry point used by all project loading/writes. */
export function parseProject(text: string): ShaderlabProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('无效的项目配置：JSON 解析失败');
  }
  validateProjectDocument(raw);
  return normalizeProjectDocument(migrateProjectDocument(raw));
}
