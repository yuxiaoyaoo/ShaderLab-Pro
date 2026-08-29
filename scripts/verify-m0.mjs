import assert from 'node:assert/strict';
import { parseProject } from '../src/project/migrations.ts';
import {
  normalizeAutosavePayload,
  selectLatestAutosavePayload,
} from '../src/project/projectIO.ts';
import { createProject, sourcesWithDefaults } from '../src/project/types.ts';
import { buildEffectiveSources, buildRuntimeSetup } from '../src/shadertoy/setupBuilder.ts';

const legacy = parseProject(JSON.stringify({
  version: '1.0',
  name: 'Legacy',
  passes: {
    image: {
      enabled: true,
      file: '../unsafe.glsl',
      channels: [
        { index: 2, type: 'unexpected', src: 'bufferA' },
        { index: 7, type: 'buffer', src: 'bufferB' },
      ],
    },
  },
}));
assert.equal(legacy.version, '2.0');
assert.equal(legacy.passes.image.authoring?.kind, 'code');
assert.equal(legacy.passes.bufferA.authoring?.kind, 'code');
assert.equal(legacy.passes.image.file, 'passes/image.glsl');
assert.deepEqual(legacy.passes.image.channels, [{
  index: 2,
  type: 'buffer',
  src: 'bufferA',
  filter: 'linear',
  wrap: 'repeat',
}]);
assert.throws(
  () => parseProject(JSON.stringify({ version: '3.0', name: 'Future', passes: {} })),
  /高于当前支持/,
);

const meta = createProject('Runtime filtering');
meta.passes.bufferA.enabled = false;
meta.passes.bufferB.enabled = true;
meta.passes.sound.enabled = false;
meta.passes.image.channels = [
  { index: 0, type: 'texture', src: 'ignored.png', filter: 'linear', wrap: 'repeat' },
  { index: 1, type: 'buffer', src: 'bufferB', filter: 'nearest', wrap: 'clamp' },
];
const codeSources = sourcesWithDefaults({
  image: 'image',
  common: 'common',
  bufferA: 'disabled A',
  bufferB: 'enabled B',
  sound: 'disabled sound',
});
const effective = buildEffectiveSources(codeSources);
const setup = buildRuntimeSetup(meta, effective, [], {});
assert.equal(setup.sources.bufferA, undefined);
assert.equal(setup.sources.bufferB, 'enabled B');
assert.equal(setup.sources.sound, undefined);
assert.deepEqual(setup.options?.image?.channels, [
  { index: 1, type: 'buffer', src: 'bufferB', timing: 'current', filter: 'nearest', wrap: 'clamp' },
  { index: 0, type: 'texture', src: 'ignored.png', filter: 'linear', wrap: 'repeat' },
]);

const older = { savedAt: 100, name: 'Old', sources: { image: 'old', common: '' } };
const newer = {
  version: 2,
  savedAt: 200,
  name: 'New',
  meta: createProject('New'),
  sources: { image: 'new', common: '' },
  uniforms: [],
};
const selected = selectLatestAutosavePayload([newer, older, { savedAt: 'invalid' }]);
assert.equal(selected?.savedAt, 200);
assert.equal(selected?.sources.image, 'new');
const normalizedLegacy = normalizeAutosavePayload(older);
assert.equal(normalizedLegacy?.version, 2);
assert.equal(normalizedLegacy?.legacy, true);
assert.equal(normalizedLegacy?.meta.passes.image.authoring?.kind, 'code');

console.log('M0 pure-function checks passed');
