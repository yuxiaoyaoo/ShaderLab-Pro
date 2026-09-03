// M7: Shadertoy 输入通道验证 — 键盘状态机（真实 Runtime + fake-webgl）、
// 音频 iChannel 生命周期（静音回退 / 播放暂停 / 错误降级 / 释放）、
// setupBuilder 通道映射（keyboard/audio/texture）与 Asset Manifest 音频校验。
import assert from 'node:assert/strict';

import { ShadertoyRuntime } from '../src/shadertoy/runtime.ts';
import { buildRuntimeSetup, buildEffectiveSources } from '../src/shadertoy/setupBuilder.ts';
import { parseShadertoyJson, toShadertoyJson } from '../src/shadertoy/json.ts';
import {
  ASSET_MANIFEST_FORMAT,
  ASSET_MANIFEST_VERSION,
  MAX_AUDIO_ASSETS,
  normalizeAssetManifest,
} from '../src/graph/assets.ts';
import { MAX_ASSET_BYTES } from '../src/graph/contentHash.ts';
import { createProject, sourcesWithDefaults } from '../src/project/types.ts';
import { installFakeWebGL, installWindowEventCapture } from './fake-webgl.mjs';

const pass = (name) => console.log(`✓ ${name}`);
const clone = (value) => JSON.parse(JSON.stringify(value));
const HASH = 'a'.repeat(64);
const IMG_SRC = '/* @fake-pass image */ void mainImage(out vec4 o, in vec2 p) { o = vec4(0.0); }';

// ---------------------------------------------------------------------------
// Fake Web Audio stack: deterministic FFT/waveform + controllable element state.
// ---------------------------------------------------------------------------
const createdAudioEls = [];
class FakeAnalyser {
  fftSize = 1024;
  smoothingTimeConstant = 0.8;
  frequencyBinCount = 512;
  connect() {}
  disconnect() {}
  getByteFrequencyData(arr) { arr.fill(200, 0, 512); }
  getByteTimeDomainData(arr) { arr.fill(128, 0, 1024); }
}
class FakeAudioContext {
  destination = { fake: 'destination' };
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaElementSource() { return { connect() {} }; }
  createAnalyser() { return new FakeAnalyser(); }
}
class FakeAudioElement {
  paused = true;
  ended = false;
  loop = false;
  preload = '';
  src = '';
  currentTime = 0;
  duration = 120;
  constructor(src) {
    this.src = src ?? '';
    createdAudioEls.push(this);
    this._listeners = new Map();
  }
  addEventListener(kind, fn) {
    if (!this._listeners.has(kind)) this._listeners.set(kind, new Set());
    this._listeners.get(kind).add(fn);
  }
  removeEventListener(kind, fn) { this._listeners.get(kind)?.delete(fn); }
  emit(kind) { for (const fn of [...(this._listeners.get(kind) ?? [])]) fn(); }
  load() {}
  play() { this.paused = false; this.ended = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
globalThis.AudioContext = FakeAudioContext;
globalThis.Audio = class extends FakeAudioElement {
  constructor(src) {
    super();
    this.src = src ?? '';
  }
};

// ---------------------------------------------------------------------------
// 1) setupBuilder 通道映射：texture/keyboard/audio 组合、sound pass 排除、audio 透传。
// ---------------------------------------------------------------------------
{
  const meta = createProject('M7 channels');
  meta.passes.image.channels = [
    { index: 0, type: 'texture', src: 'texA', filter: 'linear', wrap: 'repeat' },
    { index: 1, type: 'keyboard' },
    { index: 2, type: 'audio', src: 'mus1', filter: 'linear', wrap: 'clamp' },
  ];
  meta.passes.sound.enabled = true;
  meta.passes.sound.channels = [{ index: 0, type: 'keyboard' }]; // Sound pass 必须排除 keyboard

  const setup = buildRuntimeSetup(
    meta,
    { common: '', image: IMG_SRC },
    [], {}, [], undefined, {}, [],
    [{ id: 'mus1', url: 'blob:x' }],
  );

  const imageChannels = setup.options.image.channels;
  assert.deepEqual(
    imageChannels.find((channel) => channel.type === 'texture'),
    { index: 0, type: 'texture', src: 'texA', filter: 'linear', wrap: 'repeat' },
  );
  assert.deepEqual(
    imageChannels.find((channel) => channel.type === 'keyboard'),
    { index: 1, type: 'keyboard' },
  );
  assert.deepEqual(
    imageChannels.find((channel) => channel.type === 'audio'),
    { index: 2, type: 'audio', src: 'mus1', filter: 'linear', wrap: 'clamp' },
  );
  assert.equal(
    setup.options.sound.channels.some((channel) => channel.type === 'keyboard' || channel.type === 'audio'),
    false,
    'Sound pass 只接受 texture 通道（keyboard/audio 被排除）',
  );
  assert.deepEqual(setup.audio, [{ id: 'mus1', url: 'blob:x' }]);
  pass('setupBuilder 通道映射：texture/keyboard/audio 组合、Sound pass 排除、audio 透传');
}

// ---------------------------------------------------------------------------
// 2) Asset Manifest 音频校验：合法、重复、mediaType、大小、数量、文件命名空间。
// ---------------------------------------------------------------------------
{
  const hash = HASH;
  const manifest = {
    format: ASSET_MANIFEST_FORMAT,
    version: ASSET_MANIFEST_VERSION,
    assets: [
      { id: 'texA', name: 'Tex A', file: 'assets/tex-a.png', mediaType: 'image/png', width: 2, height: 1, colorSpace: 'linear', contentHash: hash },
    ],
    audio: [
      { id: 'mus1', name: 'Song', file: 'assets/song.mp3', mediaType: 'audio/mpeg', bytes: 1024, contentHash: hash },
    ],
  };
  const normalized = normalizeAssetManifest(manifest);
  assert.equal(normalized.audio.length, 1);
  assert.equal(normalized.audio[0].id, 'mus1');
  assert.equal(normalized.audio[0].mediaType, 'audio/mpeg');
  assert.equal(normalized.audio[0].bytes, 1024);
  assert.equal(normalized.audio[0].contentHash, hash);

  assert.throws(() => normalizeAssetManifest(clone({ ...manifest, audio: [{ ...manifest.audio[0], id: 'texA' }] })), /重复/);
  assert.throws(() => normalizeAssetManifest(clone({ ...manifest, audio: [{ ...manifest.audio[0], mediaType: 'audio/x-wav' }] })), /mediaType 无效/);
  assert.throws(() => normalizeAssetManifest(clone({ ...manifest, audio: [{ ...manifest.audio[0], bytes: MAX_ASSET_BYTES + 1 }] })), /大小无效/);
  assert.throws(
    () => normalizeAssetManifest(clone({
      ...manifest,
      audio: Array.from({ length: MAX_AUDIO_ASSETS + 1 }, (_, index) => ({ ...manifest.audio[0], id: `mus${index}` })),
    })),
    /数量不能超过/,
  );
  assert.throws(() => normalizeAssetManifest(clone({ ...manifest, audio: [{ ...manifest.audio[0], file: 'assets/tex-a.png' }] })), /重复/);
  pass('Asset Manifest 音频校验：合法、重复、mediaType、大小、数量、文件命名空间');
}

// ---------------------------------------------------------------------------
// 3) 键盘状态机（真实 Runtime + fake-webgl + window 事件捕获）。
// ---------------------------------------------------------------------------
const KEY_IMG = IMG_SRC;
const findKeyboardTexture = (fake) => fake.textures.find((t) => t.width === 256 && t.height === 2);
const findAudioTexture = (fake) => fake.textures.find((t) => t.width === 512 && t.height === 2);
const lastSub = (texture) => texture.subImages[texture.subImages.length - 1]?.pixels ?? null;

// installFakeWebGL 依赖已存在的 window mock（devicePixelRatio 描述符）。
globalThis.window = globalThis.window ?? {};

{
  const fake = installFakeWebGL({ width: 160, height: 90 });
  const winEvents = installWindowEventCapture();
  const runtime = new ShadertoyRuntime(fake.canvas);

  // 3a) 门控：无 keyboard 通道时 keydown 不产生任何状态，也不创建键盘纹理。
  {
    const captures = [];
    runtime.onKeyboardCapture = (hover) => captures.push(hover);
    const setup = {
      sources: { common: '', image: KEY_IMG },
      options: { image: { channels: [] } },
      timingPlan: { bufferOrder: [], revision: 'm7-keyboard-gate' },
    };
    const result = runtime.compile(setup, { visual: true });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

    fake.canvasListeners.get('pointerenter')();
    assert.equal(captures.length, 0, 'keyboardActive=false 时 pointerenter 不触发采集回调');
    winEvents.dispatch('keydown', { keyCode: 65, repeat: false });
    runtime.probePixel('image');
    assert.equal(findKeyboardTexture(fake), undefined, '无 keyboard 通道时不创建 256x2 键盘纹理');
    pass('键盘门控：无 keyboard 通道时 keydown/pointerenter 不产生任何状态');
  }

  // 3b) 状态机：toggle/held 两行语义 + repeat/越界过滤 + hover/blur 生命周期。
  {
    const fake = installFakeWebGL({ width: 160, height: 90 });
    const winEvents = installWindowEventCapture();
    const runtime = new ShadertoyRuntime(fake.canvas);
    const captures = [];
    runtime.onKeyboardCapture = (hover) => captures.push(hover);

    const result = runtime.compile({
      sources: { common: '', image: KEY_IMG },
      options: { image: { channels: [{ index: 0, type: 'keyboard' }] } },
      timingPlan: { bufferOrder: [], revision: 'm7-keyboard' },
    }, { visual: true });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

    const keyboardTexture = findKeyboardTexture(fake);
    assert.ok(keyboardTexture, 'keyboard 通道编译后创建 256x2 键盘纹理');

    // 悬停采集：编译激活 keyboard 通道时先上报当前悬停态(false)，pointerenter 后上报 true。
    fake.canvasListeners.get('pointerenter')();
    assert.deepEqual(captures, [false, true], '激活上报 false + pointerenter 触发 onKeyboardCapture(true)');

    // keydown：row0 toggle=255 + row1 held=255；draw 后 row0 清零（单帧 toggle 语义）。
    winEvents.dispatch('keydown', { keyCode: 65, repeat: false });
    runtime.probePixel('image');
    let sub = lastSub(keyboardTexture);
    assert.equal(sub[65], 255, 'row0[keyCode]=255（toggle）');
    assert.equal(sub[256 + 65], 255, 'row1[keyCode]=255（held）');

    runtime.probePixel('image');
    sub = lastSub(keyboardTexture);
    assert.equal(sub[65], 0, 'toggle 行在帧后清零（单帧 toggle 语义）');
    assert.equal(sub[256 + 65], 255, 'held 行在帧间保持');

    // repeat 与越界 keyCode 被过滤（300 越界本应落入 row1[44]）。
    winEvents.dispatch('keydown', { keyCode: 65, repeat: true });
    winEvents.dispatch('keydown', { keyCode: 300, repeat: false });
    runtime.probePixel('image');
    sub = lastSub(keyboardTexture);
    assert.equal(sub[65], 0);
    assert.equal(sub[256 + 65], 255);
    assert.equal(sub[256 + 44], 0, '越界 keyCode(300) 被过滤（未落入 row1[44]）');

    // keyup 释放 held。
    winEvents.dispatch('keyup', { keyCode: 65 });
    runtime.probePixel('image');
    sub = lastSub(keyboardTexture);
    assert.equal(sub[256 + 65], 0, 'keyup 释放 held 行');

    // pointerleave：清 held + 采集回调 false；未悬停时 keydown 被忽略。
    fake.canvasListeners.get('pointerleave')();
    assert.equal(captures[captures.length - 1], false, 'pointerleave 触发 onKeyboardCapture(false)');
    winEvents.dispatch('keydown', { keyCode: 66, repeat: false });
    runtime.probePixel('image');
    sub = lastSub(keyboardTexture);
    assert.equal(sub[256 + 66], 0, '未悬停时 keydown 被忽略');

    // 重新悬停后 keydown 生效。
    fake.canvasListeners.get('pointerenter')();
    assert.equal(captures[captures.length - 1], true);
    winEvents.dispatch('keydown', { keyCode: 66, repeat: false });
    runtime.probePixel('image');
    sub = lastSub(keyboardTexture);
    assert.equal(sub[66], 255);
    assert.equal(sub[256 + 66], 255);

    // blur：toggle + held 全部清零。
    winEvents.dispatch('blur', {});
    runtime.probePixel('image');
    sub = lastSub(keyboardTexture);
    assert.equal(sub[66], 0);
    assert.equal(sub[256 + 66], 0);
    assert.ok(sub.every((byte) => byte === 0), 'blur 清空 toggle+held');

    // 门控：无 keyboard 通道重新编译后 keydown 被忽略、采集回调不再触发。
    const captureCount = captures.length;
    const noKeyboard = runtime.compile({
      sources: { common: '', image: KEY_IMG },
      options: { image: { channels: [] } },
      timingPlan: { bufferOrder: [], revision: 'm7-keyboard-off' },
    }, { visual: true });
    assert.equal(noKeyboard.ok, true);
    fake.canvasListeners.get('pointerenter')();
    assert.equal(captures.length, captureCount, 'keyboardActive=false 时采集回调不再触发');
    winEvents.dispatch('keydown', { keyCode: 65, repeat: false });
    runtime.probePixel('image');
    sub = lastSub(keyboardTexture);
    assert.ok(sub.every((byte) => byte === 0), 'keyboardActive=false 时 keydown 不改变键盘状态');

    pass('键盘状态机：toggle/held 两行、repeat/越界过滤、hover/blur 生命周期、keyboardActive 门控');
  }
}

// ---------------------------------------------------------------------------
// 4) 音频 iChannel 生命周期：静音回退、播放/暂停、错误降级、释放。
// ---------------------------------------------------------------------------
{
  const createdAudioEls = [];
  globalThis.AudioContext = class FakeAudioContext {
    destination = { fake: 'destination' };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaElementSource() { return { connect() {} }; }
    createAnalyser() {
      return {
        fftSize: 1024,
        smoothingTimeConstant: 0.8,
        frequencyBinCount: 512,
        connect() {},
        disconnect() {},
        getByteFrequencyData: (arr) => arr.fill(200, 0, 512),
        getByteTimeDomainData: (arr) => arr.fill(128, 0, 1024),
      };
    }
  };
  globalThis.Audio = class FakeAudioElement {
    paused = true;
    ended = false;
    loop = false;
    preload = '';
    duration = 120;
    currentTime = 0;
    constructor(src) {
      this.src = src ?? '';
      createdAudioEls.push(this);
      this._listeners = new Map();
    }
    addEventListener(kind, fn) {
      if (!this._listeners.has(kind)) this._listeners.set(kind, new Set());
      this._listeners.get(kind).add(fn);
    }
    removeEventListener(kind, fn) { this._listeners.get(kind)?.delete(fn); }
    emit(kind) { for (const fn of [...(this._listeners.get(kind) ?? [])]) fn(); }
    load() {}
    play() { this.paused = false; this.ended = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  };

  const fake = installFakeWebGL({ width: 160, height: 90 });
  const runtime = new ShadertoyRuntime(fake.canvas);
  const audioErrors = [];
  runtime.onAudioError = (assetId) => audioErrors.push(assetId);

  const audioSetup = (withAudio) => ({
    sources: { common: '', image: IMG_SRC },
    options: {
      image: { channels: withAudio ? [{ index: 1, type: 'audio', src: 'mus1', filter: 'linear', wrap: 'clamp' }] : [] },
    },
    timingPlan: { bufferOrder: [], revision: 'm7-audio' },
    audio: withAudio ? [{ id: 'mus1', url: 'blob:x' }] : [],
  });

  // 编译即建图：audio 通道 → 512x2 音频纹理。
  const result = runtime.compile(audioSetup(true), { visual: true });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const audioTexture = findAudioTexture(fake);
  assert.ok(audioTexture, 'audio 通道编译后创建 512x2 音频纹理');
  assert.equal(createdAudioEls.length, 1, '音频元素被创建');
  assert.equal(createdAudioEls[0].src, 'blob:x');

  // 暂停（默认）→ 静音回退：row0=0，row1=128。
  runtime.probePixel('image');
  let sub = lastSub(audioTexture);
  assert.ok(sub.every((byte, index) => (index < 512 ? byte === 0 : byte === 128)), '暂停时静音回退：row0=0，row1=128');

  // 播放 → analyser 数据：row0=FFT(200)，row1=波形 stride-2（128）。
  runtime.audioPlay('mus1');
  runtime.probePixel('image');
  sub = lastSub(audioTexture);
  assert.equal(sub[0], 200, '播放时 row0=FFT（getByteFrequencyData）');
  assert.equal(sub[512], 128, '播放时 row1=波形 stride-2（getByteTimeDomainData）');

  // 暂停 → 回到静音回退。
  runtime.audioPause('mus1');
  runtime.probePixel('image');
  sub = lastSub(audioTexture);
  assert.equal(sub[0], 0);
  assert.equal(sub[512 + 511], 128, '暂停后回到静音回退');

  // 元素 error → onAudioError + failed 标记 + audioPlay no-op（保持静音）。
  createdAudioEls[0].emit('error');
  assert.deepEqual(audioErrors, ['mus1'], '元素 error 触发 onAudioError(assetId)');
  assert.equal(runtime.audioInfo('mus1')?.failed, true);
  runtime.audioPlay('mus1');
  assert.equal(createdAudioEls[0].paused, true, 'failed 图谱 audioPlay 为 no-op');
  runtime.probePixel('image');
  sub = lastSub(audioTexture);
  assert.equal(sub[0], 0, 'failed 图谱保持静音');

  // 释放：无 audio 通道重新编译 → 图谱销毁、纹理删除、audioInfo 为 null。
  runtime.compile(audioSetup(false), { visual: true });
  assert.ok(fake.deletedTextures.has(audioTexture.id), '无 audio 通道重新编译销毁音频纹理');
  assert.equal(runtime.audioInfo('mus1'), null);
  pass('音频 iChannel：静音回退、播放/暂停、错误降级、图谱释放');
}

// ---------------------------------------------------------------------------
// Section 6: JSON 导入/导出兼容 — keyboard/texture/music 映射、missing 占位、round-trip
// ---------------------------------------------------------------------------
{
  const SAMPLER = { filter: 'linear', wrap: 'clamp', vflip: 'true', srgb: 'false', internal: 'byte' };
  const stJson = JSON.stringify({
    shader: {
      ver: '0.1',
      info: { name: 'M7 Inputs', description: '', likes: 0, viewed: 0, published: 0, flags: 0, tags: [], username: '' },
      renderpass: [
        {
          outputs: [{ id: 1, channel: 0 }],
          inputs: [
            { id: 2, src: null, ctype: 'buffer', channel: 0, sampler: SAMPLER },
            { id: 0, src: null, ctype: 'keyboard', channel: 1, sampler: { ...SAMPLER, filter: 'nearest' } },
            { id: 0, src: '/media/a/wood.jpg', ctype: 'texture', channel: 2, sampler: { ...SAMPLER, wrap: 'repeat' } },
            { id: 0, src: '/media/song.mp3', ctype: 'music', channel: 3, sampler: SAMPLER },
          ],
          code: IMG_SRC,
          name: 'Image',
          description: '',
          type: 'image',
        },
        {
          outputs: [{ id: 2, channel: 0 }],
          inputs: [{ id: 0, src: null, ctype: 'webcam', channel: 0 }],
          code: 'void mainImage(out vec4 o, in vec2 p) { o = vec4(0.0); }',
          name: 'Buffer A',
          description: '',
          type: 'buffer',
        },
      ],
      tags: [],
      flags: 0,
    },
  });

  const imp = parseShadertoyJson(stJson);
  const imgChannels = imp.buffers.image.channels;
  assert.equal(imgChannels[1].type, 'keyboard', 'keyboard input → 键盘通道');
  assert.equal(imgChannels[1].index, 1);
  assert.equal(imgChannels[1].filter, 'nearest', 'keyboard sampler filter 保留');
  assert.equal(imgChannels[2].type, 'texture', 'texture input → texture 通道');
  assert.equal(imgChannels[2].src, 'missing:/media/a/wood.jpg', 'texture input → missing:<url> 占位');
  assert.equal(imgChannels[2].wrap, 'repeat', 'texture sampler wrap 保留');
  assert.equal(imgChannels[3].type, 'audio', 'music input → audio 通道');
  assert.equal(imgChannels[3].src, 'missing:/media/song.mp3', 'music input → missing:<url> 占位');
  assert.deepEqual(
    [...imp.missingAssets].sort(),
    ['/media/a/wood.jpg', '/media/song.mp3'],
    'missingAssets 去重收集外部 URL',
  );
  assert.ok(
    imp.warnings.some((w) => w.code === 'shadertoy.warning.missing-assets' && w.params?.count === 2),
    'missing-assets warning 携带数量',
  );
  assert.ok(
    imp.skippedChannels.some((s) => s.ctype === 'webcam' && s.count === 1),
    'webcam 维持跳过并计数',
  );
  pass('JSON 导入：keyboard→键盘通道，texture/music→missing: 占位，webcam 跳过');

  // 导出：keyboard/texture/music 通道导出为 ctype keyboard/texture/music；
  // feedback 自引用寻找空闲 slot 时必须避开外部通道占用的索引。
  const meta = createProject('m7-exports');
  meta.passes.image = { ...meta.passes.image, channels: imgChannels };
  meta.passes.bufferA = {
    ...meta.passes.bufferA,
    enabled: true,
    feedback: true,
    channels: [{ index: 0, type: 'keyboard', src: '', filter: 'nearest', wrap: 'clamp' }],
  };
  const sources = sourcesWithDefaults({
    image: IMG_SRC,
    common: '',
    bufferA: 'void mainImage(out vec4 o, in vec2 p) { o = vec4(0.0); }',
  });
  const exported = JSON.parse(toShadertoyJson(meta, sources));
  const passes = exported.shader.renderpass;
  const imagePass = passes.find((p) => p.type === 'image');
  const bufferAPass = passes.find((p) => p.type === 'buffer');
  const imageInputs = imagePass.inputs;
  assert.equal(imageInputs.find((i) => i.ctype === 'buffer')?.channel, 0, 'buffer 通道导出');
  const kbInput = imageInputs.find((i) => i.ctype === 'keyboard');
  assert.equal(kbInput?.channel, 1, 'keyboard 通道导出为 ctype:keyboard');
  assert.equal(kbInput?.src, null);
  assert.equal(kbInput?.sampler.filter, 'nearest');
  const texInput = imageInputs.find((i) => i.ctype === 'texture');
  assert.equal(texInput?.channel, 2, 'texture 通道导出为 ctype:texture');
  assert.equal(texInput?.src, '/media/a/wood.jpg', 'missing: 占位导出时保留原始 URL（round-trip 可还原）');
  const musicInput = imageInputs.find((i) => i.ctype === 'music');
  assert.equal(musicInput?.channel, 3, 'audio 通道导出为 ctype:music');
  assert.equal(musicInput?.src, '/media/song.mp3', 'missing: 占位导出时保留原始 URL');
  const bufferAInputs = bufferAPass.inputs;
  assert.equal(bufferAInputs.find((i) => i.ctype === 'keyboard')?.channel, 0, 'Buffer A keyboard 通道导出');
  assert.equal(
    bufferAInputs.find((i) => i.ctype === 'buffer' && i.id === bufferAPass.outputs[0].id)?.channel,
    1,
    'feedback 自引用避开外部通道占用的 ch0',
  );
  pass('JSON 导出：keyboard/texture/music 通道导出 + feedback slot 避让');

  // round-trip：导出的 JSON 再导入，keyboard 还原，missing: 占位精确还原原始 URL。
  const re = parseShadertoyJson(JSON.stringify(exported));
  const reImage = re.buffers.image.channels;
  assert.equal(reImage[1].type, 'keyboard', 'round-trip：keyboard 通道还原');
  assert.equal(reImage[2].type, 'texture');
  assert.equal(reImage[2].src, 'missing:/media/a/wood.jpg', 'round-trip：缺失占位精确还原');
  assert.equal(reImage[3].type, 'audio');
  assert.equal(reImage[3].src, 'missing:/media/song.mp3', 'round-trip：缺失占位精确还原');
  const reA = re.buffers.bufferA;
  assert.equal(reA.feedback, true, 'round-trip：Buffer A feedback 还原');
  assert.ok(reA.channels.some((c) => c.type === 'keyboard' && c.index === 0));
  pass('JSON round-trip：keyboard 还原，本地资产降级为缺失占位');
}

console.log('M7 verification passed: keyboard state machine, audio iChannel lifecycle, channel mapping, asset manifest, json round-trip.');