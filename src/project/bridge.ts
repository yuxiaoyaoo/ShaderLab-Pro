import { invoke } from '@tauri-apps/api/core';
import { ProductError, productError } from '../productMessage';

export interface AtomicTextFile {
  path: string;
  contents: string;
}

export type AtomicFile =
  | { kind: 'text'; path: string; contents: string }
  | { kind: 'binary'; path: string; dataBase64: string };

export interface BridgeMock {
  pickFolder?: (title: string, suggestedName?: string) => Promise<string | null>;
  pickFile?: (title: string, extensions?: string[]) => Promise<string | null>;
  readTextFile?: (path: string) => Promise<string>;
  readBinaryFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, contents: string) => Promise<void>;
  writeTextFilesAtomic?: (files: AtomicTextFile[]) => Promise<void>;
  writeFilesAtomic?: (files: AtomicFile[]) => Promise<void>;
  writeBinaryFile?: (path: string, dataBase64: string) => Promise<void>;
  createDir?: (path: string) => Promise<void>;
  deleteFile?: (path: string) => Promise<void>;
}

declare global {
  interface Window {
    __slpMockBridge?: BridgeMock;
  }
}

export const hasTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export class NativeUnavailableError extends ProductError {
  constructor() {
    super({ code: 'bridge.native-unavailable', fallback: '原生对话框/文件系统仅在桌面应用中可用' });
    this.name = 'NativeUnavailableError';
  }
}

async function invokeBridge<T>(code: string, command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw productError(error, code);
  }
}

export async function pickFolder(title: string, suggestedName?: string): Promise<string | null> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.pickFolder) return m.pickFolder(title, suggestedName);
  if (!hasTauri()) throw new NativeUnavailableError();
  const r = await invokeBridge<string | null>('bridge.pick-folder-failed', 'pick_folder', {
    args: { title, suggested_name: suggestedName ?? null },
  });
  return r && r.length > 0 ? r : null;
}

export async function pickFile(title: string, extensions?: string[]): Promise<string | null> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.pickFile) return m.pickFile(title, extensions);
  if (!hasTauri()) throw new NativeUnavailableError();
  const r = await invokeBridge<string | null>('bridge.pick-file-failed', 'pick_file', {
    args: { title, extensions: extensions ?? null },
  });
  return r && r.length > 0 ? r : null;
}

export async function readTextFile(path: string): Promise<string> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.readTextFile) return m.readTextFile(path);
  if (!hasTauri()) throw new NativeUnavailableError();
  return invokeBridge('bridge.read-text-failed', 'read_text_file', { path });
}

/** Returns file bytes as base64 so local assets never need a webview file:// permission exception. */
export async function readBinaryFile(path: string): Promise<string> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.readBinaryFile) return m.readBinaryFile(path);
  if (!hasTauri()) throw new NativeUnavailableError();
  return invokeBridge('bridge.read-binary-failed', 'read_binary_file', { path });
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.writeTextFile) return m.writeTextFile(path, contents);
  if (!hasTauri()) throw new NativeUnavailableError();
  await invokeBridge('bridge.write-text-failed', 'write_text_file', { path, contents });
}

/** Windows project paths are case-insensitive; native validation remains authoritative. */
function atomicTargetIdentity(path: string): string {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? path.replace(/\//g, '\\').toLowerCase() : path;
}

/** Atomically commits an ordered set of text files; callers put commit markers last. */
export async function writeTextFilesAtomic(files: AtomicTextFile[]): Promise<void> {
  if (files.length === 0) return;
  const targets = new Set<string>();
  for (const file of files) {
    const identity = atomicTargetIdentity(file.path);
    if (!file.path || targets.has(identity)) throw new ProductError({
      code: 'bridge.duplicate-target',
      params: { path: file.path },
      fallback: `原子写入包含重复目标：${file.path}`,
    });
    targets.add(identity);
  }
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.writeTextFilesAtomic) return m.writeTextFilesAtomic(files);
  if (!hasTauri()) throw new NativeUnavailableError();
  await invokeBridge('bridge.write-files-failed', 'write_text_files_atomic', { files });
}

/** Atomically stages and commits text and Base64 binary files in caller order. */
export async function writeFilesAtomic(files: AtomicFile[]): Promise<void> {
  if (files.length === 0) return;
  const targets = new Set<string>();
  for (const file of files) {
    const identity = atomicTargetIdentity(file.path);
    if (!file.path || targets.has(identity)) throw new ProductError({
      code: 'bridge.duplicate-target',
      params: { path: file.path },
      fallback: `原子写入包含重复目标：${file.path}`,
    });
    targets.add(identity);
  }
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m?.writeFilesAtomic) return m.writeFilesAtomic(files);
  if (m && files.every((file) => file.kind === 'text') && m.writeTextFilesAtomic) {
    return m.writeTextFilesAtomic(files.map((file) => ({ path: file.path, contents: file.contents })));
  }
  if (!hasTauri()) throw new NativeUnavailableError();
  await invokeBridge('bridge.write-files-failed', 'write_files_atomic', { files });
}

export async function writeBinaryFile(path: string, dataBase64: string): Promise<void> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.writeBinaryFile) return m.writeBinaryFile(path, dataBase64);
  if (!hasTauri()) throw new NativeUnavailableError();
  // Tauri v2 会自动把 Rust 端 snake_case 参数（data_base64）映射为 JS 侧 camelCase（dataBase64）
  await invokeBridge('bridge.write-binary-failed', 'write_binary_file', { path, dataBase64 });
}

export async function createDir(path: string): Promise<void> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.createDir) return m.createDir(path);
  if (!hasTauri()) throw new NativeUnavailableError();
  await invokeBridge('bridge.create-dir-failed', 'create_dir', { path });
}

export async function deleteFile(path: string): Promise<void> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.deleteFile) return m.deleteFile(path);
  if (!hasTauri()) throw new NativeUnavailableError();
  await invokeBridge('bridge.delete-file-failed', 'delete_file', { path });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(new ProductError({ code: 'bridge.blob-read-failed', fallback: '读取导出数据失败' }));
    reader.readAsDataURL(blob);
  });
}
