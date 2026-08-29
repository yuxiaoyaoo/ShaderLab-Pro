import { Show, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { t, type TranslationKey, type TranslationParams } from '../i18n';
import type { RuntimeApi } from '../shadertoy/runtime';
import { blobToBase64, pickFolder, writeBinaryFile } from '../project/bridge';
import { joinPath } from '../project/types';
import { pcmToWav } from '../export/wav';
import type { VideoExportOpts } from '../export/videoExport';
import {
  describeMime,
  isMp4ExportSupported,
  pickVideoMime,
} from '../export/videoExportCapabilities';
import type { ExportEligibility, ExportRequirements, ExportTicket } from '../export/exportEligibility';
import { formatProductMessageSummary } from '../productMessageFormatter';
import { normalizeProductMessage, ProductError, type ProductMessageDescriptor } from '../productMessage';
import ProductMessageView from './ProductMessageView';
import { useModalFocus } from './modalFocus';

interface Props {
  api: Accessor<RuntimeApi | null>;
  captureTicket: (requirements: ExportRequirements) => ExportEligibility;
  validateTicket: (ticket: ExportTicket) => ExportEligibility;
  onClose: () => void;
  onDone?: (msg: string, kind: 'ok' | 'error') => void;
}

const GIF_MAX_FPS = 50;
const clampGifFps = (fps: number) => Math.max(1, Math.min(GIF_MAX_FPS, Math.round(fps)));

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

type ProductMessage = {
  key: TranslationKey;
  params?: TranslationParams;
};

type ProductResult = ProductMessage & {
  ok: boolean;
  descriptor?: ProductMessageDescriptor;
};

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
  const [result, setResult] = createSignal<ProductResult | null>(null);
  const videoSupported = () => typeof MediaRecorder !== 'undefined' && !!pickVideoMime();
  const mp4Supported = isMp4ExportSupported();
  let cancelled = false;
  let ticketFailureReason: ProductMessageDescriptor | undefined;
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

  const validateOutputSize = (candidate?: OutputSize): OutputSize | ProductMessage => {
    const size = candidate ?? outputSize();
    if (!Number.isFinite(size.width) || !Number.isInteger(size.width)
      || !Number.isFinite(size.height) || !Number.isInteger(size.height)) {
      return { key: 'export.validation.integerDimensions' };
    }
    const isVideo = format() === 'webm' || format() === 'mp4';
    const min = isVideo ? 64 : format() === 'gif' ? 2 : 1;
    if (size.width < min || size.height < min) {
      return {
        key: isVideo
          ? 'export.validation.videoMinResolution'
          : 'export.validation.formatMinResolution',
        params: { min },
      };
    }
    if (size.width > MAX_EXPORT_DIMENSION || size.height > MAX_EXPORT_DIMENSION) {
      return { key: 'export.validation.maxDimension', params: { max: MAX_EXPORT_DIMENSION } };
    }
    if (size.width * size.height > MAX_EXPORT_PIXELS) {
      return { key: 'export.validation.maxPixels', params: { label: '8K', pixels: 3318 } };
    }
    if (isVideo && (size.width % 2 !== 0 || size.height % 2 !== 0)) {
      return { key: 'export.validation.evenVideoDimensions' };
    }
    return size;
  };

  const chooseDir = async () => {
    try {
      const pickerKey = format() === 'png'
        ? 'export.picker.pngDirectory'
        : format() === 'webm'
          ? 'export.picker.webmDirectory'
          : format() === 'mp4'
            ? 'export.picker.mp4Directory'
            : format() === 'gif'
              ? 'export.picker.gifDirectory'
              : 'export.picker.wavDirectory';
      const d = await pickFolder(t(pickerKey));
      if (d) {
        setOutDir(d);
        setResult(null);
      }
    } catch (error) {
      setResult({
        ok: false,
        key: 'export.error.chooseDirectory',
        descriptor: normalizeProductMessage(error, 'bridge.pick-folder-failed'),
      });
    }
  };

  const finish = (
    ok: boolean,
    key: TranslationKey,
    params?: TranslationParams,
    descriptor?: ProductMessageDescriptor,
  ) => {
    setResult({ ok, key, params, descriptor });
    const renderedParams = descriptor
      ? { ...params, detail: formatProductMessageSummary(descriptor) }
      : params;
    props.onDone?.(t(key, renderedParams), ok ? 'ok' : 'error');
  };

  const resultText = () => {
    const value = result();
    if (!value) return '';
    const params = value.descriptor
      ? { ...value.params, detail: formatProductMessageSummary(value.descriptor) }
      : value.params;
    return t(value.key, params);
  };

  const requestedDomains = (): ExportRequirements => ({
    visual: format() !== 'wav',
    sound: format() === 'wav' || ((format() === 'mp4' || format() === 'webm') && includeAudio()),
  });

  const startExport = async () => {
    if (running()) return;
    const captured = props.captureTicket(requestedDomains());
    if (!captured.eligible || !captured.ticket) {
      if (captured.reason) {
        setResult({
          ok: false,
          key: 'export.error.unavailable',
          descriptor: captured.reason,
        });
      } else {
        setResult({ ok: false, key: 'export.validation.domainUnavailable' });
      }
      return;
    }
    const exportTicket = captured.ticket;
    const api = props.api();
    if (!api) return;
    const s = Number.parseFloat(start());
    const dur = Number.parseFloat(duration());
    if (format() !== 'wav' && (!Number.isFinite(s) || s < 0)) {
      setResult({ ok: false, key: 'export.validation.startNonNegative' });
      return;
    }
    if (!Number.isFinite(dur) || dur <= 0) {
      setResult({ ok: false, key: 'export.validation.durationPositive' });
      return;
    }
    if (dur > 120 && (format() === 'wav'
      || ((format() === 'mp4' || format() === 'webm') && includeAudio()))) {
      setResult({ ok: false, key: 'export.validation.audioDurationLimit', params: { seconds: 120 } });
      return;
    }
    const sizeResult = format() === 'wav' ? null : validateOutputSize();
    if (sizeResult && 'key' in sizeResult) {
      setResult({ ok: false, ...sizeResult });
      return;
    }
    const size = sizeResult as OutputSize | null;
    if (!outDir()) {
      setResult({ ok: false, key: 'export.validation.outputDirectoryRequired' });
      return;
    }
    // GIF 帧延迟受浏览器 ≥20ms 限制，60 FPS 会自动钳制到 50。
    const effFps = format() === 'gif' ? clampGifFps(fps()) : fps();
    const requestedFrames = Math.max(1, Math.round(dur * effFps));
    if (format() !== 'wav' && requestedFrames > 3600) {
      setResult({ ok: false, key: 'export.validation.frameLimit', params: { max: 3600 } });
      return;
    }
    const n = format() === 'wav' ? 1 : requestedFrames;
    setTotal(n);
    setDone(0);
    setPhase('none');
    setResult(null);
    cancelled = false;
    ticketFailureReason = undefined;
    const guardCancelled = () => {
      if (!cancelled) {
        const guard = props.validateTicket(exportTicket);
        if (!guard.eligible) {
          ticketFailureReason = guard.reason ?? { code: 'export.ticket-expired' };
          cancelled = true;
        }
      }
      return cancelled;
    };
    const ensureTicket = () => {
      const guard = props.validateTicket(exportTicket);
      if (!guard.eligible) {
        ticketFailureReason = guard.reason ?? { code: 'export.ticket-expired' };
        cancelled = true;
        throw new ProductError(ticketFailureReason);
      }
    };
    const finishCancelled = (key: TranslationKey, params?: TranslationParams) => {
      if (ticketFailureReason) {
        finish(
          false,
          'export.status.abortedContentChanged',
          undefined,
          ticketFailureReason,
        );
      } else {
        finish(true, key, params);
      }
    };
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
          if (guardCancelled()) break;
          const blob = await api.captureAt(
            s + i / fps(),
            startFrame + i,
            1 / fps(),
            size!,
          );
          if (!blob) {
            throw new ProductError({ code: 'export.frame-capture-failed', params: { frame: i + 1 } });
          }
          const b64 = await blobToBase64(blob);
          ensureTicket();
          const name = `${pfx}_${String(i + 1).padStart(4, '0')}.png`;
          await writeBinaryFile(joinPath(outDir(), name), b64);
          written++;
          setDone(i + 1);
        }
        if (cancelled) {
          finishCancelled('export.status.cancelledFrames', { done: written, total: n });
        } else {
          finish(true, 'export.success.png', {
            frames: n,
            width: size!.width,
            height: size!.height,
            path: outDir(),
          });
        }
      } else if (format() === 'gif') {
        setPhase('frames');
        const { exportGif } = await import('../export/gifExport');
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
          guardCancelled,
        );
        const b64 = await blobToBase64(out.blob);
        ensureTicket();
        const name = `${(prefix().trim() || 'clip').replace(/[^\w-]/g, '_')}.gif`;
        await writeBinaryFile(joinPath(outDir(), name), b64);
        if (cancelled) {
          finishCancelled('export.status.cancelledFrames', { done: out.totalFrames, total: n });
        } else {
          finish(true, 'export.success.gif', {
            width: size!.width,
            height: size!.height,
            frames: out.totalFrames,
            fps: effFps,
            colors: 256,
            path: `${outDir()}\\${name}`,
          });
        }
      } else if (format() === 'mp4') {
        const { exportMp4 } = await import('../export/mp4Export');
        let pcm = null;
        if (includeAudio()) {
          setPhase('audio');
          pcm = await api.renderAudio(dur, 48000, guardCancelled, s);
          if (guardCancelled()) {
            finishCancelled('export.status.cancelledAudio');
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
          guardCancelled,
        );
        if (guardCancelled()) {
          finishCancelled('export.status.cancelledEncoding', {
            done: out.totalFrames,
            total: n,
          });
        } else {
          const b64 = await blobToBase64(out.blob);
          ensureTicket();
          const name = `${(prefix().trim() || 'clip').replace(/[^\w-]/g, '_')}.mp4`;
          await writeBinaryFile(joinPath(outDir(), name), b64);
          const successKey = includeAudio()
            ? out.audioUsed
              ? 'export.success.mp4.mainSoundAac'
              : 'export.success.mp4.noSoundPass'
            : 'export.success.mp4.muted';
          finish(true, successKey, {
            width: size!.width,
            height: size!.height,
            frames: out.totalFrames,
            duration: dur,
            path: `${outDir()}\\${name}`,
          });
        }
      } else if (format() === 'wav') {
        setPhase('audio');
        const pcm = await api.renderAudio(dur, 48000, guardCancelled);
        if (guardCancelled()) {
          finishCancelled('export.status.cancelledAudio');
        } else if (!pcm) {
          finish(false, 'export.error.noMainSound');
        } else {
          const wav = pcmToWav(pcm);
          const b64 = await blobToBase64(wav);
          ensureTicket();
          const name = `${(prefix().trim() || 'audio').replace(/[^\w-]/g, '_')}.wav`;
          await writeBinaryFile(joinPath(outDir(), name), b64);
          finish(true, 'export.success.wav', {
            duration: dur,
            sampleRate: '48kHz',
            path: `${outDir()}\\${name}`,
          });
        }
      } else {
        const mime = pickVideoMime();
        if (!mime) {
          finish(false, 'export.error.videoUnsupported');
        } else {
          let pcm = null;
          if (includeAudio()) {
            setPhase('audio');
            pcm = await api.renderAudio(dur, 48000, guardCancelled, s);
            if (guardCancelled()) {
              finishCancelled('export.status.cancelledAudio');
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
          const { exportVideo } = await import('../export/videoExport');
          const out = await exportVideo(
            api,
            opts,
            (d) => setDone(d),
            guardCancelled,
          );
          if (guardCancelled()) {
            finishCancelled('export.status.cancelledEncoding', {
              done: out.totalFrames,
              total: n,
            });
          } else {
            const b64 = await blobToBase64(out.blob);
            ensureTicket();
            const name = `${(prefix().trim() || 'clip').replace(/[^\w-]/g, '_')}.webm`;
            await writeBinaryFile(joinPath(outDir(), name), b64);
            const successKey = includeAudio()
              ? out.audioUsed
                ? 'export.success.webm.mainSound'
                : 'export.success.webm.noSoundPass'
              : 'export.success.webm.muted';
            finish(true, successKey, {
              codec: describeMime(mime),
              width: size!.width,
              height: size!.height,
              frames: n,
              duration: dur,
              path: `${outDir()}\\${name}`,
            });
          }
        }
      }
    } catch (error) {
      finish(
        false,
        'export.error.failed',
        { done: done(), total: n },
        normalizeProductMessage(error, 'export.failed'),
      );
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
        <h3 id="export-dialog-title">{t('export.title')}</h3>
        <div class="field-row">
          <label>{t('export.format')}</label>
          <select
            class="res-select"
            aria-label={t('export.format')}
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
            <option value="png">{t('export.format.png')}</option>
            <option value="gif">{t('export.format.gif')}</option>
            <option value="mp4" disabled={!mp4Supported}>
              {t('export.format.mp4')}
            </option>
            <option value="webm" disabled={!videoSupported()}>
              {t('export.format.webm')}
            </option>
            <option value="wav">{t('export.format.wav')}</option>
          </select>
        </div>
        <Show when={format() !== 'wav'}>
          <div class="field-row">
            <label>{t('export.startTime')}</label>
            <input
              class="text-input"
              aria-label={t('export.startTime')}
              value={start()}
              onInput={(e) => setStart(e.currentTarget.value)}
              disabled={running()}
            />
            <span class="field-unit">{t('export.secondsUnit')}</span>
          </div>
        </Show>
        <div class="field-row">
          <label>{t('export.duration')}</label>
          <input
            class="text-input"
            aria-label={t('export.duration')}
            value={duration()}
            onInput={(e) => setDuration(e.currentTarget.value)}
            disabled={running()}
          />
          <span class="field-unit">{t('export.secondsUnit')}</span>
        </div>
        <Show when={format() !== 'wav'}>
          <div class="field-row">
            <label>{t('export.frameRate')}</label>
            <select
              class="res-select"
              aria-label={t('export.frameRate')}
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
            {format() === 'gif'
              ? <span class="field-unit">{t('export.gif.maxFpsHint', { max: GIF_MAX_FPS })}</span>
              : null}
          </div>
        </Show>
        <Show when={format() === 'png'}>
          <div class="field-row">
            <label>{t('export.filePrefix')}</label>
            <input
              class="text-input"
              aria-label={t('export.filePrefix')}
              value={prefix()}
              onInput={(e) => setPrefix(e.currentTarget.value)}
              disabled={running()}
            />
            <span class="field-unit">
              {t('export.png.sequenceStartsAt', { file: '_0001.png' })}
            </span>
          </div>
        </Show>
        <Show when={format() === 'wav'}>
          <div class="field-row">
            <label>{t('export.filePrefix')}</label>
            <input
              class="text-input"
              aria-label={t('export.filePrefix')}
              value={prefix()}
              onInput={(e) => setPrefix(e.currentTarget.value)}
              disabled={running()}
            />
            <span class="field-unit">.wav</span>
          </div>
        </Show>
        <Show when={format() === 'webm' || format() === 'mp4'}>
          <div class="field-row">
            <label>{t('export.bitrate')}</label>
            <select
              class="res-select"
              aria-label={t('export.bitrate')}
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
            <label>{t('export.resolution')}</label>
            <select
              class="res-select"
              aria-label={t('export.resolution')}
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
              <option value={CUSTOM_RESOLUTION}>{t('common.custom')}</option>
            </select>
          </div>
          <Show when={resolution() === CUSTOM_RESOLUTION}>
            <div class="field-row">
              <label>{t('export.custom')}</label>
              <div class="resolution-inputs">
                <input
                  type="number"
                  class="text-input"
                  aria-label={t('export.width')}
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
                  aria-label={t('export.height')}
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
            {t('export.sizeHint')}
          </div>
        </Show>
        <Show when={format() === 'webm' && videoSupported()}>
          <div class="menu-info" style="margin-top: 2px; padding: 0 4px">
            {t('export.codec.webmInfo', { codec: describeMime(pickVideoMime()!) })}
          </div>
        </Show>
        <Show when={format() === 'mp4'}>
          <div class="menu-info" style="margin-top: 2px; padding: 0 4px">
            {t('export.codec.mp4Info', {
              codec: 'H.264',
              api: 'WebCodecs',
              keyframeInterval: '2s',
              audioCodec: 'AAC',
              sampleRate: '48kHz',
            })}
          </div>
        </Show>
        <Show when={format() === 'webm' || format() === 'mp4'}>
          <div class="field-row" style="margin-top: 6px">
            <label>{t('export.includeAudio')}</label>
            <label class="pass-toggle">
              <input
                type="checkbox"
                checked={includeAudio()}
                onChange={(e) => setIncludeAudio(e.currentTarget.checked)}
                disabled={running()}
              />
              <span>{t('export.audioTrack')}</span>
            </label>
          </div>
        </Show>
        <Show when={format() !== 'png' && format() !== 'wav'}>
          <div class="field-row" style="margin-top: 2px">
            <label>{t('export.filePrefix')}</label>
            <input
              class="text-input"
              aria-label={t('export.filePrefix')}
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
          <label>{t('export.outputDirectory')}</label>
          <span class="dir-path">{outDir() || t('export.notSelected')}</span>
          <button class="btn" onClick={chooseDir} disabled={running()}>
            {t('export.choose')}
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
                  aria-label={t('export.progress')}
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow={pct()}
                >
                  <div class="progress-fill" style={{ width: `${pct()}%` }} />
                </div>
                <div class="progress-text">
                  {t('export.progress.frames', {
                    done: done(),
                    total: total(),
                    percent: pct(),
                  })}
                  {eta() !== null
                    ? t('export.progress.eta', { seconds: eta()! })
                    : ''}
                </div>
              </>
            }
          >
            <div class="progress-text">{t('export.progress.audio')}</div>
          </Show>
        </Show>
        <Show when={result()}>
          {(value) => (
            <Show
              when={value().descriptor}
              fallback={(
                <div class="export-result" classList={{ err: !value().ok }} role="status">
                  {resultText()}
                </div>
              )}
            >
              {(descriptor) => (
                <ProductMessageView
                  class={`export-result${!value().ok ? ' err' : ''}`}
                  value={descriptor()}
                  summary={resultText()}
                  role="status"
                />
              )}
            </Show>
          )}
        </Show>
        <div class="modal-actions">
          <Show
            when={!running()}
            fallback={
              <button class="btn danger" onClick={() => (cancelled = true)}>
                {t('export.stop')}
              </button>
            }
          >
            <button class="btn primary" onClick={startExport}>
              {t('export.start')}
            </button>
            <button class="btn" onClick={() => props.onClose()}>
              {t('common.close')}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}