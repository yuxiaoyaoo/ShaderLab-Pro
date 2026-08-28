import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { AudioPCM, RuntimeApi } from '../shadertoy/runtime';

export interface Mp4ExportOpts {
  start: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
  bitrate: number;
  audio: AudioPCM | null;
  hasAudio: boolean;
}

export interface Mp4ExportResult {
  blob: Blob;
  totalFrames: number;
  audioUsed: boolean;
}

export function isMp4ExportSupported(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof AudioEncoder !== 'undefined'
  );
}

const H264_CANDIDATES = [
  'avc1.42001f',
  'avc1.420028',
  'avc1.420032',
  'avc1.420033',
  'avc1.640028',
  'avc1.640032',
  'avc1.640033',
];

/** 依分辨率/码率挑选可用的 H.264 编码档位 */
async function pickH264Codec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<string | null> {
  for (const codec of H264_CANDIDATES) {
    try {
      const s = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
      });
      if (s.supported) return codec;
    } catch {
      // 继续尝试下一档
    }
  }
  return null;
}

async function pickAacConfig(sampleRate: number): Promise<AudioEncoderConfig | null> {
  const cfg: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: 2,
    bitrate: 128_000,
  };
  try {
    const s = await AudioEncoder.isConfigSupported(cfg);
    return s.supported ? cfg : null;
  } catch {
    return null;
  }
}

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** PCM 平面数据按固定块切分为 AudioData 流 */
function* audioChunks(pcm: AudioPCM, block: number): Generator<AudioData> {
  const total = Math.min(pcm.left.length, pcm.right.length);
  for (let off = 0; off < total; off += block) {
    const n = Math.min(block, total - off);
    const planar = new Float32Array(n * 2);
    planar.set(pcm.left.subarray(off, off + n), 0);
    planar.set(pcm.right.subarray(off, off + n), n);
    yield new AudioData({
      format: 'f32-planar',
      sampleRate: pcm.sampleRate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((off / pcm.sampleRate) * 1e6),
      data: planar,
    });
  }
}

/**
 * MP4 逐帧导出：确定性捕获 → H.264（WebCodecs VideoEncoder）→
 * 可选 AAC 音轨（AudioEncoder）→ mp4-muxer 封装。
 */
export async function exportMp4(
  api: RuntimeApi,
  opts: Mp4ExportOpts,
  onProgress: (done: number) => void,
  isCancelled: () => boolean,
): Promise<Mp4ExportResult> {
  const fps = Math.max(1, Math.round(opts.fps));
  const total = Math.max(1, Math.round(opts.duration * fps));
  const width = Math.max(2, Math.floor(opts.width));
  const height = Math.max(2, Math.floor(opts.height));

  const codec = await pickH264Codec(width, height, fps, opts.bitrate);
  if (!codec) throw new Error('当前环境不支持 H.264 硬编码（WebCodecs 不可用）');

  const pcm = opts.hasAudio ? opts.audio : null;
  const aacCfg = pcm ? await pickAacConfig(pcm.sampleRate) : null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    ...(aacCfg && pcm
      ? {
          audio: {
            codec: 'aac' as const,
            numberOfChannels: 2,
            sampleRate: pcm.sampleRate,
          },
        }
      : {}),
    fastStart: 'in-memory',
  });

  let encodeError: Error | null = null;
  let audioError: Error | null = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e instanceof Error ? e : new Error(String(e));
    },
  });
  videoEncoder.configure({
    codec,
    width,
    height,
    bitrate: opts.bitrate,
    framerate: fps,
  });

  let audioEncoder: AudioEncoder | null = null;
  if (aacCfg && pcm) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => {
        audioError = e instanceof Error ? e : new Error(String(e));
      },
    });
    audioEncoder.configure(aacCfg);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布（MP4 编码用）');

  const dt = 1 / fps;
  const baseFrame = Math.max(0, Math.round(opts.start * fps));
  const frameDur = Math.round(1e6 / fps);
  const keyEvery = Math.max(1, fps * 2);
  let written = 0;

  try {
    for (let i = 0; i < total; i++) {
    if (isCancelled() || encodeError) break;
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
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i / fps) * 1e6),
      duration: frameDur,
    });
    videoEncoder.encode(frame, { keyFrame: i % keyEvery === 0 });
    frame.close();
    written++;
    onProgress(i + 1);
    // 编码队列背压，避免内存无界增长
    while (videoEncoder.encodeQueueSize > 8) await wait(4);
    await wait(0);
  }

  if (encodeError) throw encodeError;
  if (written === 0) throw new Error('未编码任何帧（可能已被取消）');

  await videoEncoder.flush();
  videoEncoder.close();

  if (audioEncoder && pcm && !isCancelled()) {
    try {
      for (const chunk of audioChunks(pcm, 1024)) {
        if (audioError || isCancelled()) {
          chunk.close();
          break;
        }
        audioEncoder.encode(chunk);
        chunk.close();
        while (audioEncoder.encodeQueueSize > 16) await wait(4);
      }
      if (!audioError) await audioEncoder.flush();
    } catch (error) {
      audioError = error instanceof Error ? error : new Error(String(error));
    }
    audioEncoder.close();
  }

    muxer.finalize();
    return {
      blob: new Blob([target.buffer], { type: 'video/mp4' }),
      totalFrames: written,
      audioUsed: !!(audioEncoder && pcm && !audioError),
    };
  } finally {
    if (videoEncoder.state !== 'closed') videoEncoder.close();
    if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
  }
}
