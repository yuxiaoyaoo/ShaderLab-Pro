import { ProductError } from '../productMessage';
import type { AudioPCM, RuntimeApi } from '../shadertoy/runtime';
import { pickVideoMime } from './videoExportCapabilities';

export interface VideoExportOpts {
  start: number;
  duration: number;
  fps: number;
  bitrate: number;
  mime: string;
  /** 视频输出分辨率（默认 640×360，兼容旧行为） */
  width?: number;
  height?: number;
  audio?: AudioPCM | null;
  hasAudio?: boolean;
}

export interface VideoExportResult {
  blob: Blob;
  totalFrames: number;
  audioUsed: boolean;
}

export async function exportVideo(
  api: RuntimeApi,
  opts: VideoExportOpts,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<VideoExportResult> {
  const fps = Math.max(1, Math.round(opts.fps));
  const total = Math.max(1, Math.round(opts.duration * fps));
  const frameMs = 1000 / fps;
  const baseFrame = Math.max(0, Math.round(opts.start * fps));
  const width = Math.max(64, Math.round(opts.width ?? 640));
  const height = Math.max(64, Math.round(opts.height ?? 360));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ProductError({ code: 'export.canvas-unavailable', params: { format: 'WebM' } });
  let videoStream: MediaStream | null = null;
  let track: CanvasCaptureMediaStreamTrack | null = null;
  let audioCtx: AudioContext | null = null;
  let audioSource: AudioBufferSourceNode | null = null;
  let recordStream: MediaStream | null = null;
  let rec: MediaRecorder | null = null;
  let recorderStarted = false;
  let audioFinished = false;
  let stopped: Promise<void> = Promise.resolve();
  const chunks: Blob[] = [];
  let doneFrames = 0;
  let finishNaturally = false;

  const drawFrame = async (frameIndex: number) => {
    const blob = await api.captureAt(
      opts.start + frameIndex / fps,
      baseFrame + frameIndex,
      1 / fps,
      { width, height },
    );
    if (!blob) throw new ProductError({ code: 'export.frame-capture-failed', params: { frame: frameIndex + 1 } });
    const bmp = await createImageBitmap(blob);
    if (bmp.width !== width || bmp.height !== height) {
      const actualSize = `${bmp.width}×${bmp.height}`;
      bmp.close();
      throw new ProductError({
        code: 'export.frame-size-mismatch',
        params: { frame: frameIndex + 1, actual: actualSize, expected: `${width}×${height}` },
      });
    }
    try {
      ctx.drawImage(bmp, 0, 0);
    } finally {
      bmp.close();
    }
  };

  onProgress(0, total);
  try {
    // Prepare frame zero before starting the real-time recorder/audio clock.
    // This avoids audio leading while timeline feedback is being warmed up.
    if (isCancelled()) {
      return { blob: new Blob([], { type: 'video/webm' }), totalFrames: 0, audioUsed: false };
    }
    await drawFrame(0);
    doneFrames = 1;
    onProgress(doneFrames, total);

    videoStream = canvas.captureStream(0);
    track = videoStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const wantAudio = !!(opts.audio && opts.hasAudio);
    const audioMime = wantAudio ? pickVideoMime(true) : null;
    recordStream = videoStream;
    if (wantAudio && audioMime) {
      audioCtx = new AudioContext({ sampleRate: opts.audio!.sampleRate });
      await audioCtx.resume();
      const buffer = audioCtx.createBuffer(2, opts.audio!.left.length, opts.audio!.sampleRate);
      buffer.copyToChannel(opts.audio!.left, 0);
      buffer.copyToChannel(opts.audio!.right, 1);
      const dest = audioCtx.createMediaStreamDestination();
      audioSource = audioCtx.createBufferSource();
      audioSource.buffer = buffer;
      audioSource.connect(dest);
      audioSource.onended = () => {
        audioFinished = true;
      };
      recordStream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    }

    const mime = audioMime ?? opts.mime;
    rec = new MediaRecorder(recordStream, {
      mimeType: mime,
      videoBitsPerSecond: Math.max(100_000, Math.round(opts.bitrate)),
    });
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    stopped = new Promise<void>((resolve) => {
      rec!.onstop = () => resolve();
    });
    rec.start(250);
    recorderStarted = true;
    audioSource?.start();
    const recordingStartedAt = performance.now();
    track.requestFrame();

    for (let f = 1; f < total; f++) {
      if (isCancelled()) break;
      const deadline = recordingStartedAt + f * frameMs;
      const beforeFrameDelay = deadline - performance.now();
      if (beforeFrameDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, beforeFrameDelay));
      }
      if (isCancelled()) break;
      await drawFrame(f);
      track.requestFrame();
      doneFrames = f + 1;
      onProgress(doneFrames, total);
    }

    finishNaturally = !isCancelled() && doneFrames === total;
    if (finishNaturally) {
      const finalDelay = recordingStartedAt + total * frameMs - performance.now();
      if (finalDelay > 0) await new Promise((resolve) => setTimeout(resolve, finalDelay));
    }
  } finally {
    if ((!finishNaturally || isCancelled()) && audioSource && !audioFinished) {
      try {
        audioSource.stop();
      } catch {
        // Source may not have started yet.
      }
    }
    if (recorderStarted && rec && rec.state !== 'inactive') rec.stop();
    if (recorderStarted) await stopped.catch(() => undefined);
    for (const mediaTrack of recordStream?.getTracks() ?? []) mediaTrack.stop();
    track?.stop();
    audioSource?.disconnect();
    if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined);
  }

  return {
    blob: new Blob(chunks, { type: 'video/webm' }),
    totalFrames: doneFrames,
    audioUsed: !!(opts.audio && opts.hasAudio && pickVideoMime(true)),
  };
}