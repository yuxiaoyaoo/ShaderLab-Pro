import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { RuntimeApi } from '../shadertoy/runtime';

export interface GifExportOpts {
  start: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
  maxColors: number;
}

export interface GifExportResult {
  blob: Blob;
  totalFrames: number;
}

/** 浏览器对 GIF 帧延迟普遍有 ≥2cs（20ms）的限制，帧率上限取 50 */
export const GIF_MAX_FPS = 50;

export function clampGifFps(fps: number): number {
  return Math.max(1, Math.min(GIF_MAX_FPS, Math.round(fps)));
}

/**
 * GIF 逐帧导出：按目标分辨率确定性捕获（captureAt）→
 * 每帧独立调色板量化（256 色）→ LZW 编码。
 */
export async function exportGif(
  api: RuntimeApi,
  opts: GifExportOpts,
  onProgress: (done: number) => void,
  isCancelled: () => boolean,
): Promise<GifExportResult> {
  const fps = clampGifFps(opts.fps);
  const total = Math.max(1, Math.round(opts.duration * fps));
  const delay = Math.round(1000 / fps);
  const width = Math.max(2, Math.floor(opts.width));
  const height = Math.max(2, Math.floor(opts.height));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2D 画布（GIF 编码用）');

  const gif = GIFEncoder();
  const dt = 1 / fps;
  const baseFrame = Math.max(0, Math.round(opts.start * fps));
  let written = 0;

  for (let i = 0; i < total; i++) {
    if (isCancelled()) break;
    const blob = await api.captureAt(
      opts.start + i * dt,
      baseFrame + i,
      dt,
      { width, height },
    );
    if (!blob) throw new Error(`第 ${i + 1} 帧捕获失败`);
    const bmp = await createImageBitmap(blob);
    if (bmp.width !== width || bmp.height !== height) {
      const actualSize = `${bmp.width}×${bmp.height}`;
      bmp.close();
      throw new Error(`第 ${i + 1} 帧尺寸不匹配：捕获为 ${actualSize}，期望 ${width}×${height}`);
    }
    try {
      ctx.drawImage(bmp, 0, 0);
    } finally {
      bmp.close();
    }
    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = quantize(data, opts.maxColors, { format: 'rgb565' });
    const index = applyPalette(data, palette, 'rgb565');
    gif.writeFrame(index, width, height, { palette, delay });
    written++;
    onProgress(i + 1);
    await new Promise((r) => setTimeout(r, 0));
  }

  if (written === 0) throw new Error('未写入任何帧（可能已被取消）');
  gif.finish();
  return {
    blob: new Blob([gif.bytes() as BlobPart], { type: 'image/gif' }),
    totalFrames: written,
  };
}
