import assert from 'node:assert/strict';
import { compileGraph, deterministicHash, lookupGraphSource, stableStringify } from '../src/graph/compiler/index.ts';
import { createEmptyGraph } from '../src/graph/model.ts';
import { accountProjectAssetBytes, assetContentHash, assetPayloadBytes, MAX_ASSET_BYTES, sha256Bytes } from '../src/graph/contentHash.ts';
import {
  ASSET_MANIFEST_FORMAT,
  ASSET_MANIFEST_VERSION,
  createAssetManifest,
  normalizeAssetManifest,
  parseAssetManifest,
  resolveTextureEnvironment,
  serializeAssetManifest,
} from '../src/graph/assets.ts';
import { createImportedTextureAsset, imageHeaderDimensions } from '../src/graph/assetRuntime.ts';
import {
  EMPTY_GRAPH_LIBRARY_REVISION,
  GRAPH_LIBRARY_FORMAT,
  GRAPH_LIBRARY_VERSION,
  computeGraphLibraryRevision,
  createGraphLibrary,
  createProjectNodeRegistry,
  createStarterCustomFunction,
  createStarterNodeGroup,
  normalizeGraphLibrary,
  parseGraphLibrary,
  serializeGraphLibrary,
} from '../src/graph/library.ts';
import { createDefaultRaymarchGraph, createDefaultSoundGraph } from '../src/graph/editor/defaultGraph.ts';
import { createPassGraphDocument, serializePassGraph } from '../src/project/passGraph.ts';
import {
  normalizeAutosavePayload,
  openProjectFrom,
  readLatestAutosave,
  saveProjectTo,
  writeAutosave,
} from '../src/project/projectIO.ts';
import {
  PROJECT_CONFIG_FILE,
  createProject,
  joinPath,
  serializeProject,
  sourcesWithDefaults,
} from '../src/project/types.ts';
import { ShadertoyRuntime } from '../src/shadertoy/runtime.ts';
import { buildRuntimeSetup } from '../src/shadertoy/setupBuilder.ts';
import { exportEligibility, validateExportTicket } from '../src/export/exportEligibility.ts';
import { installFakeWebGL } from './fake-webgl.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const node = (id, type, values = {}, x = 0, y = 0) => ({ id, type, typeVersion: 1, position: { x, y }, values });
const edge = (id, fromNode, fromSocket, toNode, toSocket) => ({
  id,
  from: { nodeId: fromNode, socketId: fromSocket },
  to: { nodeId: toNode, socketId: toSocket },
});
const diagnosticText = (result) => result.diagnostics.map((item) => `${item.code ?? 'diagnostic'}: ${item.message}`).join('\n');
const assertCompileOk = (result, label) => {
  assert.equal(result.ok, true, `${label} failed:\n${diagnosticText(result)}`);
  assert.ok(result.artifact, `${label} did not produce an artifact`);
  return result.artifact;
};
const pass = (label) => console.log(`✓ ${label}`);

function scalarLibraryGraph(type, values = {}) {
  return {
    ...createEmptyGraph('image'),
    nodes: [
      node('library-node', type, values, -300, 0),
      node('library-color', 'vector.combine4', { z: 0.25, w: 1 }, 0, 0),
      node('library-output', 'output.fragment', { color: [0, 0, 0, 1] }, 280, 0),
    ],
    edges: [
      edge('library-x', 'library-node', 'out', 'library-color', 'x'),
      edge('library-y', 'library-node', 'out', 'library-color', 'y'),
      edge('library-result', 'library-color', 'out', 'library-output', 'color'),
    ],
  };
}

function textureColorGraph(assetId = 'texA') {
  return {
    ...createEmptyGraph('image'),
    nodes: [
      node('texture-color', 'input.texture2d', { assetId, filter: 'linear', wrap: 'repeat', uv: [0.25, 0.75] }, -240, 0),
      node('texture-output', 'output.fragment', { color: [0, 0, 0, 1] }, 120, 0),
    ],
    edges: [edge('texture-color-edge', 'texture-color', 'color', 'texture-output', 'color')],
  };
}

function textureResolutionGraph(assetId = 'texA') {
  return {
    ...createEmptyGraph('image'),
    nodes: [
      node('texture-resolution', 'input.texture2d', { assetId, filter: 'linear', wrap: 'repeat', uv: [0, 0] }, -420, 0),
      node('resolution-split', 'vector.split2', {}, -180, 0),
      node('resolution-color', 'vector.combine4', { z: 0, w: 1 }, 40, 0),
      node('resolution-output', 'output.fragment', { color: [0, 0, 0, 1] }, 280, 0),
    ],
    edges: [
      edge('resolution-value', 'texture-resolution', 'resolution', 'resolution-split', 'value'),
      edge('resolution-x', 'resolution-split', 'x', 'resolution-color', 'x'),
      edge('resolution-y', 'resolution-split', 'y', 'resolution-color', 'y'),
      edge('resolution-result', 'resolution-color', 'out', 'resolution-output', 'color'),
    ],
  };
}

const savedGlobals = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
};
const restoreProperty = (target, key, descriptor) => {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
};

const storage = new Map();
const textFiles = new Map();
const binaryFiles = new Map();
const atomicCalls = [];
const mockLocalStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};
const mockBridge = {
  createDir: async () => {},
  readTextFile: async (path) => {
    if (!textFiles.has(path)) throw new Error(`ENOENT ${path}`);
    return textFiles.get(path);
  },
  readBinaryFile: async (path) => {
    if (!binaryFiles.has(path)) throw new Error(`ENOENT ${path}`);
    return binaryFiles.get(path);
  },
  writeBinaryFile: async (path, payload) => {
    binaryFiles.set(path, payload);
  },
  writeFilesAtomic: async (entries) => {
    const copied = entries.map((entry) => ({ ...entry }));
    atomicCalls.push(copied);
    const textSnapshot = new Map(textFiles);
    const binarySnapshot = new Map(binaryFiles);
    try {
      for (const entry of copied) {
        if (entry.kind === 'text') textFiles.set(entry.path, entry.contents);
        else binaryFiles.set(entry.path, entry.dataBase64);
      }
    } catch (error) {
      textFiles.clear();
      binaryFiles.clear();
      for (const [path, contents] of textSnapshot) textFiles.set(path, contents);
      for (const [path, contents] of binarySnapshot) binaryFiles.set(path, contents);
      throw error;
    }
  },
  writeTextFilesAtomic: async (entries) => {
    const copied = entries.map((entry) => ({ ...entry }));
    for (const entry of copied) textFiles.set(entry.path, entry.contents);
  },
};

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: mockLocalStorage });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { __slpMockBridge: mockBridge } });

try {
  // 1) Raw-byte SHA-256 identity and strict, whitespace-insensitive Base64 decoding.
  assert.equal(
    sha256Bytes(new Uint8Array()),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    assetContentHash('YWJj'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.deepEqual([...assetPayloadBytes('Y W\nJ\tj\r')], [97, 98, 99]);
  assert.equal(assetContentHash('Y W\nJ\tj\r'), assetContentHash('YWJj'));
  assert.throws(() => assetPayloadBytes('YWJj!'), /不是有效 Base64/);
  assert.throws(() => assetPayloadBytes('Y==='), /不是有效 Base64/);

  const hashAbc = assetContentHash('YWJj');
  const hashEmpty = assetContentHash('');
  const rawManifest = {
    format: ASSET_MANIFEST_FORMAT,
    version: ASSET_MANIFEST_VERSION,
    assets: [
      { id: 'texB', name: '  ', file: 'assets/tex-b.webp', mediaType: 'image/webp', width: 1, height: 1, colorSpace: 'linear', contentHash: hashEmpty.toUpperCase() },
      { id: 'texA', name: '  Primary texture  ', file: 'assets/tex-a.png', mediaType: 'image/png', width: 2, height: 1, colorSpace: 'srgb', contentHash: hashAbc.toUpperCase() },
    ],
  };
  const manifest = normalizeAssetManifest(rawManifest);
  assert.deepEqual(manifest.assets.map((asset) => asset.id), ['texA', 'texB']);
  assert.equal(manifest.assets[0].name, 'Primary texture');
  assert.equal(manifest.assets[0].contentHash, hashAbc);
  assert.equal(manifest.assets[1].name, 'texB');
  assert.deepEqual(parseAssetManifest(serializeAssetManifest(rawManifest)), manifest);

  const invalidPath = clone(rawManifest);
  invalidPath.assets[0].file = 'assets/../escape.webp';
  assert.throws(() => normalizeAssetManifest(invalidPath), /安全相对路径/);
  const invalidHash = clone(rawManifest);
  invalidHash.assets[0].contentHash = 'abc';
  assert.throws(() => normalizeAssetManifest(invalidHash), /contentHash 无效/);
  const duplicateId = clone(rawManifest);
  duplicateId.assets[1].id = duplicateId.assets[0].id;
  assert.throws(() => normalizeAssetManifest(duplicateId), /Asset id 重复/);
  const duplicatePath = clone(rawManifest);
  duplicatePath.assets[1].file = 'assets/TEX-B.WEBP';
  assert.throws(() => normalizeAssetManifest(duplicatePath), /Asset file 重复/);
  await assert.rejects(
    createImportedTextureAsset('duplicate.png', 'YWJj', manifest.assets),
    /该纹理已导入：Primary texture/,
  );

  const pngHeader = new Uint8Array(24);
  pngHeader.set([137, 80, 78, 71, 13, 10, 26, 10]);
  pngHeader.set([73, 72, 68, 82], 12);
  const pngView = new DataView(pngHeader.buffer);
  pngView.setUint32(16, 640, false);
  pngView.setUint32(20, 360, false);
  assert.deepEqual(imageHeaderDimensions(pngHeader, 'image/png'), { width: 640, height: 360 });
  const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x11, 0x00, 0x23]);
  assert.deepEqual(imageHeaderDimensions(jpegHeader, 'image/jpeg'), { width: 35, height: 17 });
  const webpHeader = new Uint8Array(30);
  webpHeader.set([...Buffer.from('RIFF')], 0);
  webpHeader.set([...Buffer.from('WEBP')], 8);
  webpHeader.set([...Buffer.from('VP8X')], 12);
  webpHeader.set([0x7f, 0x02, 0x00], 24);
  webpHeader.set([0x67, 0x01, 0x00], 27);
  assert.deepEqual(imageHeaderDimensions(webpHeader, 'image/webp'), { width: 640, height: 360 });
  assert.throws(() => imageHeaderDimensions(new Uint8Array(24), 'image/png'), /PNG 文件头无效/);
  assert.throws(() => imageHeaderDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'), /JPEG 尺寸头无效/);
  assert.throws(() => imageHeaderDimensions(new Uint8Array(30), 'image/webp'), /WebP 文件头无效/);

  const overSingleAsset = Buffer.alloc(MAX_ASSET_BYTES + 1).toString('base64');
  assert.throws(() => assetPayloadBytes(overSingleAsset), /单个纹理资产不能超过 32 MiB/);
  const thirtyMiBPayload = Buffer.alloc(30 * 1024 * 1024).toString('base64');
  let projectBytes = 0;
  for (let index = 0; index < 4; index++) projectBytes = accountProjectAssetBytes(projectBytes, thirtyMiBPayload);
  assert.throws(() => accountProjectAssetBytes(projectBytes, thirtyMiBPayload), /项目纹理二进制总量不能超过 128 MiB/);
  const pixelBudgetManifest = clone(rawManifest);
  pixelBudgetManifest.assets = [
    { ...pixelBudgetManifest.assets[0], id: 'hugeA', file: 'assets/huge-a.webp', width: 8192, height: 8192 },
    { ...pixelBudgetManifest.assets[1], id: 'hugeB', file: 'assets/huge-b.png', width: 1, height: 1 },
  ];
  assert.throws(() => normalizeAssetManifest(pixelBudgetManifest), /Asset 总像素不能超过/);
  pass('contentHash, format headers and Asset byte/pixel budgets');

  // 2) Stable Texture2D slot allocation, sampler identity, generated GLSL and channel resolution.
  const allocationGraph = {
    ...createEmptyGraph('image'),
    nodes: [
      node('texture-z', 'input.texture2d', { assetId: 'texA', filter: 'linear', wrap: 'repeat' }),
      node('texture-a', 'input.texture2d', { assetId: 'texA', filter: 'linear', wrap: 'repeat' }),
      node('texture-m', 'input.texture2d', { assetId: 'texA', filter: 'nearest', wrap: 'repeat' }),
    ],
  };
  const allocated = resolveTextureEnvironment(allocationGraph, manifest, [0]);
  assert.equal(allocated.bindings['texture-a'].slot, 1);
  assert.equal(allocated.bindings['texture-z'].slot, 1, 'identical asset+sampler bindings reuse a slot');
  assert.equal(allocated.bindings['texture-m'].slot, 2, 'a different sampler gets a distinct slot');
  assert.deepEqual(allocated.assets.map((item) => item.slot), [1, 2]);
  const reordered = resolveTextureEnvironment({ ...allocationGraph, nodes: [...allocationGraph.nodes].reverse() }, manifest, [0]);
  assert.deepEqual(reordered, allocated, 'allocation is deterministic regardless of node order');
  assert.throws(() => resolveTextureEnvironment(allocationGraph, manifest, [0, 1, 2, 3]), /超过 4 个 iChannel slot/);

  const srgbCompile = compileGraph(textureColorGraph(), {
    textureEnvironment: { 'texture-color': { slot: 1, assetId: 'texA', colorSpace: 'srgb' } },
    textureEnvironmentRevision: allocated.revision,
  });
  const srgbArtifact = assertCompileOk(srgbCompile, 'sRGB Texture2D graph');
  assert.match(srgbArtifact.source, /vec3 low = value\.rgb \/ 12\.92;/);
  assert.match(srgbArtifact.source, /pow\(\(value\.rgb \+ 0\.055\) \/ 1\.055, vec3\(2\.4\)\)/);
  assert.match(srgbArtifact.source, /step\(vec3\(0\.04045\), value\.rgb\)/);
  assert.match(srgbArtifact.source, /_sg_decodeSrgb\(texture\(iChannel1,/);

  const linearCompile = compileGraph(textureColorGraph(), {
    textureEnvironment: { 'texture-color': { slot: 2, assetId: 'texA', colorSpace: 'linear' } },
    textureEnvironmentRevision: 'linear-texture-revision',
  });
  const linearArtifact = assertCompileOk(linearCompile, 'linear Texture2D graph');
  assert.match(linearArtifact.source, /texture\(iChannel2,/);
  assert.doesNotMatch(linearArtifact.source, /_sg_decodeSrgb/);

  const resolutionCompile = compileGraph(textureResolutionGraph(), {
    textureEnvironment: { 'texture-resolution': { slot: 3, assetId: 'texA', colorSpace: 'linear' } },
    textureEnvironmentRevision: 'resolution-texture-revision',
  });
  const resolutionArtifact = assertCompileOk(resolutionCompile, 'Texture2D resolution graph');
  assert.match(resolutionArtifact.source, /iChannelResolution\[3\]\.xy/);
  pass('Texture2D deterministic slots, samplers, sRGB/linear lowering and iChannelResolution');

  // 3) Graph Library canonical identity, starter/nested groups and restricted Custom Functions.
  assert.equal(computeGraphLibraryRevision(createGraphLibrary()), EMPTY_GRAPH_LIBRARY_REVISION);
  const emptyCompile = assertCompileOk(compileGraph({
    ...createEmptyGraph('image'),
    nodes: [node('empty-output', 'output.fragment', { color: [0, 0, 0, 1] })],
  }), 'empty-library graph');
  assert.equal(emptyCompile.libraryRevision, EMPTY_GRAPH_LIBRARY_REVISION);

  const starterGroup = createStarterNodeGroup();
  const starterFunction = createStarterCustomFunction();
  const starterLibrary = normalizeGraphLibrary({
    format: GRAPH_LIBRARY_FORMAT,
    version: GRAPH_LIBRARY_VERSION,
    groups: [starterGroup],
    functions: [starterFunction],
  });
  assert.deepEqual(parseGraphLibrary(serializeGraphLibrary(starterLibrary)), starterLibrary);
  const starterRevision = computeGraphLibraryRevision(starterLibrary);
  const starterRegistry = createProjectNodeRegistry(starterLibrary);
  const starterGroupArtifact = assertCompileOk(compileGraph(
    scalarLibraryGraph('library.group.wave_mix', { value: 0.5, amount: 0.75 }),
    { registry: starterRegistry, libraryRevision: starterRevision },
  ), 'starter Node Group graph');
  assert.match(starterGroupArtifact.source, /sin\(/);
  assert.equal(starterGroupArtifact.libraryRevision, starterRevision);

  const customArtifact = assertCompileOk(compileGraph(
    scalarLibraryGraph('library.function.soft_pulse', { value: 0.5, width: 0.25 }),
    { registry: starterRegistry, libraryRevision: starterRevision },
  ), 'starter Custom Function graph');
  assert.match(customArtifact.source, /float _sg_custom_soft_pulse_v1\(float value, float width\)/);
  assert.match(customArtifact.source, /return \(exp\(-abs\(value\) \/ max\(width, 0\.0001\)\)\);/);

  const nestedGroup = {
    id: 'nested_wave',
    version: 1,
    title: 'Nested Wave',
    inputs: clone(starterGroup.inputs),
    outputs: [{
      id: 'out',
      title: 'Out',
      type: 'float',
      expression: {
        kind: 'group', groupId: 'wave_mix', version: 1, output: 'out', type: 'float',
        args: {
          value: { kind: 'input', input: 'value', type: 'float' },
          amount: { kind: 'input', input: 'amount', type: 'float' },
        },
      },
    }],
  };
  const nestedLibrary = normalizeGraphLibrary({
    format: GRAPH_LIBRARY_FORMAT,
    version: GRAPH_LIBRARY_VERSION,
    groups: [nestedGroup, starterGroup],
    functions: [starterFunction],
  });
  const nestedRevision = computeGraphLibraryRevision(nestedLibrary);
  const nestedArtifact = assertCompileOk(compileGraph(
    scalarLibraryGraph('library.group.nested_wave', { value: 0.5, amount: 0.75 }),
    { registry: createProjectNodeRegistry(nestedLibrary), libraryRevision: nestedRevision },
  ), 'nested Node Group graph');
  assert.match(nestedArtifact.source, /sin\(/);

  const badTypeGroup = clone(starterGroup);
  badTypeGroup.id = 'bad_type';
  badTypeGroup.outputs[0].type = 'vec2';
  badTypeGroup.outputs[0].expression.type = 'vec2';
  assert.throws(() => normalizeGraphLibrary({
    format: GRAPH_LIBRARY_FORMAT, version: GRAPH_LIBRARY_VERSION, groups: [badTypeGroup], functions: [],
  }), /声明为 vec2，实际为 float/);

  const extraArgumentGroup = clone(nestedGroup);
  extraArgumentGroup.id = 'extra_argument';
  extraArgumentGroup.outputs[0].expression.args.unexpected = { kind: 'literal', value: 1, type: 'float' };
  assert.throws(() => normalizeGraphLibrary({
    format: GRAPH_LIBRARY_FORMAT, version: GRAPH_LIBRARY_VERSION, groups: [starterGroup, extraArgumentGroup], functions: [],
  }), /包含多余参数 unexpected/);

  const recursiveGroup = {
    id: 'recursive', version: 1, title: 'Recursive',
    inputs: [{ id: 'value', title: 'Value', type: 'float', defaultValue: 0 }],
    outputs: [{
      id: 'out', title: 'Out', type: 'float',
      expression: {
        kind: 'group', groupId: 'recursive', version: 1, output: 'out', type: 'float',
        args: { value: { kind: 'input', input: 'value', type: 'float' } },
      },
    }],
  };
  assert.throws(() => normalizeGraphLibrary({
    format: GRAPH_LIBRARY_FORMAT, version: GRAPH_LIBRARY_VERSION, groups: [recursiveGroup], functions: [],
  }), /Node Group 递归调用/);

  const invalidFunctionLibrary = (fn) => ({
    format: GRAPH_LIBRARY_FORMAT, version: GRAPH_LIBRARY_VERSION, groups: [], functions: [fn],
  });
  const statementFunction = clone(starterFunction);
  statementFunction.expression = 'value; width';
  assert.throws(() => normalizeGraphLibrary(invalidFunctionLibrary(statementFunction)), /仅允许单个纯表达式/);
  const commentFunction = clone(starterFunction);
  commentFunction.expression = 'value /* hidden */';
  assert.throws(() => normalizeGraphLibrary(invalidFunctionLibrary(commentFunction)), /禁止语句、声明、注释/);
  const unknownFunction = clone(starterFunction);
  unknownFunction.expression = 'mystery(value)';
  assert.throws(() => normalizeGraphLibrary(invalidFunctionLibrary(unknownFunction)), /标识符不在签名\/白名单中：mystery/);
  const reservedInputFunction = clone(starterFunction);
  reservedInputFunction.inputs[0].id = 'for';
  assert.throws(() => normalizeGraphLibrary(invalidFunctionLibrary(reservedInputFunction)), /socket 无效/);
  const mismatchedOutputFunction = clone(starterFunction);
  mismatchedOutputFunction.id = 'bad_output';
  mismatchedOutputFunction.expression = 'vec4(value)';
  assert.throws(() => normalizeGraphLibrary(invalidFunctionLibrary(mismatchedOutputFunction)), /返回类型为 vec4，签名要求 float/);
  const invalidSwizzleFunction = clone(starterFunction);
  invalidSwizzleFunction.id = 'bad_swizzle';
  invalidSwizzleFunction.expression = 'value.xyz';
  assert.throws(() => normalizeGraphLibrary(invalidFunctionLibrary(invalidSwizzleFunction)), /swizzle 超出 float 范围/);
  const invalidCallFunction = clone(starterFunction);
  invalidCallFunction.id = 'bad_call';
  invalidCallFunction.expression = 'dot(value, width)';
  assert.throws(() => normalizeGraphLibrary(invalidFunctionLibrary(invalidCallFunction)), /dot 需要向量/);
  pass('Graph Library revisions, starter/nested Groups and restricted Custom Functions');

  // 4) Raymarch output contract, bounded loop, safe normalization and source mapping.
  const raymarchGraph = createDefaultRaymarchGraph();
  const raymarchResult = compileGraph(raymarchGraph);
  const raymarchArtifact = assertCompileOk(raymarchResult, 'default Raymarch graph');
  assert.match(raymarchArtifact.source, /for \(int i = 0; i < 128; \+\+i\)/);
  assert.match(raymarchArtifact.source, /vec3 _sg_safeNormalize\(vec3 value, vec3 fallbackValue\)/);
  assert.match(raymarchArtifact.source, /magnitude > 0\.000001 \? value \/ magnitude : fallbackValue/);
  assert.match(raymarchArtifact.source, /fragColor = _sg_raymarch\(/);
  const loopLine = raymarchArtifact.source.split('\n').findIndex((line) => line.includes('for (int i = 0; i < 128; ++i)')) + 1;
  const loopOrigin = lookupGraphSource(raymarchArtifact.sourceMap, loopLine);
  assert.equal(loopOrigin?.nodeId, 'ray-output');
  assert.equal(loopOrigin?.socketId, 'scene');

  const disconnectedRaymarch = clone(raymarchGraph);
  disconnectedRaymarch.edges = disconnectedRaymarch.edges.filter((item) => item.to.nodeId !== 'ray-output' || item.to.socketId !== 'scene');
  const disconnectedResult = compileGraph(disconnectedRaymarch);
  assert.equal(disconnectedResult.ok, false);
  assert.ok(disconnectedResult.diagnostics.some((item) => item.code === 'type.required-input' && item.origin.socketId === 'scene'));
  pass('Raymarch default compile, bounded loop, safe normalize, source map and required scene');

  // 5) Sound target contract and visual/sound output separation.
  const soundGraph = createDefaultSoundGraph();
  const soundResult = compileGraph(soundGraph);
  const soundArtifact = assertCompileOk(soundResult, 'default Sound graph');
  assert.match(soundArtifact.source, /vec2 mainSound\(int samp, float time\)/);
  assert.match(soundArtifact.source, /return /);

  const soundInVisual = clone(soundGraph);
  soundInVisual.pass = 'image';
  const soundTargetResult = compileGraph(soundInVisual);
  assert.equal(soundTargetResult.ok, false);
  assert.ok(soundTargetResult.diagnostics.some((item) => item.code === 'graph.output-target'));
  const raymarchInSound = clone(raymarchGraph);
  raymarchInSound.pass = 'sound';
  const visualTargetResult = compileGraph(raymarchInSound);
  assert.equal(visualTargetResult.ok, false);
  assert.ok(visualTargetResult.diagnostics.some((item) => item.code === 'graph.output-target'));
  pass('Sound mainSound compile and visual/sound pass target rejection');

  const domainMeta = createProject('M6 domain setup');
  domainMeta.passes.sound = {
    ...domainMeta.passes.sound,
    enabled: true,
    channels: [{ index: 1, type: 'texture', src: 'missing-sound', filter: 'linear', wrap: 'clamp' }],
  };
  domainMeta.passes.image = {
    ...domainMeta.passes.image,
    channels: [{ index: 2, type: 'texture', src: 'missing-visual', filter: 'nearest', wrap: 'repeat' }],
  };
  const domainSetup = buildRuntimeSetup(
    domainMeta,
    sourcesWithDefaults({ image: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }', sound: soundArtifact.source }),
    [
      { name: 'uCommon', label: 'Common', type: 'float', def: 0.1, min: 0, max: 1, step: 0.01, widget: 'slider', pass: 'common' },
      { name: 'uVisual', label: 'Visual', type: 'float', def: 0.2, min: 0, max: 1, step: 0.01, widget: 'slider', pass: 'image' },
      { name: 'uSound', label: 'Sound', type: 'float', def: 0.3, min: 0, max: 1, step: 0.01, widget: 'slider', pass: 'sound' },
    ],
    { uCommon: 0.4, uVisual: 0.5, uSound: 0.6 },
  );
  assert.deepEqual(domainSetup.options.image.channels.filter((channel) => channel.type === 'texture').map((channel) => channel.src), ['missing-visual']);
  assert.deepEqual(domainSetup.options.sound.channels.map((channel) => channel.src), ['missing-sound']);
  assert.deepEqual(domainSetup.uniforms.map((uniform) => uniform.name), ['uCommon', 'uVisual']);
  assert.deepEqual(domainSetup.soundUniforms.map((uniform) => uniform.name), ['uCommon', 'uSound']);

  const visualEligibility = exportEligibility({
    authoring: 'code', requirements: { visual: true, sound: false }, runtimeSetupRevision: 9,
    successfulVisualRuntimeSetupRevision: 9, compileStatus: 'ready', hasCompileError: false,
    hasUniformConflict: false, graphAccepted: false,
  });
  assert.equal(visualEligibility.eligible, true, 'Visual export does not require Sound acceptance');
  assert.equal(validateExportTicket(visualEligibility.ticket, {
    authoring: 'code', requirements: { visual: false, sound: true }, runtimeSetupRevision: 9,
    visualRuntimeSetupRevision: 9, soundRuntimeSetupRevision: 12,
    successfulVisualRuntimeSetupRevision: 9, successfulSoundRuntimeSetupRevision: 12,
    compileStatus: 'ready', hasCompileError: false, hasUniformConflict: false, graphAccepted: false,
  }).eligible, true, 'a Sound-only revision change does not invalidate a Visual-only ticket');
  const soundEligibility = exportEligibility({
    authoring: 'graph', requirements: { visual: false, sound: true }, runtimeSetupRevision: 9,
    successfulSoundRuntimeSetupRevision: 9, compileStatus: 'ready', hasCompileError: false,
    hasUniformConflict: false, graphAccepted: true, effectiveSourcesHash: 'sound-sources',
    graphArtifacts: [{ pass: 'sound', generation: 2, revision: 'sound-rev', sourceHash: 'sound-hash' }],
  });
  assert.equal(soundEligibility.eligible, true, 'Sound-only Graph export does not require Pass Graph identity');
  assert.equal(validateExportTicket(soundEligibility.ticket, {
    authoring: 'graph', requirements: { visual: true, sound: false }, runtimeSetupRevision: 9,
    visualRuntimeSetupRevision: 14, soundRuntimeSetupRevision: 9,
    successfulVisualRuntimeSetupRevision: 14, successfulSoundRuntimeSetupRevision: 9,
    compileStatus: 'ready', hasCompileError: false, hasUniformConflict: false, graphAccepted: true,
    effectiveSourcesHash: 'sound-sources',
    graphArtifacts: [{ pass: 'sound', generation: 2, revision: 'sound-rev', sourceHash: 'sound-hash' }],
  }).eligible, true, 'a Visual-only revision change does not invalidate a Sound-only ticket');
  assert.equal(validateExportTicket(soundEligibility.ticket, {
    authoring: 'graph', requirements: { visual: true, sound: false }, runtimeSetupRevision: 9,
    successfulSoundRuntimeSetupRevision: 9, compileStatus: 'ready', hasCompileError: false,
    hasUniformConflict: false, graphAccepted: true, effectiveSourcesHash: 'sound-sources',
    graphArtifacts: [{ pass: 'sound', generation: 2, revision: 'sound-rev', sourceHash: 'sound-hash' }],
  }).eligible, true, 'ticket validation preserves its captured Sound requirements');
  assert.equal(exportEligibility({
    authoring: 'code', requirements: { visual: true, sound: true }, runtimeSetupRevision: 9,
    successfulVisualRuntimeSetupRevision: 9, successfulSoundRuntimeSetupRevision: 8,
    compileStatus: 'ready', hasCompileError: false, hasUniformConflict: false, graphAccepted: false,
  }).eligible, false, 'audio video export requires both current domains');
  pass('Runtime setup and export eligibility are Visual/Sound domain-specific');

  // 6) Project resources: binary integrity, save/open, autosave and legacy 2.0 migration.
  const projectManifest = normalizeAssetManifest({
    format: ASSET_MANIFEST_FORMAT,
    version: ASSET_MANIFEST_VERSION,
    assets: [{
      id: 'texA', name: 'Project texture', file: 'assets/tex-a.png', mediaType: 'image/png',
      width: 2, height: 1, colorSpace: 'srgb', contentHash: hashAbc,
    }],
  });
  const projectLibrary = nestedLibrary;
  const project = createProject('M6 resource roundtrip');
  const projectSources = sourcesWithDefaults({
    common: '',
    image: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(0.25, 0.5, 0.75, 1.0); }',
  });
  const projectPassGraph = createPassGraphDocument();
  const projectDir = 'C:\\M6ResourceRoundtrip';
  atomicCalls.length = 0;
  const savedProject = await saveProjectTo(projectDir, project, projectSources, {
    passGraph: projectPassGraph,
    assetManifest: projectManifest,
    assetPayloads: { texA: 'YWJj' },
    graphLibrary: projectLibrary,
  });
  assert.ok(savedProject.assetManifest?.revision);
  assert.equal(savedProject.graphLibrary?.revision, computeGraphLibraryRevision(projectLibrary));
  assert.equal(atomicCalls.length, 1, 'project save uses one mixed atomic transaction');
  const projectAtomicBatch = atomicCalls[0];
  assert.ok(projectAtomicBatch.some((entry) => entry.kind === 'binary' && entry.path === joinPath(projectDir, projectManifest.assets[0].file) && entry.dataBase64 === 'YWJj'));
  assert.equal(projectAtomicBatch.at(-1)?.kind, 'text');
  assert.equal(projectAtomicBatch.at(-1)?.path, joinPath(projectDir, PROJECT_CONFIG_FILE));

  const openedProject = await openProjectFrom(projectDir);
  assert.deepEqual(openedProject.assetManifest, projectManifest);
  assert.deepEqual(openedProject.assetPayloads, { texA: 'YWJj' });
  assert.deepEqual(openedProject.graphLibrary, projectLibrary);
  assert.equal(openedProject.needsResave, false);
  assert.equal(openedProject.graphIssues.length, 0);

  const binaryPath = joinPath(projectDir, projectManifest.assets[0].file);
  binaryFiles.set(binaryPath, 'ZGVm');
  await assert.rejects(openProjectFrom(projectDir), /contentHash 校验失败/);
  binaryFiles.set(binaryPath, 'YWJj');
  await assert.rejects(saveProjectTo('C:\\M6RejectedPayload', createProject('bad payload'), projectSources, {
    passGraph: createPassGraphDocument(),
    assetManifest: projectManifest,
    assetPayloads: { texA: 'ZGVm' },
    graphLibrary: projectLibrary,
  }), /contentHash 与二进制不一致/);

  await writeAutosave(
    null,
    savedProject,
    projectSources,
    [],
    undefined,
    projectPassGraph,
    undefined,
    { assetManifest: projectManifest, assetPayloads: { texA: 'YWJj' }, graphLibrary: projectLibrary },
  );
  const autosave = await readLatestAutosave(null);
  assert.ok(autosave);
  assert.deepEqual(autosave.assetManifest, projectManifest);
  assert.deepEqual(autosave.assetPayloads, { texA: 'YWJj' });
  assert.deepEqual(autosave.graphLibrary, projectLibrary);
  assert.equal(autosave.meta.assetManifest.revision, deterministicHash(stableStringify(projectManifest)));
  assert.equal(autosave.meta.graphLibrary.revision, computeGraphLibraryRevision(projectLibrary));
  assert.equal(normalizeAutosavePayload({ ...autosave, assetPayloads: { texA: 'ZGVm' } }), null);
  assert.equal(normalizeAutosavePayload({ ...autosave, meta: { ...autosave.meta, graphLibrary: { ...autosave.meta.graphLibrary, revision: 'stale-library' } } }), null);
  const originalSetItem = mockLocalStorage.setItem;
  mockLocalStorage.setItem = () => { throw new Error('quota exceeded'); };
  try {
    await assert.rejects(writeAutosave(null, savedProject, projectSources), /quota exceeded/);
  } finally {
    mockLocalStorage.setItem = originalSetItem;
  }

  const legacyDir = 'C:\\M6Legacy20';
  const legacyProject = createProject('Legacy 2.0 resources');
  delete legacyProject.assetManifest;
  delete legacyProject.graphLibrary;
  textFiles.set(joinPath(legacyDir, PROJECT_CONFIG_FILE), serializeProject(legacyProject));
  textFiles.set(joinPath(legacyDir, legacyProject.passes.image.file), projectSources.image);
  textFiles.set(joinPath(legacyDir, legacyProject.passes.common.file), projectSources.common);
  textFiles.set(joinPath(legacyDir, legacyProject.passGraph.file), serializePassGraph(createPassGraphDocument()));
  const openedLegacy = await openProjectFrom(legacyDir);
  assert.deepEqual(openedLegacy.assetManifest, createAssetManifest());
  assert.deepEqual(openedLegacy.graphLibrary, createGraphLibrary());
  assert.equal(openedLegacy.needsResave, true);
  pass('project asset/library save-open, SHA-256 tamper rejection, autosave and legacy 2.0');

  // 7) Public Runtime smoke via fake-webgl: pixel upload/binding, sampler, resolution and soundOk/audio path.
  {
    const ioWindow = globalThis.window;
    const ioBridge = globalThis.window.__slpMockBridge;
    const fake = installFakeWebGL({ width: 320, height: 180 });
    let runtime;
    try {
      runtime = new ShadertoyRuntime(fake.canvas);
      const runtimeResult = runtime.compile({
        sources: {
          common: '',
          image: `/* @fake-pass image */\n${linearArtifact.source}`,
          sound: soundArtifact.source,
        },
        options: {
          image: { channels: [{ index: 2, type: 'texture', src: 'texA', filter: 'nearest', wrap: 'repeat' }] },
          sound: { channels: [] },
        },
        timingPlan: { bufferOrder: [], revision: 'm6-runtime-smoke' },
        textures: [{
          id: 'texA', width: 2, height: 1,
          pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
        }],
      });
      assert.equal(runtimeResult.ok, true, JSON.stringify(runtimeResult.diagnostics));
      assert.equal(runtimeResult.soundOk, true, JSON.stringify(runtimeResult.diagnostics));

      const uploadedTexture = fake.textures.find((texture) => texture.width === 2 && texture.height === 1);
      assert.ok(uploadedTexture, 'runtime uploads the supplied 2x1 pixel payload');
      assert.equal(uploadedTexture.allocations, 1);
      assert.equal(fake.pixelStores.get(fake.gl.UNPACK_FLIP_Y_WEBGL), 0);
      assert.equal(fake.pixelStores.get(fake.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL), 0);
      assert.equal(fake.pixelStores.get(fake.gl.UNPACK_COLORSPACE_CONVERSION_WEBGL), fake.gl.BROWSER_DEFAULT_WEBGL);

      runtime.probePixel('image');
      const imageDraw = [...fake.draws].reverse().find((draw) => draw.pass === 'image');
      assert.ok(imageDraw);
      assert.equal(imageDraw.textures[2], uploadedTexture.id);
      const runtimeSampler = fake.samplers.find((sampler) => sampler.id === imageDraw.samplers[2]);
      assert.ok(runtimeSampler);
      assert.equal(runtimeSampler.params.get(fake.gl.TEXTURE_MIN_FILTER), fake.gl.NEAREST);
      assert.equal(runtimeSampler.params.get(fake.gl.TEXTURE_MAG_FILTER), fake.gl.NEAREST);
      assert.equal(runtimeSampler.params.get(fake.gl.TEXTURE_WRAP_S), fake.gl.REPEAT);
      assert.equal(runtimeSampler.params.get(fake.gl.TEXTURE_WRAP_T), fake.gl.REPEAT);
      const imageProgram = fake.programs.find((program) => program.pass === 'image' && !program.deleted);
      assert.ok(imageProgram);
      assert.equal(imageProgram.uniforms.get('iChannel2'), 2);
      assert.deepEqual(imageProgram.uniforms.get('iChannelResolution[2]'), [2, 1, 1]);

      const framebufferCount = fake.framebuffers.length;
      const textureCount = fake.textures.length;
      const pcm = await runtime.renderAudio(0.01, 8000);
      assert.ok(pcm);
      assert.equal(pcm.sampleRate, 8000);
      assert.equal(pcm.left.length, 80);
      assert.equal(pcm.right.length, 80);
      assert.ok([...pcm.left, ...pcm.right].every(Number.isFinite));
      const audioFramebuffer = fake.framebuffers.slice(framebufferCount).find((item) => item.attachment?.width === 512 && item.attachment?.height === 1);
      const audioTexture = fake.textures.slice(textureCount).find((item) => item.width === 512 && item.height === 1);
      assert.ok(audioFramebuffer && fake.deletedFramebuffers.has(audioFramebuffer.id));
      assert.ok(audioTexture && fake.deletedTextures.has(audioTexture.id));
      assert.equal(await runtime.renderAudio(0.01, 8000, () => true), null);
    } finally {
      try {
        runtime?.dispose();
      } finally {
        fake.restore();
      }
    }
    assert.equal(globalThis.window, ioWindow, 'fake-webgl preserves the verifier window mock');
    assert.equal(globalThis.window.__slpMockBridge, ioBridge, 'fake-webgl preserves the verifier bridge mock');
  }
  pass('fake-webgl Runtime texture upload/sampler/resolution and soundOk/audio smoke');

  // 8) Runtime failure matrix: each domain commits independently and rejected Sound retains its full LKG snapshot.
  {
    const fake = installFakeWebGL({ width: 320, height: 180 });
    let runtime;
    const imageSource = (tag = 'good') => `/* @fake-pass image */\nuniform float uDomainVisual;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(uDomainVisual, ${tag === 'good' ? '0.0' : '1.0'}, 0.0, 1.0); }`;
    const soundSourceFor = (tag = 'good') => `/* @fake-pass sound */\nuniform float uDomainSound;\nvec2 mainSound(int samp, float time) { return vec2(uDomainSound + ${tag === 'good' ? '0.0' : '0.1'}); }`;
    const sharedAsset = { id: 'shared', width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) };
    const setup = ({ common = '', image = imageSource(), sound = soundSourceFor(), soundSrc = 'shared', visualValue = 0.5, soundValue = 0.25 } = {}) => ({
      sources: { common, image, sound },
      options: {
        image: { channels: [{ index: 0, type: 'texture', src: 'shared', filter: 'linear', wrap: 'repeat' }] },
        sound: { channels: [{ index: 0, type: 'texture', src: soundSrc, filter: 'nearest', wrap: 'clamp' }] },
      },
      timingPlan: { bufferOrder: [], revision: 'm6-domain-matrix' },
      textures: [sharedAsset],
      uniforms: [{ name: 'uDomainVisual', type: 'float', value: visualValue }],
      soundUniforms: [{ name: 'uDomainSound', type: 'float', value: soundValue }],
    });
    try {
      runtime = new ShadertoyRuntime(fake.canvas);
      const initialTextureCount = fake.textures.length;
      const initial = runtime.compile(setup(), { visual: true, sound: true });
      assert.equal(initial.visualOk, true);
      assert.equal(initial.soundOk, true);
      const domainTextures = fake.textures.slice(initialTextureCount).filter((texture) => texture.width === 2 && texture.height === 1);
      assert.equal(domainTextures.length, 2, 'Visual and Sound upload independent GL texture handles for a shared asset');

      runtime.probePixel('image');
      await runtime.renderAudio(0.002, 8000);
      const initialImageDraw = [...fake.draws].reverse().find((draw) => draw.pass === 'image');
      const initialSoundDraw = [...fake.draws].reverse().find((draw) => draw.pass === 'sound');
      assert.ok(initialImageDraw && initialSoundDraw);
      assert.notEqual(initialImageDraw.textures[0], initialSoundDraw.textures[0]);
      const lkgSoundProgram = fake.programs.find((program) => program.id === initialSoundDraw.program);
      assert.equal(lkgSoundProgram.uniforms.get('uDomainSound'), 0.25);
      assert.deepEqual(lkgSoundProgram.uniforms.get('iChannelResolution[0]'), [2, 1, 1]);
      const lkgSoundTexture = initialSoundDraw.textures[0];
      const lkgSoundSampler = fake.samplers.find((sampler) => sampler.id === initialSoundDraw.samplers[0]);
      assert.equal(lkgSoundSampler.params.get(fake.gl.TEXTURE_MIN_FILTER), fake.gl.NEAREST);
      assert.equal(lkgSoundSampler.params.get(fake.gl.TEXTURE_WRAP_S), fake.gl.CLAMP_TO_EDGE);

      const commonSoundError = runtime.compile(setup({ common: '/* @fake-compile-error */' }), { visual: false, sound: true });
      assert.equal(commonSoundError.soundOk, false);
      assert.ok(commonSoundError.diagnostics.some((diagnostic) => diagnostic.pass === 'common'), 'Sound-only Common errors retain Common origin for lane projection');

      const badSoundShader = runtime.compile(setup({ sound: `/* @fake-pass sound */\n/* @fake-compile-error */\n${soundSourceFor()}`, visualValue: 0.6, soundValue: 0.8 }), { visual: true, sound: true });
      assert.equal(badSoundShader.visualOk, true, 'bad Sound shader does not reject Visual');
      assert.equal(badSoundShader.soundOk, false);
      await runtime.renderAudio(0.002, 8000);
      const afterBadShader = [...fake.draws].reverse().find((draw) => draw.pass === 'sound');
      assert.equal(afterBadShader.program, lkgSoundProgram.id);
      assert.equal(afterBadShader.textures[0], lkgSoundTexture);
      assert.equal(afterBadShader.samplers[0], lkgSoundSampler.id);
      assert.equal(lkgSoundProgram.uniforms.get('uDomainSound'), 0.25);
      assert.deepEqual(lkgSoundProgram.uniforms.get('iChannelResolution[0]'), [2, 1, 1]);

      const badSoundChannel = runtime.compile(setup({ soundSrc: 'missing', visualValue: 0.7, soundValue: 0.9 }), { visual: true, sound: true });
      assert.equal(badSoundChannel.visualOk, true, 'missing Sound asset does not reject Visual');
      assert.equal(badSoundChannel.soundOk, false);
      await runtime.renderAudio(0.002, 8000);
      const afterBadChannel = [...fake.draws].reverse().find((draw) => draw.pass === 'sound');
      assert.equal(afterBadChannel.program, lkgSoundProgram.id);
      assert.equal(afterBadChannel.textures[0], lkgSoundTexture);

      const badVisualGoodSound = runtime.compile(setup({
        image: `/* @fake-pass image */\n/* @fake-compile-error */\n${imageSource()}`,
        sound: soundSourceFor('replacement'),
        soundValue: 0.9,
      }), { visual: true, sound: true });
      assert.equal(badVisualGoodSound.visualOk, false);
      assert.equal(badVisualGoodSound.soundOk, true, 'bad Visual does not reject Sound');
      await runtime.renderAudio(0.002, 8000);
      const replacementSoundDraw = [...fake.draws].reverse().find((draw) => draw.pass === 'sound');
      assert.notEqual(replacementSoundDraw.program, lkgSoundProgram.id);
      const replacementSoundProgram = fake.programs.find((program) => program.id === replacementSoundDraw.program);
      assert.equal(replacementSoundProgram.uniforms.get('uDomainSound'), 0.9);

      const retainedSoundProgram = replacementSoundDraw.program;
      const visualOnly = runtime.compile(setup({ image: imageSource('replacement'), sound: `/* @fake-compile-error */\n${soundSourceFor()}` }), { visual: true, sound: false });
      assert.equal(visualOnly.visualOk, true);
      assert.equal(visualOnly.soundOk, undefined);
      await runtime.renderAudio(0.002, 8000);
      const retainedSoundDraw = [...fake.draws].reverse().find((draw) => draw.pass === 'sound');
      assert.equal(retainedSoundDraw.program, retainedSoundProgram, '{ sound:false } preserves Sound LKG');

      const retainedTexture = retainedSoundDraw.textures[0];
      const inFlightAudio = runtime.renderAudio(0.2, 8000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const concurrentCommit = runtime.compile(setup({ sound: soundSourceFor('concurrent'), soundValue: 0.4 }), { visual: false, sound: true });
      assert.equal(concurrentCommit.soundOk, true);
      assert.equal(fake.deletedPrograms.has(retainedSoundProgram), false, 'in-flight Sound keeps retired program alive');
      assert.equal(fake.deletedTextures.has(retainedTexture), false, 'in-flight Sound keeps retired texture alive');
      assert.ok(await inFlightAudio, 'in-flight audio completes from its retained snapshot');
      assert.equal(fake.deletedPrograms.has(retainedSoundProgram), true, 'retired Sound program is released after the last consumer');
      assert.equal(fake.deletedTextures.has(retainedTexture), true, 'retired Sound texture is released after the last consumer');

      const clearedSound = runtime.compile(setup({ sound: '' }), { visual: false, sound: true });
      assert.equal(clearedSound.soundOk, true);
      assert.equal(await runtime.renderAudio(0.002, 8000), null, 'empty Sound with sound target clears the Sound snapshot');
      runtime.probePixel('image');
      assert.ok([...fake.draws].reverse().find((draw) => draw.pass === 'image'), 'Sound clear preserves Visual snapshot');
    } finally {
      try {
        runtime?.dispose();
      } finally {
        fake.restore();
      }
    }
  }
  pass('Visual/Sound independent failure matrix and complete Sound LKG retention');

  console.log('M6 verification passed: all verifier assertions succeeded.');
} finally {
  storage.clear();
  textFiles.clear();
  binaryFiles.clear();
  restoreProperty(globalThis, 'window', savedGlobals.window);
  restoreProperty(globalThis, 'localStorage', savedGlobals.localStorage);
}
