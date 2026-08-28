import {
  BUFFER_IDS,
  AutosavePayload,
  PASS_FILES,
  PROJECT_CONFIG_FILE,
  ProjectSources,
  ShaderlabProject,
  joinPath,
  parseProject,
  serializeProject,
  sourcesWithDefaults,
} from './types';
import { createDir, readTextFile, writeTextFile } from './bridge';

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

export async function saveProjectTo(
  dir: string,
  meta: ShaderlabProject,
  sources: ProjectSources
): Promise<void> {
  const now = new Date().toISOString();
  const full: ShaderlabProject = { ...meta, modified: now };
  if (!full.created) full.created = now;
  await createDir(dir);
  await createDir(joinPath(dir, 'passes'));
  await createDir(joinPath(dir, 'exports'));
  await createDir(joinPath(dir, AUTOSAVE_DIR));
  await writeTextFile(joinPath(dir, PROJECT_CONFIG_FILE), serializeProject(full));
  await writeTextFile(joinPath(dir, PASS_FILES.image!), sources.image);
  await writeTextFile(joinPath(dir, PASS_FILES.common!), sources.common);
  for (const b of BUFFER_IDS) {
    const pc = full.passes[b];
    if (!pc?.enabled) continue;
    const file = pc.file ?? PASS_FILES[b]!;
    await writeTextFile(joinPath(dir, file), sources[b] ?? '');
  }
  const spc = full.passes.sound;
  if (spc?.enabled) {
    await writeTextFile(joinPath(dir, spc.file ?? PASS_FILES.sound!), sources.sound ?? '');
  }
}

export interface OpenedProject {
  dir: string;
  meta: ShaderlabProject;
  sources: ProjectSources;
}

export async function openProjectFrom(dir: string): Promise<OpenedProject> {
  let configText: string;
  try {
    configText = await readTextFile(joinPath(dir, PROJECT_CONFIG_FILE));
  } catch {
    throw new Error('所选文件夹不是有效的 ShaderLab 项目（缺少 shaderlab.json）');
  }
  const meta = parseProject(configText);
  const imageFile = meta.passes.image?.file ?? PASS_FILES.image!;
  const commonFile = meta.passes.common?.file ?? PASS_FILES.common!;
  const sources: ProjectSources = { image: '', common: '' };
  try {
    sources.image = await readTextFile(joinPath(dir, imageFile));
  } catch {
    throw new Error(`读取主 Pass 失败：${imageFile} 不存在`);
  }
  try {
    sources.common = await readTextFile(joinPath(dir, commonFile));
  } catch {
    sources.common = '';
  }
  for (const b of BUFFER_IDS) {
    const pc = meta.passes[b];
    if (!pc?.enabled) continue;
    const file = pc.file ?? PASS_FILES[b]!;
    try {
      sources[b] = await readTextFile(joinPath(dir, file));
    } catch {
      sources[b] = '';
    }
  }
  const spc = meta.passes.sound;
  if (spc?.enabled) {
    try {
      sources.sound = await readTextFile(joinPath(dir, spc.file ?? PASS_FILES.sound!));
    } catch {
      sources.sound = '';
    }
  }
  return { dir, meta, sources };
}

function autosaveRotationIndex(storageKey: string): number {
  try {
    const v = Number(localStorage.getItem(storageKey) ?? '-1');
    return Number.isFinite(v) ? v : -1;
  } catch {
    return -1;
  }
}

export async function writeAutosave(
  projectDir: string | null,
  name: string,
  sources: ProjectSources,
  uniforms?: unknown[]
): Promise<{ path: string; savedAt: number }> {
  const payload: AutosavePayload = {
    savedAt: Date.now(),
    name,
    sources,
    uniforms,
  };
  const text = JSON.stringify(payload);
  if (projectDir) {
    const storageKey = `slp.ac.${projectDir}`;
    const next = (autosaveRotationIndex(storageKey) + 1) % AUTOSAVE_VERSIONS;
    const path = joinPath(projectDir, AUTOSAVE_DIR, AUTOSAVE_SUB, `auto_0${next}.json`);
    await writeTextFile(path, text);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      void next;
    }
    return { path, savedAt: payload.savedAt };
  }
  try {
    localStorage.setItem(SCRATCH_AUTOSAVE_KEY, text);
  } catch {
    void text;
  }
  return { path: '', savedAt: payload.savedAt };
}

export async function readLatestAutosave(projectDir: string | null): Promise<AutosavePayload | null> {
  if (projectDir) {
    for (let i = AUTOSAVE_VERSIONS - 1; i >= 0; i--) {
      try {
        const raw = await readTextFile(
          joinPath(projectDir, AUTOSAVE_DIR, AUTOSAVE_SUB, `auto_0${i}.json`)
        );
        const p = JSON.parse(raw) as AutosavePayload;
        if (p && p.sources && typeof p.sources.image === 'string') {
          p.sources = sourcesWithDefaults(p.sources);
          return p;
        }
      } catch {
        continue;
      }
    }
    return null;
  }
  try {
    const raw = localStorage.getItem(SCRATCH_AUTOSAVE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as AutosavePayload;
    if (p && p.sources) return { ...p, sources: sourcesWithDefaults(p.sources) };
    return null;
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
