import { captureFrameNeedsReset, channelTextureRole, selectChannelTexture } from './channelTiming';
import type { PreviewResolution } from '../previewResolution';
import type { RuntimeUniform, UniformValue } from './uniforms';
import { ProductError, type ProductMessageParams } from '../productMessage';

export interface Diagnostic {
  line: number;
  column: number;
  /** Compatibility display fallback. UI consumers should prefer code/params/rawDetail. */
  message: string;
  code?: string;
  params?: ProductMessageParams;
  rawDetail?: string;
  stage?: 'glsl-compile' | 'runtime';
  pass?: string;
}

export interface RuntimeCompileTargets {
  visual: boolean;
  sound: boolean;
}

export interface CompileResult {
  /** Compatibility alias: visualOk when Visual was attempted, otherwise true. */
  ok: boolean;
  visualOk?: boolean;
  /** Present whenever Sound was attempted. */
  soundOk?: boolean;
  diagnostics: Diagnostic[];
}

export interface RuntimeStats {
  fps: number;
  time: number;
  frame: number;
  width: number;
  height: number;
  scale: number;
}

export type RenderPassId = 'bufferA' | 'bufferB' | 'bufferC' | 'bufferD' | 'image';
export type RuntimePassId = RenderPassId | 'sound';
type BufferPassId = Exclude<RenderPassId, 'image'>;

const BUFFER_ORDER: BufferPassId[] = ['bufferA', 'bufferB', 'bufferC', 'bufferD'];

export type RuntimeChannelCfg =
  | {
      index: number;
      type: 'buffer';
      src: BufferPassId;
      timing: 'current' | 'previous';
      filter: 'linear' | 'nearest';
      wrap: 'repeat' | 'clamp';
    }
  | {
      index: number;
      type: 'texture';
      src: string;
      filter: 'linear' | 'nearest';
      wrap: 'repeat' | 'clamp';
    }
  | {
      index: number;
      type: 'keyboard';
    }
  | {
      index: number;
      type: 'audio';
      src: string;
      filter: 'linear' | 'nearest';
      wrap: 'repeat' | 'clamp';
    };

export interface RuntimeTextureAsset {
  id: string;
  width: number;
  height: number;
  pixels?: Uint8Array | Uint8ClampedArray;
  source?: TexImageSource;
}

/** Music-file input for an iChannel: 512x2 R8 texture (row 0 = FFT, row 1 = waveform). */
export interface RuntimeAudioAsset {
  id: string;
  url: string;
}

export interface RuntimePassOpts {
  channels?: RuntimeChannelCfg[];
}

export interface RuntimeTimingPlan {
  /** Explicit topological order of enabled buffers for current-frame edges. */
  bufferOrder: BufferPassId[];
  revision: string;
}

export interface RuntimeSetup {
  sources: {
    common: string;
    image: string;
    bufferA?: string;
    bufferB?: string;
    bufferC?: string;
    bufferD?: string;
    sound?: string;
  };
  options?: Partial<Record<RuntimePassId, RuntimePassOpts>>;
  timingPlan?: RuntimeTimingPlan;
  textures?: RuntimeTextureAsset[];
  /** Music-file inputs referenced by 'audio' channels. Playback state lives in the runtime. */
  audio?: RuntimeAudioAsset[];
  uniforms?: RuntimeUniform[];
  /** Sound owns an independent uniform snapshot. Falls back to uniforms for legacy callers. */
  soundUniforms?: RuntimeUniform[];
}

export interface RuntimeFrameStep {
  pass: RenderPassId;
  channels: { slot: number; source: BufferPassId; texture: 'previous' | 'write' | 'current' }[];
}

/** Pure timing projection shared by tests and the WebGL executor. */
export function planRuntimeFrame(setup: Pick<RuntimeSetup, 'options' | 'timingPlan'>): RuntimeFrameStep[] {
  const order = setup.timingPlan?.bufferOrder ?? [];
  const steps: RuntimeFrameStep[] = order.map((pass) => ({
    pass,
    channels: (setup.options?.[pass]?.channels ?? []).filter((channel): channel is Extract<RuntimeChannelCfg, { type: 'buffer' }> => channel.type === 'buffer').map((channel) => ({
      slot: channel.index,
      source: channel.src,
      texture: channelTextureRole('buffer-before-flip', channel.timing),
    })),
  }));
  steps.push({
    pass: 'image',
    channels: (setup.options?.image?.channels ?? []).filter((channel): channel is Extract<RuntimeChannelCfg, { type: 'buffer' }> => channel.type === 'buffer').map((channel) => ({
      slot: channel.index,
      source: channel.src,
      texture: channelTextureRole('image-after-flip', channel.timing),
    })),
  });
  return steps;
}

export interface AudioPCM {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export interface PixelRGBA {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface CaptureSize {
  width: number;
  height: number;
}

export interface RuntimeApi {
  compile(setup: RuntimeSetup, targets?: RuntimeCompileTargets): CompileResult;
  play(): void;
  pause(): void;
  reset(): void;
  isRunning(): boolean;
  setSpeed(s: number): void;
  seek(t: number): void;
  /** 当前预览时间（秒）。 */
  getTime?(): number;
  /** Legacy development bridge. UI preview sizing uses setPreviewResolution. */
  setResolutionScale(s: number): void;
  setPreviewResolution(resolution: PreviewResolution): void;
  setPreviewTarget(t: RenderPassId): void;
  probePixel(target?: RenderPassId): PixelRGBA | null;
  captureAt(
    time: number,
    frameIndex: number,
    dt: number,
    size?: CaptureSize,
  ): Promise<Blob | null>;
  endCapture(): void;
  setUniform(name: string, value: UniformValue): void;
  /** Plays a music-file input bound to an 'audio' channel. No-op when the asset has no graph. */
  audioPlay?(assetId: string): void;
  audioPause?(assetId: string): void;
  audioSeekTo?(assetId: string, t: number): void;
  audioInfo?(
    assetId: string,
  ): { playing: boolean; currentTime: number; duration: number; failed: boolean } | null;
  renderAudio(
    durationSec: number,
    sampleRate?: number,
    isCancelled?: () => boolean,
    startSec?: number,
  ): Promise<AudioPCM | null>;
}

/// 全屏三角顶点着色器（M5：代码导出复用同一份源码）
export const VERT_SRC = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COPY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
    outColor = texture(uTex, gl_FragCoord.xy / vec2(textureSize(uTex, 0)));
}`;

const FRAG_HEADER = [
  '#version 300 es',
  'precision highp float;',
  '#define HW_PERFORMANCE 0',
  '',
  'uniform vec3 iResolution;',
  'uniform float iTime;',
  'uniform float iTimeDelta;',
  'uniform int iFrame;',
  'uniform vec4 iMouse;',
  'uniform vec4 iDate;',
  'uniform float iSampleRate;',
  'uniform sampler2D iChannel0;',
  'uniform sampler2D iChannel1;',
  'uniform sampler2D iChannel2;',
  'uniform sampler2D iChannel3;',
  'uniform vec3 iChannelResolution[4];',
  '',
  'out vec4 outColor;',
  '',
];

const FRAG_FOOTER = [
  '',
  'void main() {',
  '    mainImage(outColor, gl_FragCoord.xy);',
  '}',
];

const SOUND_PREAMBLE = [
  'uniform float u_offset;',
  'uniform float u_rate;',
];

const SOUND_FOOT_PRD = [
  '',
  'void main() {',
  '    float _idx = u_offset + gl_FragCoord.x;',
  '    float _tm = _idx / u_rate;',
  '    vec2 _s = clamp(mainSound(int(_idx), _tm), -1.0, 1.0);',
  '    outColor = vec4(_s * 0.5 + 0.5, 0.0, 1.0);',
  '}',
];

const SOUND_FOOT_ST = [
  '',
  'void main() {',
  '    float _idx = u_offset + gl_FragCoord.x;',
  '    vec4 _s;',
  '    mainSound(_s, vec2(_idx, u_rate));',
  '    outColor = vec4(clamp(_s.rg, -1.0, 1.0) * 0.5 + 0.5, 0.0, 1.0);',
  '}',
];

const HEADER_LINE_COUNT = FRAG_HEADER.length;
const ERROR_RE = /ERROR:\s*\d+:(\d+):\s*(.+)/g;

interface BufState {
  fbo: WebGLFramebuffer;
  tex: [WebGLTexture, WebGLTexture];
  read: 0 | 1;
  w: number;
  h: number;
}

interface TextureState {
  texture: WebGLTexture;
  width: number;
  height: number;
}

/** Per-asset audio playback + analysis graph. The 512x2 data texture is uploaded each frame. */
interface AudioGraph {
  el: HTMLAudioElement;
  analyser: AnalyserNode;
  freq: Uint8Array;
  wave: Uint8Array;
  data: Uint8Array;
  tex: WebGLTexture | null;
  failed: boolean;
}

type TextureChannelCfg = Extract<RuntimeChannelCfg, { type: 'texture' }>;
type VisualOptions = Partial<Record<RenderPassId, RuntimePassOpts>>;

interface VisualCompileCandidate {
  programs: Map<RenderPassId, WebGLProgram>;
  buffers: Map<BufferPassId, BufState>;
  previewBuffers: Map<BufferPassId, BufState> | null;
  textures: Map<string, TextureState>;
  audio: RuntimeAudioAsset[];
  options: VisualOptions;
  timingPlan: RuntimeTimingPlan;
  uniforms: Map<string, RuntimeUniform>;
}

interface SoundExecutionSnapshot {
  program: WebGLProgram | null;
  channels: TextureChannelCfg[];
  uniforms: Map<string, RuntimeUniform>;
  textures: Map<string, TextureState>;
  stStyle: boolean;
  retainCount: number;
  retired: boolean;
  destroyed: boolean;
}

interface CompilePreparation<T> {
  candidate: T | null;
  diagnostics: Diagnostic[];
}

function cloneUniformValue(value: UniformValue): UniformValue {
  return Array.isArray(value) ? [...value] : value;
}

function cloneUniformMap(uniforms: readonly RuntimeUniform[]): Map<string, RuntimeUniform> {
  return new Map(uniforms.map((uniform) => [uniform.name, {
    name: uniform.name,
    type: uniform.type,
    value: cloneUniformValue(uniform.value),
  }]));
}

function runtimeDiagnostic(
  code: string,
  message: string,
  pass: string,
  options: { params?: ProductMessageParams; rawDetail?: string; stage?: 'glsl-compile' | 'runtime' } = {},
): Diagnostic {
  return {
    line: 1,
    column: 1,
    message,
    code,
    pass,
    stage: options.stage ?? 'runtime',
    ...(options.params ? { params: options.params } : {}),
    ...(options.rawDetail ? { rawDetail: options.rawDetail } : {}),
  };
}

function rawError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableDiagnosticParams(params: ProductMessageParams | undefined): string {
  return params ? JSON.stringify(Object.entries(params).sort(([left], [right]) => left.localeCompare(right))) : '';
}

function uniqueDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.pass}|${diagnostic.line}|${diagnostic.column}|${diagnostic.stage ?? ''}|${diagnostic.code ?? ''}|${stableDiagnosticParams(diagnostic.params)}|${diagnostic.rawDetail ?? diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toNumArr(v: unknown, n: number): Float32Array {
  const arr = new Float32Array(n);
  if (Array.isArray(v)) {
    for (let i = 0; i < n; i++) arr[i] = Number(v[i]) || 0;
  }
  return arr;
}

export class ShadertoyRuntime implements RuntimeApi {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private vert: WebGLShader;
  private passes = new Map<RenderPassId, WebGLProgram>();
  private buffers = new Map<BufferPassId, BufState>();
  private textureAssets = new Map<string, TextureState>();
  private uniCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private options: VisualOptions = {};
  private timingPlan: RuntimeTimingPlan = { bufferOrder: [], revision: 'empty' };
  private samplers = new Map<string, WebGLSampler>();
  private previewTarget: RenderPassId = 'image';
  private copyProg: WebGLProgram;
  private dummyTex: WebGLTexture;
  private rafId = 0;
  private lastTick = 0;
  private time = 0;
  private frame = 0;
  private speed = 1;
  private running = false;
  private fpsEma = 60;
  private statTimer = 0;
  // Mouse coordinates are stored normalized so exports at another resolution
  // receive the same logical pointer position as the preview.
  private mouse = { x: 0, y: 0, z: 0, w: 0 };
  // Shadertoy-compatible keyboard state: a 256x2 R8 data texture.
  // Row 0 = key pressed this frame (pulse, cleared at frame end); row 1 = key currently held.
  private keyboardData = new Uint8Array(512);
  private keyboardTex: WebGLTexture | null = null;
  private keyboardActive = false;
  private keyboardHover = false;
  private keyboardDetach: (() => void) | null = null;
  // Shadertoy-compatible audio input: per-asset <audio> + AnalyserNode feeding a
  // 512x2 R8 texture. Row 0 = FFT (getByteFrequencyData), row 1 = waveform (getByteTimeDomainData).
  private audioGraphs = new Map<string, AudioGraph>();
  private audioCtx: AudioContext | null = null;
  private previewResolution: PreviewResolution = { mode: 'auto' };
  private legacyResolutionScale: number | null = null;
  private captureSize: CaptureSize | null = null;
  private previewBuffers: Map<BufferPassId, BufState> | null = null;
  private previewFrameTexture: WebGLTexture | null = null;
  private previewDisplaySnapshot: HTMLCanvasElement | null = null;
  private captureTarget: RenderPassId = 'image';
  private ro: ResizeObserver;
  private simFrame = -1;
  private simValid = false;
  private uniformVals = new Map<string, RuntimeUniform>();
  private soundSnapshot: SoundExecutionSnapshot = {
    program: null,
    channels: [],
    uniforms: new Map(),
    textures: new Map(),
    stStyle: false,
    retainCount: 0,
    retired: false,
    destroyed: false,
  };
  private retiredSoundSnapshots = new Set<SoundExecutionSnapshot>();
  private disposed = false;

  onStats: ((s: RuntimeStats) => void) | null = null;
  /** Fired when hover-driven keyboard capture arms or disarms. Armed only when the compiled setup declares a keyboard channel. */
  onKeyboardCapture: ((capturing: boolean) => void) | null = null;
  /** Fired once per audio asset when decoding/playback fails; the channel falls back to silence. */
  onAudioError: ((assetId: string) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new ProductError({ code: 'runtime.webgl2-unavailable' });
    this.gl = gl;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.vert = this.compileShader(gl.VERTEX_SHADER, VERT_SRC);
    this.copyProg = this.linkProgram(this.compileFragOnly(COPY_FRAG))!;

    this.dummyTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.attachMouse();
    this.attachKeyboard();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  private previewLimits(): { width: number; height: number } {
    const gl = this.gl;
    const maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || Infinity;
    const maxRenderbuffer = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || Infinity;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[] | null;
    return {
      width: Math.max(1, Math.min(maxTexture, maxRenderbuffer, Number(viewport?.[0]) || Infinity)),
      height: Math.max(1, Math.min(maxTexture, maxRenderbuffer, Number(viewport?.[1]) || Infinity)),
    };
  }

  private previewSize(): CaptureSize {
    if (this.previewResolution.mode === 'fixed') {
      return { width: this.previewResolution.width, height: this.previewResolution.height };
    }
    const rect = this.canvas.getBoundingClientRect();
    const density = this.legacyResolutionScale ?? Math.max(0.1, window.devicePixelRatio || 1);
    const requestedWidth = Math.max(1, Math.floor(rect.width * density));
    const requestedHeight = Math.max(1, Math.floor(rect.height * density));
    const limits = this.previewLimits();
    const fit = Math.min(1, limits.width / requestedWidth, limits.height / requestedHeight);
    return {
      width: Math.max(1, Math.floor(requestedWidth * fit)),
      height: Math.max(1, Math.floor(requestedHeight * fit)),
    };
  }

  private resize() {
    const size = this.captureSize ?? this.previewSize();
    const w = size.width;
    const h = size.height;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private destroyBuffers(buffers: Map<BufferPassId, BufState>) {
    for (const buffer of buffers.values()) this.destroyBuf(buffer);
    buffers.clear();
  }

  private snapshotPreviewFrame() {
    const gl = this.gl;
    const previousReadFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    gl.activeTexture(gl.TEXTURE0);
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const texture = gl.createTexture();
    if (!texture) throw new ProductError({ code: 'runtime.preview-snapshot-texture-failed' });
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        this.canvas.width,
        this.canvas.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.copyTexSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        0,
        0,
        this.canvas.width,
        this.canvas.height,
      );
      return texture;
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousReadFramebuffer);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture);
      gl.activeTexture(previousActiveTexture);
    }
  }

  private freezePreviewDisplay() {
    if (this.previewDisplaySnapshot) return;
    const parent = this.canvas.parentElement;
    if (!parent) throw new ProductError({ code: 'runtime.preview-freeze-container-missing' });

    const snapshot = document.createElement('canvas');
    try {
      snapshot.width = this.canvas.width;
      snapshot.height = this.canvas.height;
      const ctx = snapshot.getContext('2d');
      if (!ctx) throw new ProductError({ code: 'runtime.preview-snapshot-failed' });
      ctx.drawImage(this.canvas, 0, 0);
      snapshot.className = 'preview-capture-snapshot';
      snapshot.setAttribute('aria-hidden', 'true');
      const canvasRect = this.canvas.getBoundingClientRect();
      const parentRect = typeof parent.getBoundingClientRect === 'function'
        ? parent.getBoundingClientRect()
        : { left: 0, top: 0 };
      if (snapshot.style) {
        snapshot.style.left = `${canvasRect.left - parentRect.left}px`;
        snapshot.style.top = `${canvasRect.top - parentRect.top}px`;
        snapshot.style.right = 'auto';
        snapshot.style.bottom = 'auto';
        snapshot.style.width = `${canvasRect.width}px`;
        snapshot.style.height = `${canvasRect.height}px`;
      }
      parent.appendChild(snapshot);
      this.previewDisplaySnapshot = snapshot;
    } catch (error) {
      snapshot.remove();
      throw error;
    }
  }

  private releasePreviewDisplay() {
    try {
      this.previewDisplaySnapshot?.remove();
    } finally {
      this.previewDisplaySnapshot = null;
    }
  }

  private beginCapture(size: CaptureSize) {
    const next = {
      width: Math.max(1, Math.floor(size.width)),
      height: Math.max(1, Math.floor(size.height)),
    };
    const maxTexture = Number(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)) || 0;
    const maxRenderbuffer = Number(this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE)) || 0;
    const deviceLimit = Math.min(maxTexture || Infinity, maxRenderbuffer || Infinity);
    if (next.width > deviceLimit || next.height > deviceLimit) {
      throw new ProductError({
        code: 'runtime.capture-dimension-limit',
        params: { limit: deviceLimit },
      });
    }
    if (this.captureSize?.width === next.width && this.captureSize.height === next.height) return;

    // Keep the live preview textures intact. Exporting uses a separate buffer set,
    // otherwise changing resolution destroys the preview's feedback history.
    if (!this.captureSize) {
      const frameTexture = this.snapshotPreviewFrame();
      try {
        this.freezePreviewDisplay();
      } catch (error) {
        this.gl.deleteTexture(frameTexture);
        throw error;
      }
      this.previewFrameTexture = frameTexture;
      this.previewBuffers = this.buffers;
    } else {
      this.destroyBuffers(this.buffers);
    }
    this.buffers = new Map();
    this.captureSize = next;
    this.captureTarget = this.passes.has('image') ? 'image' : this.previewTarget;
    this.resize();
    this.rebuildBuffers();
    this.resetFeedback();
    this.simValid = false;
    this.simFrame = -1;
  }

  endCapture(): void {
    const previewFrameTexture = this.previewFrameTexture;
    this.previewFrameTexture = null;
    if (!this.captureSize) {
      try {
        if (previewFrameTexture) this.gl.deleteTexture(previewFrameTexture);
      } finally {
        this.releasePreviewDisplay();
      }
      return;
    }

    const captureBuffers = this.buffers;
    this.captureSize = null;
    this.buffers = this.previewBuffers ?? new Map();
    this.previewBuffers = null;
    this.captureTarget = 'image';
    this.simValid = false;
    this.simFrame = -1;
    try {
      this.destroyBuffers(captureBuffers);
      this.resize();
      this.rebuildBuffers();
      // Restore the exact paused image without executing Image or feedback passes.
      if (!this.running) {
        if (previewFrameTexture) {
          this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
          this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
          this.blit(previewFrameTexture);
        } else {
          this.present(0, this.previewTarget, new Date());
        }
      }
      this.emitStats();
    } finally {
      try {
        if (previewFrameTexture) this.gl.deleteTexture(previewFrameTexture);
      } finally {
        this.releasePreviewDisplay();
      }
    }
  }

  private attachMouse() {
    const c = this.canvas;
    const toNormalized = (e: PointerEvent) => {
      const rect = c.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / Math.max(rect.width, 1),
        y: 1 - (e.clientY - rect.top) / Math.max(rect.height, 1),
      };
    };
    c.addEventListener('pointermove', (e) => {
      const p = toNormalized(e);
      this.mouse.x = p.x;
      this.mouse.y = p.y;
      if (e.buttons & 1 && this.mouse.z > 0) {
        this.mouse.w = p.y;
      }
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = toNormalized(e);
      this.mouse.x = p.x;
      this.mouse.y = p.y;
      this.mouse.z = p.x;
      this.mouse.w = p.y;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      if (this.mouse.z > 0) {
        this.mouse.z = -this.mouse.z;
        this.mouse.w = -this.mouse.w;
      }
    });
  }

  private attachKeyboard() {
    const c = this.canvas;
    const capture = (e: KeyboardEvent, down: boolean) => {
      if (!this.keyboardActive || !this.keyboardHover || this.disposed) return;
      const code = e.keyCode;
      if (!Number.isInteger(code) || code < 0 || code > 255) return;
      if (down) {
        if (e.repeat) return;
        this.keyboardData[code] = 255;
        this.keyboardData[256 + code] = 255;
      } else {
        this.keyboardData[256 + code] = 0;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => capture(e, true);
    const onKeyUp = (e: KeyboardEvent) => capture(e, false);
    const releaseHeld = () => {
      for (let i = 256; i < 512; i++) this.keyboardData[i] = 0;
    };
    const onEnter = () => {
      this.keyboardHover = true;
      this.emitKeyboardCapture();
    };
    const onLeave = () => {
      if (!this.keyboardHover) return;
      this.keyboardHover = false;
      releaseHeld();
      this.emitKeyboardCapture();
    };
    const onBlur = () => {
      releaseHeld();
      this.keyboardData.fill(0, 0, 256);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    c.addEventListener('pointerenter', onEnter);
    c.addEventListener('pointerleave', onLeave);
    this.keyboardDetach = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      c.removeEventListener('pointerenter', onEnter);
      c.removeEventListener('pointerleave', onLeave);
    };
  }

  private emitKeyboardCapture() {
    if (this.keyboardActive) this.onKeyboardCapture?.(this.keyboardHover);
  }

  private applyKeyboardActivity(options: VisualOptions) {
    const active = Object.values(options).some((opts) => (opts.channels ?? []).some((channel) => channel.type === 'keyboard'));
    const changed = active !== this.keyboardActive;
    this.keyboardActive = active;
    if (active) this.ensureKeyboardTexture();
    if (changed) this.emitKeyboardCapture();
  }

  private ensureKeyboardTexture() {
    if (this.keyboardTex || this.disposed) return;
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new ProductError({ code: 'runtime.texture-upload-failed' });
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 2, 0, gl.RED, gl.UNSIGNED_BYTE, this.keyboardData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.keyboardTex = tex;
  }

  private uploadKeyboardState() {
    if (!this.keyboardTex) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.keyboardTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 2, gl.RED, gl.UNSIGNED_BYTE, this.keyboardData);
  }

  /** Syncs audio graphs with the compiled setup: creates missing, tears down unreferenced. */
  private applyAudioAssets(assets: readonly RuntimeAudioAsset[], options: VisualOptions) {
    const wanted = new Map<string, RuntimeAudioAsset>();
    for (const opts of Object.values(options)) {
      for (const channel of opts?.channels ?? []) {
        if (channel.type !== 'audio') continue;
        const asset = assets.find((entry) => entry.id === channel.src);
        if (asset) wanted.set(asset.id, asset);
      }
    }
    for (const id of [...this.audioGraphs.keys()]) {
      if (!wanted.has(id)) this.destroyAudioGraph(id);
    }
    for (const asset of wanted.values()) {
      let graph = this.audioGraphs.get(asset.id);
      if (!graph) {
        try {
          this.audioCtx ??= new AudioContext();
          const el = new Audio(asset.url);
          el.loop = true;
          el.preload = 'auto';
          const source = this.audioCtx.createMediaElementSource(el);
          const analyser = this.audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.8;
          source.connect(analyser);
          analyser.connect(this.audioCtx.destination);
          graph = {
            el,
            analyser,
            freq: new Uint8Array(analyser.frequencyBinCount),
            wave: new Uint8Array(analyser.fftSize),
            data: new Uint8Array(1024),
            tex: this.ensureAudioTexture(asset.id),
            failed: false,
          };
          graph.el.addEventListener('error', () => {
            if (graph && !graph.failed) {
              graph.failed = true;
              this.onAudioError?.(asset.id);
            }
          });
          this.audioGraphs.set(asset.id, graph);
          el.load();
        } catch (error) {
          this.onAudioError?.(asset.id);
          rawError(error);
        }
      } else if (graph.el.src !== asset.url) {
        graph.el.src = asset.url;
        graph.failed = false;
        graph.el.load();
      }
    }
  }

  private ensureAudioTexture(id: string): WebGLTexture | null {
    if (this.disposed) return null;
    const existing = this.audioGraphs.get(id)?.tex;
    if (existing) return existing;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 512, 2, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Per-frame audio texture refresh. Paused/failed graphs fall back to silence (row1=128). */
  private updateAudioTextures() {
    if (this.audioGraphs.size === 0) return;
    const gl = this.gl;
    for (const graph of this.audioGraphs.values()) {
      if (graph.failed || graph.el.paused || graph.el.ended) {
        graph.data.fill(0, 0, 512);
        graph.data.fill(128, 512, 1024);
      } else {
        graph.analyser.getByteFrequencyData(graph.freq);
        graph.analyser.getByteTimeDomainData(graph.wave);
        graph.data.set(graph.freq.subarray(0, 512), 0);
        for (let i = 0; i < 512; i++) graph.data[512 + i] = graph.wave[i * 2];
      }
      if (!graph.tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, graph.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RED, gl.UNSIGNED_BYTE, graph.data);
    }
  }

  private destroyAudioGraph(id: string) {
    const graph = this.audioGraphs.get(id);
    if (!graph) return;
    this.audioGraphs.delete(id);
    try {
      graph.el.pause();
      graph.el.removeAttribute('src');
      graph.el.load();
    } catch {
      // element already gone
    }
    const gl = this.gl;
    if (graph.tex) {
      gl.deleteTexture(graph.tex);
      graph.tex = null;
    }
  }

  private destroyAllAudioGraphs() {
    for (const id of [...this.audioGraphs.keys()]) this.destroyAudioGraph(id);
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }

  audioPlay(assetId: string): void {
    const graph = this.audioGraphs.get(assetId);
    if (!graph || graph.failed) return;
    this.audioCtx?.resume().catch(() => undefined);
    graph.el.play().catch(() => {
      graph.failed = true;
      this.onAudioError?.(assetId);
    });
  }

  audioPause(assetId: string): void {
    this.audioGraphs.get(assetId)?.el.pause();
  }

  audioSeekTo(assetId: string, t: number): void {
    const graph = this.audioGraphs.get(assetId);
    if (!graph) return;
    const duration = graph.el.duration;
    if (Number.isFinite(duration)) {
      graph.el.currentTime = Math.max(0, Math.min(t, duration));
    }
  }

  audioInfo(assetId: string): { playing: boolean; currentTime: number; duration: number; failed: boolean } | null {
    const graph = this.audioGraphs.get(assetId);
    if (!graph) return null;
    return {
      playing: !graph.el.paused && !graph.el.ended,
      currentTime: graph.el.currentTime,
      duration: Number.isFinite(graph.el.duration) ? graph.el.duration : 0,
      failed: graph.failed,
    };
  }

  setUniform(name: string, value: UniformValue): void {
    const visual = this.uniformVals.get(name);
    if (visual) this.uniformVals.set(name, { ...visual, value: cloneUniformValue(value) });
    const sound = this.soundSnapshot.uniforms.get(name);
    if (sound) this.soundSnapshot.uniforms.set(name, { ...sound, value: cloneUniformValue(value) });
  }

  compile(setup: RuntimeSetup, targets?: RuntimeCompileTargets): CompileResult {
    const requested = targets ?? { visual: true, sound: true };
    const diagnostics: Diagnostic[] = [];
    if (this.disposed) {
      const disposedDiagnostic = runtimeDiagnostic('runtime.disposed', 'Runtime 已释放', 'runtime');
      return {
        ok: requested.visual ? false : true,
        ...(requested.visual ? { visualOk: false } : {}),
        ...(requested.sound ? { soundOk: false } : {}),
        diagnostics: requested.visual || requested.sound ? [disposedDiagnostic] : [],
      };
    }

    let visual: CompilePreparation<VisualCompileCandidate> | null = null;
    let sound: CompilePreparation<SoundExecutionSnapshot> | null = null;
    if (requested.visual) {
      try {
        visual = this.prepareVisual(setup);
      } catch (error) {
        visual = {
          candidate: null,
          diagnostics: [runtimeDiagnostic('runtime.visual-prepare-failed', 'Visual 编译准备失败', 'image', { rawDetail: rawError(error) })],
        };
      }
    }
    if (requested.sound) {
      try {
        sound = this.prepareSound(setup);
      } catch (error) {
        sound = {
          candidate: null,
          diagnostics: [runtimeDiagnostic('runtime.sound-prepare-failed', 'Sound 编译准备失败', 'sound', { rawDetail: rawError(error) })],
        };
      }
    }
    if (visual) diagnostics.push(...visual.diagnostics);
    if (sound) diagnostics.push(...sound.diagnostics);

    const visualOk = visual?.candidate != null;
    const soundOk = sound?.candidate != null;
    if (visual?.candidate) this.commitVisual(visual.candidate);
    if (sound?.candidate) this.commitSound(sound.candidate);

    return {
      ok: requested.visual ? visualOk : true,
      ...(requested.visual ? { visualOk } : {}),
      ...(requested.sound ? { soundOk } : {}),
      diagnostics: uniqueDiagnostics(diagnostics),
    };
  }

  private prepareVisual(setup: RuntimeSetup): CompilePreparation<VisualCompileCandidate> {
    const gl = this.gl;
    const commonText = setup.sources.common ?? '';
    const commonSourceLines = commonText ? commonText.split('\n') : [];
    const commonLines = commonSourceLines.length;
    const userOffset = HEADER_LINE_COUNT + commonLines;
    const diagnostics: Diagnostic[] = [];
    const programs = new Map<RenderPassId, WebGLProgram>();
    let textures = new Map<string, TextureState>();
    let buffers = new Map<BufferPassId, BufState>();
    let previewBuffers: Map<BufferPassId, BufState> | null = null;

    try {
      for (const id of [...BUFFER_ORDER, 'image'] as RenderPassId[]) {
        const source = setup.sources[id];
        if (typeof source !== 'string' || source === '') continue;
        const full = [
          ...FRAG_HEADER,
          ...commonSourceLines,
          ...source.split('\n'),
          ...FRAG_FOOTER,
        ].join('\n');
        const fragment = this.compileShader(gl.FRAGMENT_SHADER, full);
        if (typeof fragment === 'string') {
          diagnostics.push(...this.parseErrors(fragment, userOffset, commonLines > 0, id));
          continue;
        }
        const program = this.linkProgram(fragment);
        gl.deleteShader(fragment);
        if (!program) {
          diagnostics.push(runtimeDiagnostic('runtime.program-link-failed', 'program link failed', id, { params: { pass: id } }));
          continue;
        }
        this.initializeChannelUniforms(program);
        programs.set(id, program);
      }

      if (!programs.has('image')) {
        diagnostics.push(runtimeDiagnostic('runtime.image-source-missing', '缺少 Image Pass 源码', 'image'));
      }
      const enabledBuffers = BUFFER_ORDER.filter((pass) => programs.has(pass));
      const plannedBuffers = setup.timingPlan?.bufferOrder ?? [];
      const planValid = plannedBuffers.length === enabledBuffers.length
        && new Set(plannedBuffers).size === plannedBuffers.length
        && plannedBuffers.every((pass) => enabledBuffers.includes(pass));
      if (!planValid) {
        diagnostics.push(runtimeDiagnostic('runtime.timing-plan-invalid', 'Runtime setup 缺少与启用 Buffer 一致的 resolved timing plan', 'image'));
      }

      const catalog = this.buildTextureCatalog(setup.textures ?? []);
      const textureInputs = new Map<string, RuntimeTextureAsset>();
      const options: VisualOptions = {};
      for (const pass of [...enabledBuffers, 'image'] as RenderPassId[]) {
        const channels: RuntimeChannelCfg[] = [];
        const usedSlots = new Set<number>();
        for (const channel of setup.options?.[pass]?.channels ?? []) {
          const validCommon = Number.isInteger(channel.index)
            && channel.index >= 0
            && channel.index <= 3
            && !usedSlots.has(channel.index);
          const validSampling = channel.type === 'keyboard'
            || ((channel.filter === 'linear' || channel.filter === 'nearest')
              && (channel.wrap === 'repeat' || channel.wrap === 'clamp'));
          usedSlots.add(channel.index);
          let validSource = false;
          if (channel.type === 'buffer') {
            validSource = (channel.timing === 'current' || channel.timing === 'previous')
              && enabledBuffers.includes(channel.src);
          } else if (channel.type === 'texture') {
            // 纹理资产缺失（含 `missing:` 占位或资产被删除）→ 通道降级为 dummyTex 静默数据，不阻断编译
            const asset = this.resolveTextureAsset(catalog, channel.src);
            validSource = true;
            if (asset) textureInputs.set(asset.id, asset);
          } else if (channel.type === 'keyboard') {
            validSource = true;
          } else if (channel.type === 'audio') {
            // 音频资产缺失 → 通道降级为静音纹理，不阻断编译
            validSource = true;
          }
          if (!validCommon || !validSampling || !validSource) {
            diagnostics.push(runtimeDiagnostic('runtime.channel-plan-invalid', `${pass} 包含未解析、slot 冲突或来源无效的 channel plan`, pass, { params: { pass } }));
            continue;
          }
          channels.push({ ...channel });
        }
        options[pass] = { channels };
      }

      const unique = uniqueDiagnostics(diagnostics);
      if (unique.length > 0) {
        this.destroyPrograms(programs);
        return { candidate: null, diagnostics: unique };
      }

      try {
        textures = this.uploadTextureAssets(textureInputs.values());
      } catch (error) {
        this.destroyPrograms(programs);
        return {
          candidate: null,
          diagnostics: [runtimeDiagnostic('runtime.texture-upload-failed', '纹理上传失败', 'image', { rawDetail: rawError(error) })],
        };
      }

      try {
        this.resize();
        for (const pass of enabledBuffers) buffers.set(pass, this.createBuf(this.canvas.width, this.canvas.height));
        if (this.captureSize) {
          previewBuffers = new Map();
          const previousPreviewBuffer = this.previewBuffers?.values().next().value as BufState | undefined;
          const preview = this.previewSize();
          const previewWidth = previousPreviewBuffer?.w ?? preview.width;
          const previewHeight = previousPreviewBuffer?.h ?? preview.height;
          for (const pass of enabledBuffers) previewBuffers.set(pass, this.createBuf(previewWidth, previewHeight));
        }
      } catch (error) {
        this.destroyBuffers(buffers);
        if (previewBuffers) this.destroyBuffers(previewBuffers);
        this.destroyTextureMap(textures);
        this.destroyPrograms(programs);
        return {
          candidate: null,
          diagnostics: [runtimeDiagnostic('runtime.visual-resources-failed', 'Visual 资源准备失败', 'image', { rawDetail: rawError(error) })],
        };
      }

      return {
        candidate: {
          programs,
          buffers,
          previewBuffers,
          textures,
          audio: [...(setup.audio ?? [])],
          options,
          timingPlan: setup.timingPlan
            ? { bufferOrder: [...setup.timingPlan.bufferOrder], revision: setup.timingPlan.revision }
            : { bufferOrder: [], revision: 'empty' },
          uniforms: cloneUniformMap(setup.uniforms ?? []),
        },
        diagnostics: [],
      };
    } catch (error) {
      this.destroyBuffers(buffers);
      if (previewBuffers) this.destroyBuffers(previewBuffers);
      this.destroyTextureMap(textures);
      this.destroyPrograms(programs);
      return {
        candidate: null,
        diagnostics: [runtimeDiagnostic('runtime.visual-prepare-failed', 'Visual 编译准备失败', 'image', { rawDetail: rawError(error) })],
      };
    }
  }

  private prepareSound(setup: RuntimeSetup): CompilePreparation<SoundExecutionSnapshot> {
    const gl = this.gl;
    const soundSource = setup.sources.sound;
    const uniforms = cloneUniformMap(setup.soundUniforms ?? setup.uniforms ?? []);
    if (typeof soundSource !== 'string' || soundSource.trim() === '') {
      return {
        candidate: {
          program: null,
          channels: [],
          uniforms,
          textures: new Map(),
          stStyle: false,
          retainCount: 0,
          retired: false,
          destroyed: false,
        },
        diagnostics: [],
      };
    }

    const commonText = setup.sources.common ?? '';
    const commonSourceLines = commonText ? commonText.split('\n') : [];
    const commonLines = commonSourceLines.length;
    const userOffset = HEADER_LINE_COUNT + commonLines + SOUND_PREAMBLE.length;
    const diagnostics: Diagnostic[] = [];
    const isSt = /\bvoid\s+mainSound\s*\(/.test(soundSource) && !/\bvec2\s+mainSound\s*\(/.test(soundSource);
    let program: WebGLProgram | null = null;
    let textures = new Map<string, TextureState>();

    try {
      const full = [
        ...FRAG_HEADER,
        ...commonSourceLines,
        ...SOUND_PREAMBLE,
        ...soundSource.split('\n'),
        ...(isSt ? SOUND_FOOT_ST : SOUND_FOOT_PRD),
      ].join('\n');
      const fragment = this.compileShader(gl.FRAGMENT_SHADER, full);
      if (typeof fragment === 'string') {
        diagnostics.push(...this.parseErrors(fragment, userOffset, commonLines > 0, 'sound'));
      } else {
        program = this.linkProgram(fragment);
        gl.deleteShader(fragment);
        if (!program) diagnostics.push(runtimeDiagnostic('runtime.program-link-failed', 'program link failed', 'sound', { params: { pass: 'sound' } }));
        else this.initializeChannelUniforms(program);
      }

      const catalog = this.buildTextureCatalog(setup.textures ?? []);
      const textureInputs = new Map<string, RuntimeTextureAsset>();
      const channels: TextureChannelCfg[] = [];
      const usedSlots = new Set<number>();
      for (const channel of setup.options?.sound?.channels ?? []) {
        const validCommon = Number.isInteger(channel.index)
          && channel.index >= 0
          && channel.index <= 3
          && channel.type === 'texture'
          && (channel.filter === 'linear' || channel.filter === 'nearest')
          && (channel.wrap === 'repeat' || channel.wrap === 'clamp')
          && !usedSlots.has(channel.index);
        usedSlots.add(channel.index);
        const asset = channel.type === 'texture' ? this.resolveTextureAsset(catalog, channel.src) : null;
        if (!validCommon || channel.type !== 'texture' || !asset) {
          diagnostics.push(runtimeDiagnostic('runtime.sound-channel-invalid', 'sound 仅允许已解析且 slot 唯一的 texture channel', 'sound'));
          continue;
        }
        textureInputs.set(asset.id, asset);
        channels.push({ ...channel });
      }

      const unique = uniqueDiagnostics(diagnostics);
      if (unique.length > 0 || !program) {
        if (program) this.destroyProgram(program);
        return {
          candidate: null,
          diagnostics: unique.length > 0 ? unique : [runtimeDiagnostic('runtime.sound-program-unavailable', 'Sound program unavailable', 'sound')],
        };
      }

      try {
        textures = this.uploadTextureAssets(textureInputs.values());
      } catch (error) {
        this.destroyProgram(program);
        return {
          candidate: null,
          diagnostics: [runtimeDiagnostic('runtime.sound-texture-upload-failed', 'Sound 纹理上传失败', 'sound', { rawDetail: rawError(error) })],
        };
      }

      return {
        candidate: {
          program,
          channels,
          uniforms,
          textures,
          stStyle: isSt,
          retainCount: 0,
          retired: false,
          destroyed: false,
        },
        diagnostics: [],
      };
    } catch (error) {
      if (program) this.destroyProgram(program);
      this.destroyTextureMap(textures);
      return {
        candidate: null,
        diagnostics: [runtimeDiagnostic('runtime.sound-prepare-failed', 'Sound 编译准备失败', 'sound', { rawDetail: rawError(error) })],
      };
    }
  }

  private initializeChannelUniforms(program: WebGLProgram) {
    const gl = this.gl;
    gl.useProgram(program);
    for (let index = 0; index < 4; index++) {
      const location = gl.getUniformLocation(program, `iChannel${index}`);
      if (location) gl.uniform1i(location, index);
    }
  }

  private buildTextureCatalog(assets: readonly RuntimeTextureAsset[]): Map<string, RuntimeTextureAsset[]> {
    const catalog = new Map<string, RuntimeTextureAsset[]>();
    for (const asset of assets) {
      const matches = catalog.get(asset.id) ?? [];
      matches.push(asset);
      catalog.set(asset.id, matches);
    }
    return catalog;
  }

  private resolveTextureAsset(catalog: Map<string, RuntimeTextureAsset[]>, id: string): RuntimeTextureAsset | null {
    const matches = catalog.get(id);
    if (!id || !matches || matches.length !== 1) return null;
    const asset = matches[0];
    if (!Number.isInteger(asset.width) || asset.width < 1 || !Number.isInteger(asset.height) || asset.height < 1) return null;
    if (!asset.pixels && !asset.source) return null;
    if (asset.pixels && asset.pixels.length !== asset.width * asset.height * 4) return null;
    return asset;
  }

  private commitVisual(candidate: VisualCompileCandidate) {
    const oldPrograms = this.passes;
    const oldBuffers = this.buffers;
    const oldPreviewBuffers = this.previewBuffers;
    const oldTextures = this.textureAssets;
    this.passes = candidate.programs;
    this.buffers = candidate.buffers;
    if (this.captureSize) this.previewBuffers = candidate.previewBuffers ?? new Map();
    this.textureAssets = candidate.textures;
    this.options = candidate.options;
    this.timingPlan = candidate.timingPlan;
    this.applyKeyboardActivity(candidate.options);
    this.applyAudioAssets(candidate.audio, candidate.options);
    this.uniformVals = candidate.uniforms;
    this.simValid = false;
    this.simFrame = -1;
    this.destroyPrograms(oldPrograms);
    this.destroyBuffers(oldBuffers);
    if (oldPreviewBuffers && oldPreviewBuffers !== oldBuffers) this.destroyBuffers(oldPreviewBuffers);
    this.destroyTextureMap(oldTextures);
  }

  private commitSound(candidate: SoundExecutionSnapshot) {
    const previous = this.soundSnapshot;
    this.soundSnapshot = candidate;
    this.retireSoundSnapshot(previous);
  }

  private destroyProgram(program: WebGLProgram) {
    this.uniCache.delete(program);
    this.gl.deleteProgram(program);
  }

  private destroyPrograms(programs: Map<RenderPassId, WebGLProgram>) {
    for (const program of programs.values()) this.destroyProgram(program);
    programs.clear();
  }

  private destroyTextureMap(textures: Map<string, TextureState>) {
    for (const state of textures.values()) this.gl.deleteTexture(state.texture);
    textures.clear();
  }

  private retireSoundSnapshot(snapshot: SoundExecutionSnapshot) {
    snapshot.retired = true;
    if (snapshot.retainCount > 0) {
      this.retiredSoundSnapshots.add(snapshot);
      return;
    }
    this.destroySoundSnapshot(snapshot);
  }

  private destroySoundSnapshot(snapshot: SoundExecutionSnapshot) {
    if (snapshot.destroyed) return;
    snapshot.destroyed = true;
    this.retiredSoundSnapshots.delete(snapshot);
    if (snapshot.program) this.destroyProgram(snapshot.program);
    snapshot.program = null;
    this.destroyTextureMap(snapshot.textures);
  }

  private retainSoundSnapshot(snapshot: SoundExecutionSnapshot) {
    snapshot.retainCount += 1;
  }

  private releaseSoundSnapshot(snapshot: SoundExecutionSnapshot) {
    snapshot.retainCount = Math.max(0, snapshot.retainCount - 1);
    if (snapshot.retired && snapshot.retainCount === 0) this.destroySoundSnapshot(snapshot);
  }

  private compileShader(type: number, src: string): WebGLShader | string {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || 'compile failed';
      gl.deleteShader(sh);
      return log;
    }
    return sh;
  }

  private compileFragOnly(src: string): WebGLShader {
    const r = this.compileShader(this.gl.FRAGMENT_SHADER, src);
    if (typeof r === 'string') throw new Error(r);
    return r;
  }

  private linkProgram(frag: WebGLShader): WebGLProgram | null {
    const gl = this.gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  private parseErrors(log: string, offset: number, hasCommon: boolean, passId: string): Diagnostic[] {
    const out: Diagnostic[] = [];
    let m: RegExpExecArray | null;
    ERROR_RE.lastIndex = 0;
    while ((m = ERROR_RE.exec(log))) {
      const absLine = parseInt(m[1], 10);
      if (hasCommon && absLine <= offset && absLine > HEADER_LINE_COUNT) {
        const rawDetail = m[2].trim();
        out.push({
          line: absLine - HEADER_LINE_COUNT,
          column: 1,
          message: rawDetail,
          code: 'runtime.glsl-compile-failed',
          params: { pass: 'common' },
          rawDetail,
          stage: 'glsl-compile',
          pass: 'common',
        });
      } else {
        const userLine = absLine - offset;
        const rawDetail = m[2].trim();
        out.push({
          line: userLine >= 1 ? userLine : absLine,
          column: 1,
          message: rawDetail,
          code: 'runtime.glsl-compile-failed',
          params: { pass: passId },
          rawDetail,
          stage: 'glsl-compile',
          pass: passId,
        });
      }
    }
    if (!out.length) {
      const rawDetail = log.trim();
      out.push({
        line: 1,
        column: 1,
        message: rawDetail,
        code: 'runtime.glsl-compile-failed',
        params: { pass: passId },
        rawDetail,
        stage: 'glsl-compile',
        pass: passId,
      });
    }
    return out;
  }

  private u(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let cache = this.uniCache.get(prog);
    if (!cache) {
      cache = new Map();
      this.uniCache.set(prog, cache);
    }
    if (!cache.has(name)) {
      cache.set(name, this.gl.getUniformLocation(prog, name));
    }
    return cache.get(name)!;
  }

  private uploadTextureAssets(assets: Iterable<RuntimeTextureAsset>): Map<string, TextureState> {
    const gl = this.gl;
    const uploaded = new Map<string, TextureState>();
    let pendingTexture: WebGLTexture | null = null;
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    try {
      for (const asset of assets) {
        const texture = gl.createTexture();
        if (!texture) throw new ProductError({
          code: 'runtime.texture-create-failed',
          params: { id: asset.id },
        });
        pendingTexture = texture;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        if (asset.pixels) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, asset.width, asset.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, asset.pixels);
        } else if (asset.source) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, asset.source);
        } else {
          throw new ProductError({
            code: 'runtime.texture-source-missing',
            params: { id: asset.id },
          });
        }
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        uploaded.set(asset.id, { texture, width: asset.width, height: asset.height });
        pendingTexture = null;
      }
      return uploaded;
    } catch (error) {
      if (pendingTexture) gl.deleteTexture(pendingTexture);
      for (const asset of uploaded.values()) gl.deleteTexture(asset.texture);
      throw error;
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    }
  }

  private rebuildBuffers() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    for (const bid of BUFFER_ORDER) {
      if (!this.passes.has(bid)) continue;
      const b = this.buffers.get(bid);
      if (!b || b.w !== w || b.h !== h) {
        if (b) this.destroyBuf(b);
        this.buffers.set(bid, this.createBuf(w, h));
      }
    }
    for (const [bid, b] of [...this.buffers]) {
      if (!this.passes.has(bid)) {
        this.destroyBuf(b);
        this.buffers.delete(bid);
      }
    }
  }

  private createBuf(w: number, h: number): BufState {
    const gl = this.gl;
    const textures: WebGLTexture[] = [];
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new ProductError({ code: 'runtime.feedback-framebuffer-failed' });
    try {
      const makeTexture = () => {
        const texture = gl.createTexture();
        if (!texture) throw new ProductError({ code: 'runtime.feedback-texture-failed' });
        textures.push(texture);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
      };
      return { fbo, tex: [makeTexture(), makeTexture()], read: 1, w, h };
    } catch (error) {
      gl.deleteFramebuffer(fbo);
      for (const texture of textures) gl.deleteTexture(texture);
      throw error;
    }
  }

  private destroyBuf(b: BufState) {
    const gl = this.gl;
    gl.deleteFramebuffer(b.fbo);
    gl.deleteTexture(b.tex[0]);
    gl.deleteTexture(b.tex[1]);
  }

  private resetFeedback() {
    const gl = this.gl;
    for (const b of this.buffers.values()) {
      for (const t of b.tex) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, b.w, b.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      b.read = 1;
    }
  }

  private sampler(filter: 'linear' | 'nearest', wrap: 'repeat' | 'clamp'): WebGLSampler {
    const key = `${filter}:${wrap}`;
    const cached = this.samplers.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const sampler = gl.createSampler();
    if (!sampler) throw new ProductError({ code: 'runtime.sampler-create-failed' });
    const filtering = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    const wrapping = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filtering);
    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filtering);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, wrapping);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, wrapping);
    this.samplers.set(key, sampler);
    return sampler;
  }

  private bindChannels(passId: RenderPassId, phase: 'buffer' | 'image'): [number, number][] {
    const gl = this.gl;
    const channels = this.options?.[passId]?.channels ?? [];
    const bound: (WebGLTexture | null)[] = [null, null, null, null];
    const samplers: (WebGLSampler | null)[] = [null, null, null, null];
    const dimensions: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
    for (const channel of channels) {
      const slot = Math.max(0, Math.min(3, Math.round(channel.index)));
      if (channel.type === 'buffer') {
        const source = this.buffers.get(channel.src);
        if (!source) continue;
        const textureIndex = selectChannelTexture(phase === 'buffer' ? 'buffer-before-flip' : 'image-after-flip', channel.timing, source.read).textureIndex;
        bound[slot] = source.tex[textureIndex];
        dimensions[slot] = [source.w, source.h];
      } else if (channel.type === 'texture') {
        const source = this.textureAssets.get(channel.src);
        if (!source) continue;
        bound[slot] = source.texture;
        dimensions[slot] = [source.width, source.height];
      } else if (channel.type === 'keyboard') {
        if (!this.keyboardTex) continue;
        bound[slot] = this.keyboardTex;
        dimensions[slot] = [256, 2];
        samplers[slot] = this.sampler('nearest', 'clamp');
        continue;
      } else if (channel.type === 'audio') {
        const graph = this.audioGraphs.get(channel.src);
        if (!graph || !graph.tex) continue;
        bound[slot] = graph.tex;
        dimensions[slot] = [512, 2];
        samplers[slot] = this.sampler(channel.filter, channel.wrap);
        continue;
      }
      samplers[slot] = this.sampler(channel.filter, channel.wrap);
    }
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, bound[i] ?? this.dummyTex);
      gl.bindSampler(i, samplers[i]);
    }
    return dimensions;
  }

  private bindSoundChannels(snapshot: SoundExecutionSnapshot): [number, number][] {
    const gl = this.gl;
    const bound: (WebGLTexture | null)[] = [null, null, null, null];
    const samplers: (WebGLSampler | null)[] = [null, null, null, null];
    const dimensions: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
    for (const channel of snapshot.channels) {
      const source = snapshot.textures.get(channel.src);
      if (!source) continue;
      const slot = channel.index;
      bound[slot] = source.texture;
      dimensions[slot] = [source.width, source.height];
      samplers[slot] = this.sampler(channel.filter, channel.wrap);
    }
    for (let index = 0; index < 4; index++) {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, bound[index] ?? this.dummyTex);
      gl.bindSampler(index, samplers[index]);
    }
    return dimensions;
  }

  private applyUniforms(program: WebGLProgram, uniforms: Map<string, RuntimeUniform>) {
    const gl = this.gl;
    for (const [name, uniform] of uniforms) {
      const location = this.u(program, name);
      if (location === null) continue;
      switch (uniform.type) {
        case 'float':
          gl.uniform1f(location, typeof uniform.value === 'number' ? uniform.value : 0);
          break;
        case 'int':
        case 'bool':
          gl.uniform1i(location, Number(uniform.value));
          break;
        case 'vec2':
          gl.uniform2fv(location, toNumArr(uniform.value, 2));
          break;
        case 'vec3':
          gl.uniform3fv(location, toNumArr(uniform.value, 3));
          break;
        case 'vec4':
          gl.uniform4fv(location, toNumArr(uniform.value, 4));
          break;
      }
    }
  }

  private runPass(id: RenderPassId, prog: WebGLProgram, w: number, h: number, dt: number, d: Date) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.uniform3f(this.u(prog, 'iResolution'), w, h, 1);
    const ut = this.u(prog, 'iTime');
    if (ut) gl.uniform1f(ut, this.time);
    const utd = this.u(prog, 'iTimeDelta');
    if (utd) gl.uniform1f(utd, dt);
    const uf = this.u(prog, 'iFrame');
    if (uf) gl.uniform1i(uf, this.frame);
    const um = this.u(prog, 'iMouse');
    if (um) {
      const mousePixel = (value: number, dimension: number) =>
        Math.sign(value) * Math.abs(value) * dimension;
      gl.uniform4f(
        um,
        this.mouse.x * w,
        this.mouse.y * h,
        mousePixel(this.mouse.z, w),
        mousePixel(this.mouse.w, h),
      );
    }
    const ud = this.u(prog, 'iDate');
    if (ud) {
      gl.uniform4f(
        ud,
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000,
      );
    }
    const us = this.u(prog, 'iSampleRate');
    if (us) gl.uniform1f(us, 44100);
    this.applyUniforms(prog, this.uniformVals);
    const channelDimensions = this.bindChannels(id, id === 'image' ? 'image' : 'buffer');
    for (let index = 0; index < 4; index++) {
      const location = this.u(prog, `iChannelResolution[${index}]`);
      if (location) gl.uniform3f(location, channelDimensions[index][0], channelDimensions[index][1], 1);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private blit(tex: WebGLTexture) {
    const gl = this.gl;
    gl.useProgram(this.copyProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const loc = this.u(this.copyProg, 'uTex');
    if (loc) gl.uniform1i(loc, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private present(dt: number, target: RenderPassId, d: Date) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (target !== 'image') {
      const buf = this.buffers.get(target);
      if (buf) {
        this.blit(buf.tex[buf.read]);
        return;
      }
    }
    const imgProg = this.passes.get('image');
    if (imgProg) this.runPass('image', imgProg, this.canvas.width, this.canvas.height, dt, d);
  }

  private draw(dt: number, offline = false, target: RenderPassId = this.previewTarget) {
    const gl = this.gl;
    if (!this.passes.has('image') && this.buffers.size === 0) return;
    if (!offline) this.simValid = false;
    this.resize();
    this.rebuildBuffers();
    this.uploadKeyboardState();
    this.updateAudioTextures();
    gl.bindVertexArray(this.vao);
    const d = new Date();
    for (const bid of this.timingPlan.bufferOrder) {
      const prog = this.passes.get(bid);
      const buf = this.buffers.get(bid);
      if (!prog || !buf) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, buf.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, buf.tex[buf.read ^ 1], 0);
      gl.viewport(0, 0, buf.w, buf.h);
      this.runPass(bid, prog, buf.w, buf.h, dt, d);
    }
    for (const b of this.buffers.values()) b.read = (b.read ^ 1) as 0 | 1;
    this.present(dt, target, d);
    if (this.keyboardTex) this.keyboardData.fill(0, 0, 256);
  }

  play() {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
    void this.audioCtx?.resume();
    for (const graph of this.audioGraphs.values()) void graph.el.play().catch(() => {});
    const loop = (now: number) => {
      if (!this.running) return;
      const dtRaw = (now - this.lastTick) / 1000;
      this.lastTick = now;
      const dt = Math.min(dtRaw, 0.1);
      this.time += dt * this.speed;
      this.frame++;
      this.draw(dt * this.speed);
      this.fpsEma = this.fpsEma * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
      this.statTimer += dt;
      if (this.statTimer > 0.15) {
        this.statTimer = 0;
        this.emitStats();
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    for (const graph of this.audioGraphs.values()) graph.el.pause();
  }

  reset() {
    this.time = 0;
    this.frame = 0;
    this.resetFeedback();
    this.simValid = false;
    this.simFrame = -1;
    if (!this.running) this.draw(0);
    this.emitStats();
  }

  isRunning() {
    return this.running;
  }

  setSpeed(s: number) {
    this.speed = Math.max(0, s);
  }

  seek(t: number) {
    this.time = Math.max(0, t);
    if (!this.running) this.draw(0);
    this.emitStats();
  }

  /** 当前预览时间（秒），供缩略图等场景捕获当前帧时刻。 */
  getTime(): number {
    return this.time;
  }

  setResolutionScale(s: number) {
    this.previewResolution = { mode: 'auto' };
    this.legacyResolutionScale = Math.max(0.1, Math.min(4, s));
    this.resize();
    this.rebuildBuffers();
    if (!this.running) this.draw(0);
    this.emitStats();
  }

  setPreviewResolution(resolution: PreviewResolution) {
    const next: PreviewResolution = resolution.mode === 'fixed'
      ? { mode: 'fixed', width: Math.floor(resolution.width), height: Math.floor(resolution.height) }
      : { mode: 'auto' };
    if (next.mode === 'fixed') {
      if (!Number.isFinite(next.width) || next.width < 1 || !Number.isFinite(next.height) || next.height < 1) {
        throw new ProductError({ code: 'runtime.preview-dimensions-invalid' });
      }
      const limits = this.previewLimits();
      if (next.width > limits.width || next.height > limits.height) {
        throw new ProductError({
          code: 'runtime.preview-dimension-limit',
          params: { width: limits.width, height: limits.height },
        });
      }
    }
    this.previewResolution = next;
    this.legacyResolutionScale = null;
    this.resize();
    this.rebuildBuffers();
    if (!this.running) this.draw(0);
    this.emitStats();
  }

  setPreviewTarget(t: RenderPassId) {
    this.previewTarget = t;
    if (!this.running) this.draw(0);
  }

  probePixel(target?: RenderPassId): PixelRGBA | null {
    if (!this.passes.size) return null;
    this.draw(0);
    const gl = this.gl;
    const t = target ?? this.previewTarget;
    const px = new Uint8Array(4);
    const buf = t !== 'image' ? this.buffers.get(t) : undefined;
    if (buf) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buf.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, buf.tex[buf.read], 0);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.readPixels(Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { x: px[0], y: px[1], z: px[2], w: px[3] };
  }

  async captureAt(
    time: number,
    frameIndex: number,
    dt: number,
    size?: CaptureSize,
  ): Promise<Blob | null> {
    if (!this.passes.size) return null;
    if (size) this.beginCapture(size);
    if (!this.captureSize) {
      this.beginCapture({ width: this.canvas.width, height: this.canvas.height });
    }
    const prevTime = this.time;
    const prevFrame = this.frame;
    try {
      const fi = Math.max(0, Math.floor(frameIndex));
      if (captureFrameNeedsReset(this.simValid, this.simFrame, fi)) {
        this.resetFeedback();
        this.simFrame = -1;
        this.simValid = true;
      }
      for (let f = this.simFrame + 1; f <= fi; f++) {
        this.time = Math.max(0, time - (fi - f) * dt);
        this.frame = f;
        this.draw(f === 0 ? 0 : dt, true, this.captureTarget);
      }
      this.simFrame = fi;

      return await new Promise<Blob | null>((resolve) => {
        this.canvas.toBlob(resolve, 'image/png');
      });
    } finally {
      this.time = prevTime;
      this.frame = prevFrame;
    }
  }

  private emitStats() {
    this.onStats?.({
      fps: Math.round(this.fpsEma),
      time: this.time,
      frame: this.frame,
      width: this.canvas.width,
      height: this.canvas.height,
      scale: this.legacyResolutionScale ?? (this.previewResolution.mode === 'auto' ? (window.devicePixelRatio || 1) : 1),
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.keyboardDetach?.();
    this.keyboardDetach = null;
    this.keyboardActive = false;
    if (this.keyboardTex) {
      this.gl.deleteTexture(this.keyboardTex);
      this.keyboardTex = null;
    }
    this.destroyAllAudioGraphs();
    this.ro.disconnect();
    this.releasePreviewDisplay();
    this.destroySoundSnapshot(this.soundSnapshot);
    for (const snapshot of [...this.retiredSoundSnapshots]) this.destroySoundSnapshot(snapshot);
    this.destroyPrograms(this.passes);
    this.destroyTextureMap(this.textureAssets);
    this.destroyBuffers(this.buffers);
    if (this.previewBuffers) this.destroyBuffers(this.previewBuffers);
    this.previewBuffers = null;
    if (this.previewFrameTexture) this.gl.deleteTexture(this.previewFrameTexture);
    this.previewFrameTexture = null;
    for (const sampler of this.samplers.values()) this.gl.deleteSampler(sampler);
    this.samplers.clear();
    this.gl.deleteTexture(this.dummyTex);
    this.destroyProgram(this.copyProg);
    this.gl.deleteShader(this.vert);
    const lose = this.gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  }

  async renderAudio(
    durationSec: number,
    sampleRate = 48000,
    isCancelled?: () => boolean,
    startSec = 0,
  ): Promise<AudioPCM | null> {
    if (this.disposed) return null;
    const snapshot = this.soundSnapshot;
    const program = snapshot.program;
    if (!program) return null;
    this.retainSoundSnapshot(snapshot);

    const gl = this.gl;
    const BATCH = 512;
    const total = Math.max(1, Math.round(Math.min(120, Math.max(0, durationSec)) * sampleRate));
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    const startSample = Math.max(0, Math.round(startSec * sampleRate));
    let framebuffer: WebGLFramebuffer | null = null;
    let outputTexture: WebGLTexture | null = null;
    let cancelled = false;

    try {
      framebuffer = gl.createFramebuffer();
      outputTexture = gl.createTexture();
      if (!framebuffer || !outputTexture) {
        throw new ProductError({ code: 'runtime.sound-render-target-failed' });
      }
      gl.bindTexture(gl.TEXTURE_2D, outputTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, BATCH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const offsetLocation = gl.getUniformLocation(program, 'u_offset');
      const rateLocation = gl.getUniformLocation(program, 'u_rate');
      const sampleRateLocation = gl.getUniformLocation(program, 'iSampleRate');
      for (let offset = 0; offset < total; offset += BATCH) {
        if (this.disposed || isCancelled?.()) {
          cancelled = true;
          break;
        }
        const count = Math.min(BATCH, total - offset);

        // Other preview/compile work may run while the previous batch yielded. Restore
        // every piece of GL state exclusively from the snapshot captured above.
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);
        gl.viewport(0, 0, BATCH, 1);
        gl.useProgram(program);
        gl.bindVertexArray(this.vao);
        this.applyUniforms(program, snapshot.uniforms);
        const channelDimensions = this.bindSoundChannels(snapshot);
        for (let index = 0; index < 4; index++) {
          const location = this.u(program, `iChannelResolution[${index}]`);
          if (location) gl.uniform3f(location, channelDimensions[index][0], channelDimensions[index][1], 1);
        }
        if (offsetLocation) gl.uniform1f(offsetLocation, startSample + offset);
        if (rateLocation) gl.uniform1f(rateLocation, sampleRate);
        if (sampleRateLocation) gl.uniform1f(sampleRateLocation, sampleRate);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        const pixels = new Uint8Array(count * 4);
        gl.readPixels(0, 0, count, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let index = 0; index < count; index++) {
          left[offset + index] = (pixels[index * 4] / 255) * 2 - 1;
          right[offset + index] = (pixels[index * 4 + 1] / 255) * 2 - 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return cancelled ? null : { left, right, sampleRate };
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (outputTexture) gl.deleteTexture(outputTexture);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.releaseSoundSnapshot(snapshot);
    }
  }
}
