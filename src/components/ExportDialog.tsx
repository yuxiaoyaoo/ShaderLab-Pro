import { Show, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { RuntimeApi } from '../shadertoy/runtime';
import { blobToBase64, pickFolder, writeBinaryFile } from '../project/bridge';
import { joinPath } from '../project/types';
import { pcmToWav } from '../export/wav';
import {
  describeMime,
  exportVideo,
  pickVideoMime,
  type VideoExportOpts,
} from '../export/videoExport';
import { GIF_MAX_FPS, clampGifFps, exportGif } from '../export/gifExport';
import { exportMp4, isMp4ExportSupported } from '../export/mp4Export';
import { useModalFocus } from './modalFocus';

interface Props {
  api: Accessor<RuntimeApi | null>;
  onClose: () => void;
  onDone?: (msg: string, kind: 'ok' | 'error') => void;
}

const BITRATES = [
  { label: '1 Mbps', value: 1_000_000 },
  { label: '2 Mbps', value: 2_000_000 },
  { label: '5 Mbps', value: 5_000_000 },
  { label: '10 Mbps', value: 10_000_000 },
  { label: '20 Mbps', value: 20_000_000 },
];

const RESOLUTIONS = [
  { label: '640×360', width: 640, height: 360 },
  { label: '720p · 1280×720', width: 1280, height: 720 },
  { label: '1080p · 1920×1080', width: 1920, height: 1080 },
  { label: '2K · 2560×1440', width: 2560, height: 1440 },
  { label: '4K · 3840×2160', width: 3840, height: 2160 },
  { label: '8K · 7680×4320', width: 7680, height: 4320 },
];

const CUSTOM_RESOLUTION = 'custom';
const MAX_EXPORT_DIMENSION = 8192;
const MAX_EXPORT_PIXELS = 7680 * 4320;

type OutputSize = { width: number; height: number };

type Phase = 'none' | 'audio' | 'frames';

export default function ExportDialog(props: Props) {
  let dialogRef: HTMLDivElement | undefined;
  useModalFocus(() => dialogRef);
  const [format, setFormat] = createSignal<'png' | 'webm' | 'mp4' | 'gif' | 'wav'>('png');
  const [start, setStart] = createSignal('0');
  const [duration, setDuration] = createSignal('5');
  const [fps, setFps] = createSignal(60);
  const [prefix, setPrefix] = createSignal('frame');
  const [bitrate, setBitrate] = createSignal(BITRATES[1].value);
  const [resolution, setResolution] = createSignal('0');
  const [customWidth, setCustomWidth] = createSignal('1920');
  const [customHeight, setCustomHeight] = createSignal('1080');
  const [includeAudio, setIncludeAudio] = createSignal(true);
  const [outDir, setOutDir] = createSignal('');
  const [running, setRunning] = createSignal(false);
  const [done, setDone] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [phase, setPhase] = createSignal<Phase>('none');
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const videoSupported = () => typeof MediaRecorder !== 'undefined' && !!pickVideoMime();
  const mp4Supported = isMp4ExportSupported();
  let cancelled = false;
  let startedAt = 0;

  const outputSize = (): OutputSize => {
    if (resolution() === CUSTOM_RESOLUTION) {
      return {
        width: Number(customWidth()),
        height: Number(customHeight()),
      };
    }
    return RESOLUTIONS[Number(resolution())] ?? RESOLUTIONS[0];
  };

  const validateOutputSize = (candidate?: OutputSize): OutputSize | string => {
    const size = candidate ?? outputSize();
    if (!Number.isFinite(size.width) || !Number.isInteger(size.width)
      || !Number.isFinite(size.height) || !Number.isInteger(size.height)) {
      return '宽度和高度必须是整数';
    }
    const min = format() === 'webm' || format() === 'mp4' ? 64 : format() === 'gif' ? 2 : 1;
    if (size.width < min || size.height < min) {
      return `${format() === 'webm' || format() === 'mp4' ? '视频' : '当前格式'}分辨率不得小于 ${min}×${min}`;
    }
    if (size.width > MAX_EXPORT_DIMENSION || size.height > MAX_EXPORT_DIMENSION) {
      return `单边尺寸不能超过 ${MAX_EXPORT_DIMENSION} 像素`;
    }
    if (size.width * size.height > MAX_EXPORT_PIXELS) {
      return '总像素不能超过 8K（约 3318 万像素）';
    }
    if ((format() === 'webm' || format() === 'mp4')
      && (size.width % 2 !== 0 || size.height % 2 !== 0)) {
      return '视频编码要求宽度和高度均为偶数';
    }
    return size;
  };

  const chooseDir = async () => {
    try {
      const d = await pickFolder(
        format() === 'png'
          ? '选择序列帧输出目录'
          : format() === 'webm'
            ? '选择视频输出目录'
            : format() === 'mp4'
              ? '选择 MP4 输出目录'
              : format() === 'gif'
                ? '选择 GIF 输出目录'
                : '选择音频输出目录',
      );
      if (d) {
        setOutDir(d);
        setResult(null);
      }
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const finish = (ok: boolean, text: string) => {
    setResult({ ok, text });
    props.onDone?.(text, ok ? 'ok' : 'error');
  };

  const startExport = async () => {
    if (running()) return;
    const api = props.api();
    if (!api) return;
    const s = Number.parseFloat(start());
    const dur = Number.parseFloat(duration());
    if (format() !== 'wav' && (!Number.isFinite(s) || s < 0)) {
      setResult({ ok: false, text: '起始时间必须是非负数字' });
      return;
    }
    if (!Number.isFinite(dur) || dur <= 0) {
      setResult({ ok: false, text: '时长必须大于 0 秒' });
      return;
    }
    if (dur > 120 && (format() === 'wav'
      || ((format() === 'mp4' || format() === 'webm') && includeAudio()))) {
      setResult({ ok: false, text: '包含音频的导出时长不能超过 120 秒' });
      return;
    }
    const sizeResult = format() === 'wav' ? null : validateOutputSize();
    if (typeof sizeResult === 'string') {
      setResult({ ok: false, text: sizeResult });
      return;
    }
    const size = sizeResult as OutputSize | null;
    if (!outDir()) {
      setResult({ ok: false, text: '请先选择输出目录' });
      return;
    }
    // GIF 帧延迟受浏览器 ≥20ms 限制，60 FPS 会自动钳制到 50。
    const effFps = format() === 'gif' ? clampGifFps(fps()) : fps();
    const requestedFrames = Math.max(1, Math.round(dur * effFps));
    if (format() !== 'wav' && requestedFrames > 3600) {
      setResult({ ok: false, text: '单次最多导出 3600 帧，请降低时长或帧率' });
      return;
    }
    const n = format() === 'wav' ? 1 : requestedFrames;
    setTotal(n);
    setDone(0);
    setPhase('none');
    setResult(null);
    cancelled = false;
    startedAt = performance.now();
    setRunning(true);
    const wasRunning = api.isRunning();
    if (wasRunning) api.pause();
    const startFrame = Math.max(0, Math.round(s * fps()));
    try {
      if (format() === 'png') {
        setPhase('frames');
        const pfx = (prefix().trim() || 'frame').replace(/[^\w-]/g, '_');
        let written = 0;
        for (let i = 0; i < n; i++) {
          if (cancelled) break;
          const blob = await api.captureAt(
            s + i / fps(),
            startFrame + i,
            1 / fps(),
            size!,
          );
          if (!blob) throw new Error(`第 ${i + 1} 帧捕获失败`);
          const b64 = await blobToBase64(blob);
          const name = `${pfx}_${String(i + 1).padStart(4, '0')}.png`;
          await writeBinaryFile(joinPath(outDir(), name), b64);
          written++;
          setDone(i + 1);
        }
        finish(
          true,
          cancelled
            ? `已取消：完成 ${written}/${n} 帧`
            : `已导出 ${n} 帧 PNG（${size!.width}×${size!.height}）→ ${outDir()}`,
        );
      } else if (format() === 'gif') {
        setPhase('frames');
        const out = await exportGif(
          api,
          {
            start: s,
            duration: dur,
            fps: effFps,
            width: size!.width,
            height: size!.height,
            maxColors: 256,
          },
          (d) => setDone(d),
          () => cancelled,
        );
        const b64 = await blobToBase64(out.blob);
        const name = `${(prefix().trim() || 'clip').replace(/[^\w-]/g, '_')}.gif`;
        await writeBinaryFile(joinPath(outDir(), name), b64);
        finish(
          true,
          cancelled
            ? `已取消：完成 ${out.totalFrames}/${n} 帧`
            : `已导出 GIF 动图（${size!.width}×${size!.height} · ${out.totalFrames} 帧 · ${effFps} FPS · 256 色/帧）→ ${outDir()}\\${name}`,
        );
      } else if (format() === 'mp4') {
        let pcm = null;
        if (includeAudio()) {
          setPhase('audio');
          pcm = await api.renderAudio(dur, 48000, () => cancelled, s);
          if (cancelled) {
            finish(true, '已取消音频合成');
            return;
          }
        }
        setPhase('frames');
        const out = await exportMp4(
          api,
          {
            start: s,
            duration: dur,
            fps: fps(),
            bitrate: bitrate(),
            width: size!.width,
            height: size!.height,
            audio: pcm,
            hasAudio: includeAudio(),
          },
          (d) => setDone(d),
          () => cancelled,
        );
        if (cancelled) {
          finish(true, `已取消：完成 ${out.totalFrames}/${n} 帧编码`);
        } else {
          const b64 = await blobToBase64(out.blob);
          const name = `${(prefix().trim() || 'clip').replace(/[^\w-]/g, '_')}.mp4`;
          await writeBinaryFile(joinPath(outDir(), name), b64);
          const audioNote = includeAudio()
            ? out.audioUsed
              ? '（含 mainSound AAC 音轨）'
              : '（无 Sound Pass 音轨）'
            : '（无声）';
          finish(
            true,
            `已导出 MP4（H.264）视频 ${audioNote}（${size!.width}×${size!.height} · ${out.totalFrames} 帧 · ${dur}s）→ ${outDir()}\\${name}`,
          );
        }
      } else if (format() === 'wav') {
        setPhase('audio');
        const pcm = await api.renderAudio(dur, 48000, () => cancelled);
        if (cancelled) {
          finish(true, '已取消音频合成');
        } else if (!pcm) {
          finish(false, '未找到 mainSound 音频代码（请编辑 Sound 标签页添加）');
        } else {
          const wav = pcmToWav(pcm);
          const b64 = await blobToBase64(wav);
          const name = `${(prefix().trim() || 'audio').replace(/[^\w-]/g, '_')}.wav`;
          await writeBinaryFile(joinPath(outDir(), name), b64);
          finish(true, `已导出 WAV 音频（${dur}s · 48kHz 立体声）→ ${outDir()}\\${name}`);
        }
      } else {
        const mime = pickVideoMime();
        if (!mime) {
          finish(false, '当前环境不支持视频编码（缺少 MediaRecorder 编码器）');
        } else {
          let pcm = null;
          if (includeAudio()) {
            setPhase('audio');
            pcm = await api.renderAudio(dur, 48000, () => cancelled, s);
            if (cancelled) {
              finish(true, '已取消音频合成');
              return;
            }
          }
          setPhase('frames');
          const opts: VideoExportOpts = {
            start: s,
            duration: dur,
            fps: fps(),
            bitrate: bitrate(),
            mime,
            width: size!.width,
            height: size!.height,
            audio: pcm,
            hasAudio: includeAudio(),
          };
          const out = await exportVideo(
            api,
            opts,
            (d) => setDone(d),
            () => cancelled,
          );
          if (cancelled) {
            finish(true, `已取消：完成 ${out.totalFrames}/${n} 帧编码`);
          } else {
            const b64 = await blobToBase64(out.blob);
            const name = `${(prefix().trim() || 'clip').replace(/[^\w-]/g, '_')}.webm`;
            await writeBinaryFile(joinPath(outDir(), name), b64);
            const audioNote = includeAudio()
              ? out.audioUsed
                ? '（含 mainSound 音轨）'
                : '（无 Sound Pass 音轨）'
              : '（无声）';
            finish(true, `已导出 ${describeMime(mime)} 视频 ${audioNote}（${size!.width}×${size!.height} · ${n} 帧 · ${dur}s）→ ${outDir()}\\${name}`);
          }
        }
      }
    } catch (e) {
      finish(false, `导出失败（已完成 ${done()}/${n} 帧）：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPhase('none');
      setRunning(false);
      try {
        if (format() !== 'wav') api.endCapture();
      } finally {
        if (wasRunning) api.play();
      }
    }
  };

  const pct = () => (total() > 0 ? Math.round((done() / total()) * 100) : 0);
  const eta = () => {
    if (phase() !== 'frames' || done() <= 0 || done() >= total()) return null;
    const elapsed = performance.now() - startedAt;
    const per = elapsed / done();
    return Math.max(0, Math.round((per * (total() - done())) / 1000));
  };

  return (
    <div
      class="modal-overlay"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (running()) cancelled = true;
        else props.onClose();
      }}
      onPointerDown={(e) => {
        if (!running() && e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        tabindex="-1"
      >
        <h3 id="export-dialog-title">导出 PNG / GIF / MP4 / WebM / WAV</h3>
        <div class="field-row">
          <label>格式</label>
          <select
            class="res-select"
            aria-label="导出格式"
            value={format()}
            onChange={(e) => {
              const v = e.currentTarget.value as 'png' | 'webm' | 'mp4' | 'gif' | 'wav';
              // 切到 GIF 时对齐 50 FPS 上限，切走时恢复 60
              if (v === 'gif' && fps() > GIF_MAX_FPS) setFps(GIF_MAX_FPS);
              if (v !== 'gif' && fps() === GIF_MAX_FPS) setFps(60);
              setFormat(v);
              setResult(null);
            }}
            disabled={running()}
          >
            <option value="png">PNG 序列帧</option>
            <option value="gif">GIF 动图（逐帧调色板）</option>
            <option value="mp4" disabled={!mp4Supported}>
              MP4 视频（H.264 · WebCodecs）
            </option>
            <option value="webm" disabled={!videoSupported()}>
              WebM 视频
            </option>
            <option value="wav">WAV 音频（mainSound）</option>
          </select>
        </div>
        <Show when={format() !== 'wav'}>
          <div class="field-row">
            <label>起始时间</label>
            <input
              class="text-input"
              aria-label="起始时间（秒）"
              value={start()}
              onInput={(e) => setStart(e.currentTarget.value)}
              disabled={running()}
            />
            <span class="field-unit">秒</span>
          </div>
        </Show>
        <div class="field-row">
          <label>时长</label>
          <input
            class="text-input"
            aria-label="导出时长（秒）"
            value={duration()}
            onInput={(e) => setDuration(e.currentTarget.value)}
            disabled={running()}
          />
          <span class="field-unit">秒</span>
        </div>
        <Show when={format() !== 'wav'}>
          <div class="field-row">
            <label>帧率</label>
            <select
              class="res-select"
              aria-label="导出帧率"
              value={fps()}
              onChange={(e) => setFps(Number(e.currentTarget.value))}
              disabled={running()}
            >
              {(
                [24, 30, 50, 60] as const
              ).map((f) => (
                <option value={f} disabled={f > GIF_MAX_FPS && format() === 'gif'}>
                  {f} FPS
                </option>
              ))}
            </select>
            {format() === 'gif' ? <span class="field-unit">浏览器帧延迟上限 50 FPS</span> : null}
          </div>
        </Show>
        <Show when={format() === 'png'}>
          <div class="field-row">
            <label>文件前缀</label>
            <input
              class="text-input"
              aria-label="文件前缀"
              value={prefix()}
              onInput={(e) => setPrefix(e.currentTarget.value)}
              disabled={running()}
            />
            <span class="field-unit">_0001.png 起</span>
          </div>
        </Show>
        <Show when={format() === 'wav'}>
          <div class="field-row">
            <label>文件前缀</label>
            <input
              class="text-input"
              aria-label="文件前缀"
              value={prefix()}
              onInput={(e) => setPrefix(e.currentTarget.value)}
              disabled={running()}
            />
            <span class="field-unit">.wav</span>
          </div>
        </Show>
        <Show when={format() === 'webm' || format() === 'mp4'}>
          <div class="field-row">
            <label>码率</label>
            <select
              class="res-select"
              aria-label="视频码率"
              value={bitrate()}
              onChange={(e) => setBitrate(Number(e.currentTarget.value))}
              disabled={running()}
            >
              {BITRATES.map((b) => (
                <option value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>
        </Show>
        <Show when={format() !== 'wav'}>
          <div class="field-row">
            <label>分辨率</label>
            <select
              class="res-select"
              aria-label="导出分辨率"
              value={resolution()}
              onChange={(e) => {
                setResolution(e.currentTarget.value);
                setResult(null);
              }}
              disabled={running()}
            >
              {RESOLUTIONS.map((r, i) => (
                <option value={String(i)}>{r.label}</option>
              ))}
              <option value={CUSTOM_RESOLUTION}>自定义…</option>
            </select>
          </div>
          <Show when={resolution() === CUSTOM_RESOLUTION}>
            <div class="field-row">
              <label>自定义</label>
              <div class="resolution-inputs">
                <input
                  type="number"
                  class="text-input"
                  aria-label="导出宽度"
                  min="1"
                  max={MAX_EXPORT_DIMENSION}
                  step="1"
                  value={customWidth()}
                  onInput={(e) => {
                    setCustomWidth(e.currentTarget.value);
                    setResult(null);
                  }}
                  disabled={running()}
                />
                <span aria-hidden="true">×</span>
                <input
                  type="number"
                  class="text-input"
                  aria-label="导出高度"
                  min="1"
                  max={MAX_EXPORT_DIMENSION}
                  step="1"
                  value={customHeight()}
                  onInput={(e) => {
                    setCustomHeight(e.currentTarget.value);
                    setResult(null);
                  }}
                  disabled={running()}
                />
                <span class="field-unit">px</span>
              </div>
            </div>
          </Show>
          <div class="field-hint export-size-hint">
            Shader 将按目标尺寸原生重渲染；最高约 8K。MP4/WebM 的宽高需为偶数且不小于 64。
          </div>
        </Show>
        <Show when={format() === 'webm' && videoSupported()}>
          <div class="menu-info" style="margin-top: 2px; padding: 0 4px">
            编码器：{describeMime(pickVideoMime()!)}（逐帧确定性捕获）
          </div>
        </Show>
        <Show when={format() === 'mp4'}>
          <div class="menu-info" style="margin-top: 2px; padding: 0 4px">
            编码器：H.264（WebCodecs）· 关键帧间隔 2s · AAC 音轨 48kHz
          </div>
        </Show>
        <Show when={format() === 'webm' || format() === 'mp4'}>
          <div class="field-row" style="margin-top: 6px">
            <label>包含音频</label>
            <label class="pass-toggle">
              <input
                type="checkbox"
                checked={includeAudio()}
                onChange={(e) => setIncludeAudio(e.currentTarget.checked)}
                disabled={running()}
              />
              <span>mainSound 合成音轨</span>
            </label>
          </div>
        </Show>
        <Show when={format() !== 'png' && format() !== 'wav'}>
          <div class="field-row" style="margin-top: 2px">
            <label>文件前缀</label>
            <input
              class="text-input"
              aria-label="文件前缀"
              value={prefix()}
              onInput={(e) => setPrefix(e.currentTarget.value)}
              disabled={running()}
            />
            <span class="field-unit">
              {format() === 'gif' ? '.gif' : format() === 'mp4' ? '.mp4' : '.webm'}
            </span>
          </div>
        </Show>
        <div class="field-row">
          <label>输出目录</label>
          <span class="dir-path">{outDir() || '未选择'}</span>
          <button class="btn" onClick={chooseDir} disabled={running()}>
            选择…
          </button>
        </div>
        <Show when={running()}>
          <Show
            when={phase() === 'audio'}
            fallback={
              <>
                <div
                  class="progress-track"
                  role="progressbar"
                  aria-label="导出进度"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow={pct()}
                >
                  <div class="progress-fill" style={{ width: `${pct()}%` }} />
                </div>
                <div class="progress-text">
                  {done()}/{total()} 帧（{pct()}%）
                  {eta() !== null ? ` · 预计剩余 ${eta()}s` : ''}
                </div>
              </>
            }
          >
            <div class="progress-text">合成音频（mainSound）… 可随时取消</div>
          </Show>
        </Show>
        <Show when={result()}>
          <div class="export-result" classList={{ err: !result()!.ok }} role="status">
            {result()!.text}
          </div>
        </Show>
        <div class="modal-actions">
          <Show
            when={!running()}
            fallback={
              <button class="btn danger" onClick={() => (cancelled = true)}>
                取消导出
              </button>
            }
          >
            <button class="btn primary" onClick={startExport}>
              开始导出
            </button>
            <button class="btn" onClick={() => props.onClose()}>
              关闭
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}