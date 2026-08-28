export type PassId = 'common' | 'image' | 'bufferA' | 'bufferB' | 'bufferC' | 'bufferD' | 'sound';

export interface PassChannelCfg {
  index: number;
  type: 'texture' | 'buffer' | 'keyboard' | 'volume';
  src: string;
  filter: 'linear' | 'nearest';
  wrap: 'repeat' | 'clamp';
}

export interface PassConfig {
  enabled: boolean;
  file?: string;
  feedback?: boolean;
  channels?: PassChannelCfg[];
}

export interface ShaderlabProject {
  version: string;
  name: string;
  description: string;
  created: string;
  modified: string;
  render: {
    fps: number;
  };
  passes: Record<PassId, PassConfig>;
  uniforms: unknown[];
}

export type BufferId = 'bufferA' | 'bufferB' | 'bufferC' | 'bufferD';

export const BUFFER_IDS: BufferId[] = ['bufferA', 'bufferB', 'bufferC', 'bufferD'];

export type SrcPassId = 'image' | 'common' | BufferId | 'sound';

export interface ProjectSources {
  image: string;
  common: string;
  bufferA?: string;
  bufferB?: string;
  bufferC?: string;
  bufferD?: string;
  sound?: string;
}

export const BUFFER_LETTER: Record<BufferId, string> = {
  bufferA: 'A',
  bufferB: 'B',
  bufferC: 'C',
  bufferD: 'D',
};

export const PASS_FILES: Partial<Record<PassId, string>> = {
  common: 'passes/common.glsl',
  image: 'passes/image.glsl',
  bufferA: 'passes/buffer_a.glsl',
  bufferB: 'passes/buffer_b.glsl',
  bufferC: 'passes/buffer_c.glsl',
  bufferD: 'passes/buffer_d.glsl',
};

export const PROJECT_CONFIG_FILE = 'shaderlab.json';

export function sourcesWithDefaults(s: Partial<ProjectSources> | undefined): ProjectSources {
  return {
    image: typeof s?.image === 'string' ? s.image : '',
    common: typeof s?.common === 'string' ? s.common : '',
    bufferA: typeof s?.bufferA === 'string' ? s.bufferA : '',
    bufferB: typeof s?.bufferB === 'string' ? s.bufferB : '',
    bufferC: typeof s?.bufferC === 'string' ? s.bufferC : '',
    bufferD: typeof s?.bufferD === 'string' ? s.bufferD : '',
    sound: typeof s?.sound === 'string' ? s.sound : '',
  };
}

export function createProject(name: string): ShaderlabProject {
  const now = new Date().toISOString();
  return {
    version: '1.0',
    name,
    description: '',
    created: now,
    modified: now,
    render: { fps: 60 },
    passes: {
      common: { enabled: true, file: PASS_FILES.common },
      image: { enabled: true, file: PASS_FILES.image },
      bufferA: { enabled: false },
      bufferB: { enabled: false },
      bufferC: { enabled: false },
      bufferD: { enabled: false },
      sound: { enabled: false },
    },
    uniforms: [],
  };
}

export function serializeProject(p: ShaderlabProject): string {
  return JSON.stringify(p, null, 2) + '\n';
}

export function parseProject(text: string): ShaderlabProject {
  const raw = JSON.parse(text) as Partial<ShaderlabProject>;
  if (!raw || typeof raw !== 'object' || !raw.passes || typeof raw.name !== 'string') {
    throw new Error('无效的项目配置：缺少 name 或 passes 字段');
  }
  const base = createProject(typeof raw.version === 'string' ? '' : '');
  return {
    ...base,
    ...raw,
    render: { ...base.render, ...(raw.render ?? {}) },
    passes: { ...base.passes, ...raw.passes },
    uniforms: Array.isArray(raw.uniforms) ? raw.uniforms : [],
    version: typeof raw.version === 'string' ? raw.version : base.version,
    created: typeof raw.created === 'string' ? raw.created : base.created,
    modified: typeof raw.modified === 'string' ? raw.modified : base.modified,
    description: typeof raw.description === 'string' ? raw.description : '',
  };
}

export interface AutosavePayload {
  savedAt: number;
  name: string;
  sources: ProjectSources;
  uniforms?: unknown[];
}

export function joinPath(dir: string, ...parts: string[]): string {
  const sep = /[A-Za-z]:[\\/]/.test(dir) ? '\\' : '/';
  const trimmed = dir.replace(/[\\/]+$/, '');
  return [trimmed, ...parts].join(sep);
}
