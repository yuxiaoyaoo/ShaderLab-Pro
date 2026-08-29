const restoreProperty = (target, key, descriptor) => {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
};

const handleId = (value) => value?.id ?? null;

export function installFakeWebGL({ width = 320, height = 180 } = {}) {
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    ResizeObserver: Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'),
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'),
    devicePixelRatio: Object.getOwnPropertyDescriptor(globalThis.window, 'devicePixelRatio'),
  };

  let nextId = 0;
  const makeHandle = (kind, extra = {}) => ({ id: `${kind}-${++nextId}`, kind, ...extra });
  const textures = [];
  const framebuffers = [];
  const samplers = [];
  const programs = [];
  const draws = [];
  const deletedTextures = new Set();
  const deletedFramebuffers = new Set();
  const deletedPrograms = new Set();
  const deletedSamplers = new Set();
  const textureUnits = Array.from({ length: 4 }, () => null);
  const samplerUnits = Array.from({ length: 4 }, () => null);
  const passDrawCounts = new Map();
  const pixelStores = new Map();
  let activeTextureUnit = 0;
  let drawFramebuffer = null;
  let readFramebuffer = null;
  let currentProgram = null;
  let defaultContent = 'default:initial';
  let viewport = [0, 0, width, height];
  let lost = false;

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    ACTIVE_TEXTURE: 0x84e0,
    TEXTURE_BINDING_2D: 0x8069,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    NONE: 0,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
    BROWSER_DEFAULT_WEBGL: 0x9244,
    FRAMEBUFFER: 0x8d40,
    READ_FRAMEBUFFER: 0x8ca8,
    READ_FRAMEBUFFER_BINDING: 0x8caa,
    COLOR_ATTACHMENT0: 0x8ce0,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_RENDERBUFFER_SIZE: 0x84e8,
    TRIANGLES: 0x0004,

    createVertexArray: () => makeHandle('vao'),
    bindVertexArray: () => {},
    createShader(type) { return makeHandle('shader', { type, source: '', compiled: false, infoLog: '' }); },
    shaderSource(shader, source) { shader.source = source; },
    compileShader(shader) {
      const markerLine = shader.source.split('\n').findIndex((line) => line.includes('@fake-compile-error'));
      shader.compiled = markerLine < 0;
      shader.infoLog = shader.compiled ? '' : `ERROR: 0:${markerLine + 1}: fake compile error`;
    },
    getShaderParameter(shader, parameter) { return parameter === this.COMPILE_STATUS ? shader.compiled : true; },
    getShaderInfoLog: (shader) => shader.infoLog,
    deleteShader(shader) { shader.deleted = true; },
    createProgram() {
      const program = makeHandle('program', { shaders: [], linked: false, pass: 'unknown', uniforms: new Map() });
      programs.push(program);
      return program;
    },
    attachShader(program, shader) { program.shaders.push(shader); },
    linkProgram(program) {
      program.linked = true;
      const fragment = program.shaders.find((shader) => shader.type === this.FRAGMENT_SHADER)?.source ?? '';
      const markedPass = fragment.match(/@fake-pass\s+(bufferA|bufferB|bufferC|bufferD|image|sound)/)?.[1];
      program.pass = markedPass
        ?? (fragment.includes('uniform sampler2D uTex')
          ? 'copy'
          : fragment.includes('mainSound') ? 'sound' : 'unknown');
    },
    getProgramParameter(program, parameter) { return parameter === this.LINK_STATUS ? program.linked : true; },
    deleteProgram(program) { program.deleted = true; deletedPrograms.add(program.id); },
    useProgram(program) { currentProgram = program; },
    getUniformLocation(program, name) { return { id: `${program.id}:${name}`, program, name }; },
    uniform1i(location, value) { location.program.uniforms.set(location.name, value); },
    uniform1f(location, value) { location.program.uniforms.set(location.name, value); },
    uniform2fv(location, value) { location.program.uniforms.set(location.name, [...value]); },
    uniform3f(location, ...value) { location.program.uniforms.set(location.name, value); },
    uniform3fv(location, value) { location.program.uniforms.set(location.name, [...value]); },
    uniform4f(location, ...value) { location.program.uniforms.set(location.name, value); },
    uniform4fv(location, value) { location.program.uniforms.set(location.name, [...value]); },

    createTexture() {
      const texture = makeHandle('texture', { width: 0, height: 0, label: 'unallocated', params: new Map(), allocations: 0 });
      textures.push(texture);
      return texture;
    },
    deleteTexture(texture) { texture.deleted = true; deletedTextures.add(texture.id); },
    activeTexture(unit) { activeTextureUnit = unit - this.TEXTURE0; },
    bindTexture(_target, texture) { textureUnits[activeTextureUnit] = texture; },
    pixelStorei(parameter, value) { pixelStores.set(parameter, value); },
    texImage2D(...args) {
      const texture = textureUnits[activeTextureUnit];
      if (!texture) throw new Error('texImage2D without bound texture');
      const source = args.length === 6 ? args[5] : null;
      texture.width = source?.width ?? args[3];
      texture.height = source?.height ?? args[4];
      texture.allocations += 1;
      texture.label = `clear:${texture.id}:${texture.allocations}`;
    },
    texParameteri(_target, parameter, value) {
      textureUnits[activeTextureUnit]?.params.set(parameter, value);
    },
    copyTexSubImage2D() {
      const texture = textureUnits[activeTextureUnit];
      if (!texture) throw new Error('copyTexSubImage2D without bound texture');
      texture.label = `snapshot(${defaultContent})`;
    },

    createFramebuffer() {
      const framebuffer = makeHandle('framebuffer', { attachment: null });
      framebuffers.push(framebuffer);
      return framebuffer;
    },
    deleteFramebuffer(framebuffer) { framebuffer.deleted = true; deletedFramebuffers.add(framebuffer.id); },
    bindFramebuffer(target, framebuffer) {
      if (target === this.FRAMEBUFFER) {
        drawFramebuffer = framebuffer;
        readFramebuffer = framebuffer;
      } else if (target === this.READ_FRAMEBUFFER) {
        readFramebuffer = framebuffer;
      }
    },
    framebufferTexture2D(_target, _attachment, _textureTarget, texture) {
      if (!drawFramebuffer) throw new Error('framebufferTexture2D without framebuffer');
      drawFramebuffer.attachment = texture;
    },

    createSampler() {
      const sampler = makeHandle('sampler', { params: new Map() });
      samplers.push(sampler);
      return sampler;
    },
    deleteSampler(sampler) { sampler.deleted = true; deletedSamplers.add(sampler.id); },
    samplerParameteri(sampler, parameter, value) { sampler.params.set(parameter, value); },
    bindSampler(unit, sampler) { samplerUnits[unit] = sampler; },

    viewport(...value) { viewport = value; },
    drawArrays() {
      if (!currentProgram) throw new Error('drawArrays without program');
      const attachment = drawFramebuffer?.attachment ?? null;
      const boundTextures = textureUnits.slice(0, 4);
      const boundSamplers = samplerUnits.slice(0, 4);
      const pass = currentProgram.pass;
      const count = (passDrawCounts.get(pass) ?? 0) + 1;
      passDrawCounts.set(pass, count);
      const inputLabels = boundTextures.map((texture) => texture?.label ?? null);
      const outputLabel = pass === 'copy'
        ? `copy(${inputLabels[0]})`
        : `${pass}:${count}[${inputLabels.map((label) => label ?? 'null').join(',')}]`;
      if (attachment) attachment.label = outputLabel;
      else defaultContent = outputLabel;
      draws.push({
        pass,
        program: currentProgram.id,
        framebuffer: handleId(drawFramebuffer),
        attachment: handleId(attachment),
        textures: boundTextures.map(handleId),
        textureLabels: inputLabels,
        samplers: boundSamplers.map(handleId),
        viewport: [...viewport],
        outputLabel,
      });
    },
    readPixels(_x, _y, readWidth, readHeight, _format, _type, pixels) {
      const label = readFramebuffer?.attachment?.label ?? defaultContent;
      let hash = 0;
      for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) & 0xff;
      for (let index = 0; index < readWidth * readHeight; index += 1) {
        pixels[index * 4] = hash;
        pixels[index * 4 + 1] = (hash + 1) & 0xff;
        pixels[index * 4 + 2] = (hash + 2) & 0xff;
        pixels[index * 4 + 3] = 255;
      }
    },
    getParameter(parameter) {
      if (parameter === this.READ_FRAMEBUFFER_BINDING) return readFramebuffer;
      if (parameter === this.ACTIVE_TEXTURE) return this.TEXTURE0 + activeTextureUnit;
      if (parameter === this.TEXTURE_BINDING_2D) return textureUnits[activeTextureUnit];
      if (parameter === this.MAX_TEXTURE_SIZE || parameter === this.MAX_RENDERBUFFER_SIZE) return 4096;
      return null;
    },
    getExtension(name) {
      if (name !== 'WEBGL_lose_context') return null;
      return { loseContext: () => { lost = true; } };
    },
  };

  const parent = {
    children: [],
    appendChild(child) {
      if (!this.children.includes(child)) this.children.push(child);
      child.parentElement = this;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((candidate) => candidate !== child);
      child.parentElement = null;
    },
  };

  const makeSnapshotCanvas = () => ({
    width: 0,
    height: 0,
    className: '',
    parentElement: null,
    attributes: new Map(),
    drawSource: null,
    getContext(kind) {
      if (kind !== '2d') return null;
      return { drawImage: (source) => { this.drawSource = source; } };
    },
    setAttribute(name, value) { this.attributes.set(name, value); },
    remove() { this.parentElement?.removeChild(this); },
  });

  const listeners = new Map();
  const canvas = {
    width,
    height,
    parentElement: parent,
    getContext(kind) { return kind === 'webgl2' ? gl : null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener(kind, listener) { listeners.set(kind, listener); },
    setPointerCapture: () => {},
    toBlob(callback, type) {
      const payload = JSON.stringify({ type, width: this.width, height: this.height, content: defaultContent });
      callback(typeof Blob === 'function' ? new Blob([payload], { type }) : { type, payload });
    },
  };
  parent.appendChild(canvas);

  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = []; this.disconnected = false; }
    observe(target) { this.observed.push(target); }
    disconnect() { this.disconnected = true; }
  }

  Object.defineProperty(globalThis.window, 'devicePixelRatio', { configurable: true, value: 1 });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag) => {
    if (tag !== 'canvas') throw new Error(`Unsupported fake element: ${tag}`);
    return makeSnapshotCanvas();
  } } });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });

  let restored = false;
  return {
    canvas,
    gl,
    parent,
    textures,
    framebuffers,
    samplers,
    programs,
    draws,
    pixelStores,
    deletedTextures,
    deletedFramebuffers,
    deletedPrograms,
    deletedSamplers,
    get defaultContent() { return defaultContent; },
    get lost() { return lost; },
    restore() {
      if (restored) return;
      restored = true;
      restoreProperty(globalThis, 'document', saved.document);
      restoreProperty(globalThis, 'ResizeObserver', saved.ResizeObserver);
      restoreProperty(globalThis, 'requestAnimationFrame', saved.requestAnimationFrame);
      restoreProperty(globalThis, 'cancelAnimationFrame', saved.cancelAnimationFrame);
      restoreProperty(globalThis.window, 'devicePixelRatio', saved.devicePixelRatio);
    },
  };
}
