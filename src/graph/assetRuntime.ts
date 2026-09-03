import { normalizeAssetManifest, type AssetManifest, type AudioAsset, type TextureAsset } from './assets';
import { MAX_ASSET_BYTES, assetContentHash, assetPayloadByteLength, assetPayloadBytes } from './contentHash';
import type { RuntimeTextureAsset } from '../shadertoy/runtime';

const BITMAP_OPTIONS: ImageBitmapOptions = {
  colorSpaceConversion: 'none',
  premultiplyAlpha: 'none',
};

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

/** Reads dimensions from trusted format headers before invoking an image decoder. */
export function imageHeaderDimensions(bytes: Uint8Array, mediaType: TextureAsset['mediaType']): { width: number; height: number } {
  if (mediaType === 'image/png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value) || ascii(bytes, 12, 4) !== 'IHDR') throw new Error('PNG 文件头无效');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  if (mediaType === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('JPEG 文件头无效');
    let offset = 2;
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 4 <= bytes.length) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      if (sof.has(marker) && length >= 7) {
        return {
          height: (bytes[offset + 3] << 8) | bytes[offset + 4],
          width: (bytes[offset + 5] << 8) | bytes[offset + 6],
        };
      }
      offset += length;
    }
    throw new Error('JPEG 尺寸头无效');
  }
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') throw new Error('WebP 文件头无效');
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height };
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  throw new Error('WebP 尺寸头无效');
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('纹理尺寸超出 1–8192 安全范围');
}

export function textureMediaType(path: string): TextureAsset['mediaType'] {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  throw new Error('仅支持 PNG、JPEG 和 WebP 纹理');
}

export function audioMediaType(path: string): AudioAsset['mediaType'] {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'mp3') return 'audio/mpeg';
  if (extension === 'ogg' || extension === 'oga') return 'audio/ogg';
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'm4a' || extension === 'mp4') return 'audio/mp4';
  if (extension === 'flac') return 'audio/flac';
  throw new Error('仅支持 MP3、OGG、WAV、M4A 和 FLAC 音频');
}

export async function decodeTexturePayload(asset: TextureAsset, payload: string): Promise<RuntimeTextureAsset> {
  if (assetContentHash(payload) !== asset.contentHash) throw new Error(`纹理 ${asset.id} contentHash 不匹配`);
  const bytes = assetPayloadBytes(payload);
  const header = imageHeaderDimensions(bytes, asset.mediaType);
  assertDimensions(header.width, header.height);
  if (header.width !== asset.width || header.height !== asset.height) throw new Error(`纹理 ${asset.id} 文件头尺寸与 Manifest 不匹配`);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: asset.mediaType }), BITMAP_OPTIONS);
  if (bitmap.width !== asset.width || bitmap.height !== asset.height) {
    bitmap.close();
    throw new Error(`纹理 ${asset.id} 尺寸与 Manifest 不匹配`);
  }
  return { id: asset.id, width: bitmap.width, height: bitmap.height, source: bitmap };
}

export async function decodeTextureManifest(manifest: AssetManifest, payloads: Readonly<Record<string, string>>): Promise<RuntimeTextureAsset[]> {
  const normalized = normalizeAssetManifest(manifest);
  const decoded: RuntimeTextureAsset[] = [];
  try {
    for (const asset of normalized.assets) {
      const payload = payloads[asset.id];
      if (!payload) throw new Error(`纹理 ${asset.id} 缺少二进制 payload`);
      decoded.push(await decodeTexturePayload(asset, payload));
    }
    return decoded;
  } catch (error) {
    for (const asset of decoded) if (asset.source && 'close' in asset.source) (asset.source as ImageBitmap).close();
    throw error;
  }
}

export async function createImportedTextureAsset(path: string, payload: string, existing: readonly TextureAsset[]): Promise<{ asset: TextureAsset; runtime: RuntimeTextureAsset }> {
  const mediaType = textureMediaType(path);
  const hash = assetContentHash(payload);
  const duplicate = existing.find((asset) => asset.contentHash === hash);
  if (duplicate) throw new Error(`该纹理已导入：${duplicate.name}`);
  const fileName = path.replace(/\\/g, '/').split('/').pop() ?? 'texture';
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'texture';
  const idPrefix = /^[A-Za-z]/.test(stem) ? stem : `asset_${stem}`;
  let id = `${idPrefix}_${hash.slice(0, 8)}`;
  let suffix = 2;
  while (existing.some((asset) => asset.id === id)) id = `${idPrefix}_${hash.slice(0, 8)}_${suffix++}`;
  const bytes = assetPayloadBytes(payload);
  const header = imageHeaderDimensions(bytes, mediaType);
  assertDimensions(header.width, header.height);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }), BITMAP_OPTIONS);
  if (bitmap.width !== header.width || bitmap.height !== header.height) {
    bitmap.close();
    throw new Error('纹理解码尺寸与文件头不一致');
  }
  const extension = mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : 'webp';
  const asset: TextureAsset = {
    id,
    name: fileName,
    file: `assets/${id}.${extension}`,
    mediaType,
    width: bitmap.width,
    height: bitmap.height,
    colorSpace: 'srgb',
    contentHash: hash,
  };
  return { asset, runtime: { id, width: bitmap.width, height: bitmap.height, source: bitmap } };
}

/**
 * Registers a music file as an audio input asset. No decode at import time —
 * the runtime decodes on play via <audio>; failure there falls back to silence.
 */
export function createImportedAudioAsset(path: string, payload: string, existingAudio: readonly AudioAsset[]): AudioAsset {
  const mediaType = audioMediaType(path);
  const hash = assetContentHash(payload);
  const duplicate = existingAudio.find((asset) => asset.contentHash === hash);
  if (duplicate) throw new Error(`该音频已导入：${duplicate.name}`);
  const byteLength = assetPayloadByteLength(payload);
  if (byteLength < 1 || byteLength > MAX_ASSET_BYTES) throw new Error(`音频文件不能超过 ${MAX_ASSET_BYTES / 1024 / 1024} MiB`);
  const fileName = path.replace(/\\/g, '/').split('/').pop() ?? 'audio';
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'audio';
  const idPrefix = /^[A-Za-z]/.test(stem) ? stem : `audio_${stem}`;
  let id = `${idPrefix}_${hash.slice(0, 8)}`;
  let suffix = 2;
  while (existingAudio.some((asset) => asset.id === id)) id = `${idPrefix}_${hash.slice(0, 8)}_${suffix++}`;
  const extension = mediaType === 'audio/mpeg' ? 'mp3' : mediaType === 'audio/ogg' ? 'ogg' : mediaType === 'audio/wav' ? 'wav' : mediaType === 'audio/mp4' ? 'm4a' : 'flac';
  return {
    id,
    name: fileName,
    file: `assets/${id}.${extension}`,
    mediaType,
    bytes: byteLength,
    contentHash: hash,
  };
}
