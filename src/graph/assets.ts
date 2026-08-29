import { ProductError } from '../productMessage';
import { deterministicHash, stableStringify } from './compiler/hash';
import type { GraphDocument } from './model';

export const ASSET_MANIFEST_FORMAT = 'shaderlab-assets' as const;
export const ASSET_MANIFEST_VERSION = 1 as const;

export type TextureColorSpace = 'srgb' | 'linear';

export interface TextureAsset {
  id: string;
  name: string;
  file: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  colorSpace: TextureColorSpace;
  contentHash: string;
}

export interface AssetManifest {
  format: typeof ASSET_MANIFEST_FORMAT;
  version: typeof ASSET_MANIFEST_VERSION;
  assets: TextureAsset[];
}

export interface TextureCompileBinding {
  slot: 0 | 1 | 2 | 3;
  assetId: string;
  colorSpace: TextureColorSpace;
}

export interface ResolvedTextureEnvironment {
  bindings: Readonly<Record<string, TextureCompileBinding>>;
  assets: { assetId: string; slot: 0 | 1 | 2 | 3; filter: 'linear' | 'nearest'; wrap: 'repeat' | 'clamp' }[];
  revision: string;
}

export const MAX_TEXTURE_ASSETS = 64;
export const MAX_TEXTURE_DIMENSION = 8192;
export const MAX_PROJECT_TEXTURE_PIXELS = 64 * 1024 * 1024;

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/i;
const MEDIA = new Set<TextureAsset['mediaType']>(['image/png', 'image/jpeg', 'image/webp']);

export function createAssetManifest(): AssetManifest {
  return { format: ASSET_MANIFEST_FORMAT, version: ASSET_MANIFEST_VERSION, assets: [] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeRelativeAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('assets/') || value.includes('\\')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function normalizeAssetManifest(value: unknown): AssetManifest {
  const input = record(value);
  if (!input || input.format !== ASSET_MANIFEST_FORMAT || input.version !== ASSET_MANIFEST_VERSION || !Array.isArray(input.assets)) {
    throw new Error('Asset Manifest 格式或版本无效');
  }
  if (input.assets.length > MAX_TEXTURE_ASSETS) throw new Error(`Asset 数量不能超过 ${MAX_TEXTURE_ASSETS}`);
  const ids = new Set<string>();
  const files = new Set<string>();
  let totalPixels = 0;
  const assets = input.assets.map((raw, index): TextureAsset => {
    const asset = record(raw);
    const id = asset?.id;
    const file = asset?.file;
    const mediaType = asset?.mediaType;
    const width = Number(asset?.width);
    const height = Number(asset?.height);
    if (!asset || typeof id !== 'string' || !ID.test(id)) throw new Error(`Asset[${index}] id 无效`);
    if (ids.has(id)) throw new Error(`Asset id 重复：${id}`);
    if (!safeRelativeAssetPath(file)) throw new Error(`Asset ${id} file 必须是 assets/ 下的安全相对路径`);
    if (files.has(file.toLowerCase())) throw new Error(`Asset file 重复：${file}`);
    if (typeof mediaType !== 'string' || !MEDIA.has(mediaType as TextureAsset['mediaType'])) throw new Error(`Asset ${id} mediaType 无效`);
    if (!Number.isInteger(width) || width < 1 || width > MAX_TEXTURE_DIMENSION || !Number.isInteger(height) || height < 1 || height > MAX_TEXTURE_DIMENSION) throw new Error(`Asset ${id} 尺寸无效`);
    totalPixels += width * height;
    if (totalPixels > MAX_PROJECT_TEXTURE_PIXELS) throw new Error(`Asset 总像素不能超过 ${MAX_PROJECT_TEXTURE_PIXELS}`);
    if (asset.colorSpace !== 'srgb' && asset.colorSpace !== 'linear') throw new Error(`Asset ${id} colorSpace 无效`);
    if (typeof asset.contentHash !== 'string' || !HASH.test(asset.contentHash)) throw new Error(`Asset ${id} contentHash 无效`);
    ids.add(id);
    files.add(file.toLowerCase());
    return {
      id,
      name: typeof asset.name === 'string' && asset.name.trim() ? asset.name.trim().slice(0, 256) : id,
      file,
      mediaType: mediaType as TextureAsset['mediaType'],
      width,
      height,
      colorSpace: asset.colorSpace,
      contentHash: asset.contentHash.toLowerCase(),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { format: ASSET_MANIFEST_FORMAT, version: ASSET_MANIFEST_VERSION, assets };
}

export function parseAssetManifest(text: string): AssetManifest {
  try {
    return normalizeAssetManifest(JSON.parse(text) as unknown);
  } catch {
    throw new ProductError({ code: 'asset.manifest-invalid' });
  }
}

export function serializeAssetManifest(value: unknown): string {
  return `${JSON.stringify(normalizeAssetManifest(value), null, 2)}\n`;
}

/** Assigns stable free iChannel slots after project Buffer channels. Identical assets share one slot. */
export function resolveTextureEnvironment(
  document: GraphDocument,
  manifest: AssetManifest,
  occupiedSlots: Iterable<number> = [],
): ResolvedTextureEnvironment {
  const normalized = normalizeAssetManifest(manifest);
  const byId = new Map(normalized.assets.map((asset) => [asset.id, asset]));
  const used = new Set([...occupiedSlots].filter((slot) => Number.isInteger(slot) && slot >= 0 && slot <= 3));
  const free = ([0, 1, 2, 3] as const).filter((slot) => !used.has(slot));
  const nodes = document.nodes.filter((node) => node.type === 'input.texture2d').sort((a, b) => a.id.localeCompare(b.id));
  const slotByBinding = new Map<string, { assetId: string; slot: 0 | 1 | 2 | 3; filter: 'linear' | 'nearest'; wrap: 'repeat' | 'clamp' }>();
  const bindings: Record<string, TextureCompileBinding> = {};
  for (const node of nodes) {
    const assetId = node.values.assetId;
    if (typeof assetId !== 'string' || !assetId) throw new Error(`Texture2D ${node.id} 未选择资产`);
    const asset = byId.get(assetId);
    if (!asset) throw new Error(`Texture2D ${node.id} 引用了不存在的资产 ${assetId}`);
    const filter = node.values.filter === 'nearest' ? 'nearest' : 'linear';
    const wrap = node.values.wrap === 'clamp' ? 'clamp' : 'repeat';
    const key = `${assetId}\u0000${filter}\u0000${wrap}`;
    let resolved = slotByBinding.get(key);
    if (!resolved) {
      const slot = free.shift();
      if (slot === undefined) throw new Error(`${document.pass} 的 Buffer 与纹理输入超过 4 个 iChannel slot`);
      resolved = { assetId, slot, filter, wrap };
      slotByBinding.set(key, resolved);
    }
    bindings[node.id] = { slot: resolved.slot, assetId, colorSpace: asset.colorSpace };
  }
  const assets = [...slotByBinding.values()].sort((a, b) => a.slot - b.slot || a.assetId.localeCompare(b.assetId));
  const revision = deterministicHash(stableStringify({ bindings, assets: assets.map((entry) => ({ ...entry, hash: byId.get(entry.assetId)!.contentHash })) }));
  return { bindings, assets, revision };
}
