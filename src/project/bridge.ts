import { invoke } from '@tauri-apps/api/core';

export interface BridgeMock {
  pickFolder?: (title: string, suggestedName?: string) => Promise<string | null>;
  pickFile?: (title: string, extensions?: string[]) => Promise<string | null>;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, contents: string) => Promise<void>;
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

export class NativeUnavailableError extends Error {
  constructor() {
    super('原生对话框/文件系统仅在桌面应用中可用');
    this.name = 'NativeUnavailableError';
  }
}

export async function pickFolder(title: string, suggestedName?: string): Promise<string | null> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.pickFolder) return m.pickFolder(title, suggestedName);
  if (!hasTauri()) throw new NativeUnavailableError();
  const r = await invoke<string | null>('pick_folder', {
    args: { title, suggested_name: suggestedName ?? null },
  });
  return r && r.length > 0 ? r : null;
}

export async function pickFile(title: string, extensions?: string[]): Promise<string | null> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.pickFile) return m.pickFile(title, extensions);
  if (!hasTauri()) throw new NativeUnavailableError();
  const r = await invoke<string | null>('pick_file', {
    args: { title, extensions: extensions ?? null },
  });
  return r && r.length > 0 ? r : null;
}

export async function readTextFile(path: string): Promise<string> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.readTextFile) return m.readTextFile(path);
  if (!hasTauri()) throw new NativeUnavailableError();
  return invoke('read_text_file', { path });
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.writeTextFile) return m.writeTextFile(path, contents);
  if (!hasTauri()) throw new NativeUnavailableError();
  await invoke('write_text_file', { path, contents });
}

export async function writeBinaryFile(path: string, dataBase64: string): Promise<void> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.writeBinaryFile) return m.writeBinaryFile(path, dataBase64);
  if (!hasTauri()) throw new NativeUnavailableError();
  // Tauri v2 会自动把 Rust 端 snake_case 参数（data_base64）映射为 JS 侧 camelCase（dataBase64）
  await invoke('write_binary_file', { path, dataBase64 });
}

export async function createDir(path: string): Promise<void> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.createDir) return m.createDir(path);
  if (!hasTauri()) throw new NativeUnavailableError();
  await invoke('create_dir', { path });
}

export async function deleteFile(path: string): Promise<void> {
  const m = typeof window !== 'undefined' ? window.__slpMockBridge : undefined;
  if (m && m.deleteFile) return m.deleteFile(path);
  if (!hasTauri()) throw new NativeUnavailableError();
  await invoke('delete_file', { path });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(new Error('读取导出数据失败'));
    reader.readAsDataURL(blob);
  });
}
