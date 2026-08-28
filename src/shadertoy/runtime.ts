import type { RuntimeUniform, UniformValue } from './uniforms';

export interface Diagnostic {
  line: number;
  column: number;
  message: string;
  pass?: string;
}

export interface CompileResult {
  ok: boolean;
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
type BufferPassId = Exclude<RenderPassId, 'image'>;

const BUFFER_ORDER: BufferPassId[] = ['bufferA', 'bufferB', 'bufferC', 'bufferD'];

export interface RuntimeChannelCfg {
  index: number;
  type: string;
  src: string;
}

export interface RuntimePassOpts {
  feedback?: boolean;
  channels?: RuntimeChannelCfg[];
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
  options?: Partial<Record<RenderPassId, RuntimePassOpts>>;
  uniforms?: RuntimeUniform[];
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
  compile(setup: RuntimeSetup): CompileResult;
  play(): void;
  pause(): void;
  reset(): void;
  isRunning(): boolean;
  setSpeed(s: number): void;
  seek(t: number): void;
  setResolutionScale(s: number): void;
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
  '',
  'uniform vec3 iResolution;',
  'uniform float iTime;',
  'uniform float iTimeDelta;',
  'uniform float iFrame;',
  'uniform vec4 iMouse;',
  'uniform vec4 iDate;',
  'uniform float iSampleRate;',
  'uniform sampler2D iChannel0;',
  'uniform sampler2D iChannel1;',
  'uniform sampler2D iChannel2;',
  'uniform sampler2D iChannel3;',
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

function normBufferId(src: string): BufferPassId | null {
  const s = src.trim().toLowerCase();
  if (s === 'buffera') return 'bufferA';
  if (s === 'bufferb') return 'bufferB';
  if (s === 'bufferc') return 'bufferC';
  if (s === 'bufferd') return 'bufferD';
  return null;
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
  private uniCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private options: Partial<Record<RenderPassId, RuntimePassOpts>> = {};
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
  private resScale = 1;
  private captureSize: CaptureSize | null = null;
  private previewBuffers: Map<BufferPassId, BufState> | null = null;
  private previewFrameTexture: WebGLTexture | null = null;
  private previewDisplaySnapshot: HTMLCanvasElement | null = null;
  private captureTarget: RenderPassId = 'image';
  private ro: ResizeObserver;
  private simFrame = -1;
  private simValid = false;
  private uniformVals = new Map<string, RuntimeUniform>();
  private soundProg: WebGLProgram | null = null;
  private soundStStyle = false;

  onStats: ((s: RuntimeStats) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not supported');
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

    this.resScale = Math.min(window.devicePixelRatio || 1, 2);

    this.attachMouse();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = this.captureSize?.width
      ?? Math.max(1, Math.floor(rect.width * this.resScale));
    const h = this.captureSize?.height
      ?? Math.max(1, Math.floor(rect.height * this.resScale));
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
    if (!texture) throw new Error('无法创建预览快照纹理');
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
    if (!parent) throw new Error('无法冻结预览画面：画布缺少父容器');

    const snapshot = document.createElement('canvas');
    try {
      snapshot.width = this.canvas.width;
      snapshot.height = this.canvas.height;
      const ctx = snapshot.getContext('2d');
      if (!ctx) throw new Error('无法创建预览画面快照');
      ctx.drawImage(this.canvas, 0, 0);
      snapshot.className = 'preview-capture-snapshot';
      snapshot.setAttribute('aria-hidden', 'true');
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
      throw new Error(`当前显卡支持的最大导出单边尺寸为 ${deviceLimit} 像素`);
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

  setUniform(name: string, value: UniformValue): void {
    const prev = this.uniformVals.get(name);
    if (prev) {
      this.uniformVals.set(name, { ...prev, value });
    }
  }

  compile(setup: RuntimeSetup): CompileResult {
    const gl = this.gl;
    const commonText = setup.sources.common ?? '';
    const commonLines = commonText ? commonText.split('\n').length : 0;
    const userOffset = HEADER_LINE_COUNT + commonLines;
    const diags: Diagnostic[] = [];
    const next = new Map<RenderPassId, WebGLProgram>();
    for (const id of [...BUFFER_ORDER, 'image'] as RenderPassId[]) {
      const src = setup.sources[id];
      if (typeof src !== 'string' || src === '') continue;
      const full = [
        ...FRAG_HEADER,
        ...(commonLines ? commonText.split('\n') : []),
        ...src.split('\n'),
        ...FRAG_FOOTER,
      ].join('\n');
      const frag = this.compileShader(gl.FRAGMENT_SHADER, full);
      if (typeof frag === 'string') {
        diags.push(...this.parseErrors(frag, userOffset, commonLines > 0, id));
        continue;
      }
      const prog = this.linkProgram(frag);
      gl.deleteShader(frag);
      if (!prog) {
        diags.push({ line: 1, column: 1, message: 'program link failed', pass: id });
        continue;
      }
      gl.useProgram(prog);
      for (let i = 0; i < 4; i++) {
        const loc = gl.getUniformLocation(prog, `iChannel${i}`);
        if (loc) gl.uniform1i(loc, i);
      }
      next.set(id, prog);
    }
    const seenDiag = new Set<string>();
    const uniqDiags = diags.filter((d) => {
      const k = `${d.pass}|${d.line}|${d.column}|${d.message}`;
      if (seenDiag.has(k)) return false;
      seenDiag.add(k);
      return true;
    });
    if (uniqDiags.length > 0 || !next.has('image')) {
      if (next.size > 0) {
        for (const p of next.values()) gl.deleteProgram(p);
      }
      return { ok: false, diagnostics: uniqDiags.length > 0 ? uniqDiags : [{ line: 1, column: 1, message: '缺少 Image Pass 源码', pass: 'image' }] };
    }
    for (const p of this.passes.values()) gl.deleteProgram(p);
    this.passes.clear();
    this.uniCache.clear();
    for (const [id, prog] of next) this.passes.set(id, prog);
    if (this.soundProg) {
      gl.deleteProgram(this.soundProg);
      this.soundProg = null;
    }
    this.soundStStyle = false;
    const soundDiags: Diagnostic[] = [];
    const soundSrc = setup.sources.sound;
    if (typeof soundSrc === 'string' && soundSrc.trim() !== '') {
      const isSt = /\bvoid\s+mainSound\s*\(/.test(soundSrc) && !/\bvec2\s+mainSound\s*\(/.test(soundSrc);
      const soundFull = [
        ...FRAG_HEADER,
        ...(commonLines ? commonText.split('\n') : []),
        ...SOUND_PREAMBLE,
        ...soundSrc.split('\n'),
        ...(isSt ? SOUND_FOOT_ST : SOUND_FOOT_PRD),
      ].join('\n');
      const frag = this.compileShader(gl.FRAGMENT_SHADER, soundFull);
      if (typeof frag === 'string') {
        soundDiags.push(...this.parseErrors(frag, userOffset + SOUND_PREAMBLE.length, commonLines > 0, 'sound'));
      } else {
        const prog = this.linkProgram(frag);
        gl.deleteShader(frag);
        if (!prog) {
          soundDiags.push({ line: 1, column: 1, message: 'program link failed', pass: 'sound' });
        } else {
          gl.useProgram(prog);
          for (let i = 0; i < 4; i++) {
            const loc = gl.getUniformLocation(prog, `iChannel${i}`);
            if (loc) gl.uniform1i(loc, i);
          }
          this.soundProg = prog;
          this.soundStStyle = isSt;
        }
      }
    }
    this.options = setup.options ?? {};
    this.uniformVals = new Map(
      (setup.uniforms ?? []).map((u) => [u.name, { name: u.name, type: u.type, value: u.value }]),
    );
    this.resize();
    this.rebuildBuffers();
    this.resetFeedback();
    this.simValid = false;
    this.simFrame = -1;
    return { ok: true, diagnostics: soundDiags };
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
        out.push({ line: absLine - HEADER_LINE_COUNT, column: 1, message: m[2].trim(), pass: 'common' });
      } else {
        const userLine = absLine - offset;
        out.push({
          line: userLine >= 1 ? userLine : absLine,
          column: 1,
          message: m[2].trim(),
          pass: passId,
        });
      }
    }
    if (!out.length) out.push({ line: 1, column: 1, message: log.trim(), pass: passId });
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
    const mk = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const fbo = gl.createFramebuffer()!;
    return { fbo, tex: [mk(), mk()], read: 1, w, h };
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

  private bindChannels(passId: RenderPassId) {
    const gl = this.gl;
    const opts = this.options?.[passId];
    let chs = opts?.channels ?? [];
    if (opts?.feedback && passId !== 'image') {
      const selfRef = chs.some((c) => normBufferId(c.src ?? '') === passId);
      if (!selfRef) chs = [{ index: 0, type: 'buffer', src: passId }, ...chs];
    }
    const bound: (WebGLTexture | null)[] = [null, null, null, null];
    for (const c of chs) {
      if (!c || c.type !== 'buffer') continue;
      const target = normBufferId(c.src ?? '');
      if (!target) continue;
      const b = this.buffers.get(target);
      if (b) bound[Math.max(0, Math.min(3, Math.round(c.index)))] = b.tex[b.read];
    }
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, bound[i] ?? this.dummyTex);
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
    if (uf) gl.uniform1f(uf, this.frame);
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
    for (const [name, uv] of this.uniformVals) {
      const loc = this.u(prog, name);
      if (loc === null) continue;
      switch (uv.type) {
        case 'float':
          gl.uniform1f(loc, typeof uv.value === 'number' ? uv.value : 0);
          break;
        case 'int':
        case 'bool':
          gl.uniform1i(loc, Number(uv.value));
          break;
        case 'vec2':
          gl.uniform2fv(loc, toNumArr(uv.value, 2));
          break;
        case 'vec3':
          gl.uniform3fv(loc, toNumArr(uv.value, 3));
          break;
        case 'vec4':
          gl.uniform4fv(loc, toNumArr(uv.value, 4));
          break;
      }
    }
    this.bindChannels(id);
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
    gl.bindVertexArray(this.vao);
    const d = new Date();
    for (const bid of BUFFER_ORDER) {
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
  }

  play() {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
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

  setResolutionScale(s: number) {
    this.resScale = Math.max(0.1, Math.min(4, s));
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
      if (!this.simValid || fi <= this.simFrame) {
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
      scale: this.resScale,
    });
  }

  dispose() {
    this.pause();
    this.ro.disconnect();
    const lose = this.gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  }

  async renderAudio(
    durationSec: number,
    sampleRate = 48000,
    isCancelled?: () => boolean,
    startSec = 0,
  ): Promise<AudioPCM | null> {
    const gl = this.gl;
    const prog = this.soundProg;
    if (!prog) return null;
    const BATCH = 512;
    const total = Math.max(1, Math.round(Math.min(120, Math.max(0, durationSec)) * sampleRate));
    const fbo = gl.createFramebuffer()!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, BATCH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, BATCH, 1);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    const locOff = gl.getUniformLocation(prog, 'u_offset');
    const locRate = gl.getUniformLocation(prog, 'u_rate');
    const locISR = gl.getUniformLocation(prog, 'iSampleRate');
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let cancelled = false;
    const startSample = Math.max(0, Math.round(startSec * sampleRate));
    for (let off = 0; off < total; off += BATCH) {
      if (isCancelled?.()) {
        cancelled = true;
        break;
      }
      const n = Math.min(BATCH, total - off);
      if (locOff) gl.uniform1f(locOff, startSample + off);
      if (locRate) gl.uniform1f(locRate, sampleRate);
      if (locISR) gl.uniform1f(locISR, sampleRate);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(n * 4);
      gl.readPixels(0, 0, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < n; i++) {
        left[off + i] = (px[i * 4] / 255) * 2 - 1;
        right[off + i] = (px[i * 4 + 1] / 255) * 2 - 1;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (cancelled) return null;
    return { left, right, sampleRate };
  }
}
