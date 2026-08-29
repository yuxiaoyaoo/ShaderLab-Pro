import type { GraphPassId } from '../graph/model';
import type { ProductMessageParams } from '../productMessage';

export const CURRENT_PROJECT_VERSION = '2.0';

export type PassId = 'common' | 'image' | 'bufferA' | 'bufferB' | 'bufferC' | 'bufferD' | 'sound';

export interface PassChannelCfg {
  index: number;
  type: 'texture' | 'buffer' | 'keyboard' | 'volume';
  src: string;
  filter: 'linear' | 'nearest';
  wrap: 'repeat' | 'clamp';
  /** Compatibility projection only. The project Pass Graph is the semantic source of truth. */
  timing?: 'current' | 'previous';
}

export interface PassGraphReference {
  file: string;
  formatVersion: number;
  revision?: string;
}

export interface ProjectResourceReference {
  file: string;
  formatVersion: number;
  revision?: string;
}

export type PassAuthoring =
  | { kind: 'code' }
  | {
      kind: 'graph';
      graphFile: string;
      graphFormatVersion: number;
      generatedHash?: string;
    };

export interface PassConfig {
  enabled: boolean;
  file?: string;
  feedback?: boolean;
  channels?: PassChannelCfg[];
  authoring?: PassAuthoring;
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
  /** Versioned project-level channel graph. PassConfig.channels/feedback are migration-only. */
  passGraph?: PassGraphReference;
  /** Optional M6 manifests. Absence means an empty manifest/library for legacy 2.0 projects. */
  assetManifest?: ProjectResourceReference;
  graphLibrary?: ProjectResourceReference;
  /** Non-semantic Graph editor layout. It never participates in Graph or Library revisions. */
  graphWorkspace?: ProjectResourceReference;
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

export const PASS_FILES: Record<PassId, string> = {
  common: 'passes/common.glsl',
  image: 'passes/image.glsl',
  bufferA: 'passes/buffer_a.glsl',
  bufferB: 'passes/buffer_b.glsl',
  bufferC: 'passes/buffer_c.glsl',
  bufferD: 'passes/buffer_d.glsl',
  sound: 'passes/sound.glsl',
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
  const code = (): PassAuthoring => ({ kind: 'code' });
  return {
    version: CURRENT_PROJECT_VERSION,
    name,
    description: '',
    created: now,
    modified: now,
    render: { fps: 60 },
    passes: {
      common: { enabled: true, file: PASS_FILES.common, authoring: code() },
      image: { enabled: true, file: PASS_FILES.image, authoring: code() },
      bufferA: { enabled: false, file: PASS_FILES.bufferA, authoring: code() },
      bufferB: { enabled: false, file: PASS_FILES.bufferB, authoring: code() },
      bufferC: { enabled: false, file: PASS_FILES.bufferC, authoring: code() },
      bufferD: { enabled: false, file: PASS_FILES.bufferD, authoring: code() },
      sound: { enabled: false, file: PASS_FILES.sound, authoring: code() },
    },
    passGraph: { file: 'graphs/pass-graph.json', formatVersion: 1 },
    assetManifest: { file: 'assets/manifest.json', formatVersion: 1 },
    graphLibrary: { file: 'graphs/library.json', formatVersion: 2 },
    graphWorkspace: { file: 'graphs/workspace.json', formatVersion: 1 },
    uniforms: [],
  };
}

export function serializeProject(p: ShaderlabProject): string {
  return JSON.stringify(p, null, 2) + '\n';
}

export type GraphRecoveryReason = 'identity-mismatch' | 'compiler-invalid' | 'runtime-rejected';

export interface AutosaveGraphRecoveryDiagnostic {
  message: string;
  severity: 'error' | 'warning' | 'info';
  stage: 'graph-schema' | 'graph-validate' | 'graph-typecheck' | 'glsl-compile' | 'runtime';
  code?: string;
  params?: ProductMessageParams;
  rawDetail?: string;
  origin: {
    kind: 'graph';
    pass: GraphPassId;
    nodeId?: string;
    socketId?: string;
    edgeId?: string;
    parameterId?: string;
  };
}

export interface AutosaveGraphRecoveryState {
  reasons?: Partial<Record<GraphPassId, GraphRecoveryReason>>;
  diagnostics?: Partial<Record<GraphPassId, AutosaveGraphRecoveryDiagnostic[]>>;
}

export interface AutosavePayload {
  version: 2;
  savedAt: number;
  name: string;
  meta: ShaderlabProject;
  sources: ProjectSources;
  uniforms: unknown[];
  graphDocuments?: Record<string, unknown>;
  passGraph?: unknown;
  graphRecovery?: AutosaveGraphRecoveryState;
  assetManifest?: unknown;
  assetPayloads?: Record<string, string>;
  graphLibrary?: unknown;
  graphWorkspace?: unknown;
  /** True only when a pre-V2 snapshot had no project metadata. */
  legacy?: boolean;
}

export function joinPath(dir: string, ...parts: string[]): string {
  const sep = /[A-Za-z]:[\\/]/.test(dir) ? '\\' : '/';
  const trimmed = dir.replace(/[\\/]+$/, '');
  return [trimmed, ...parts].join(sep);
}
