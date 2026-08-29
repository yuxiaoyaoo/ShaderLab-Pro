import assert from 'node:assert/strict';
import { compileGraph } from '../src/graph/compiler/index.ts';
import { deterministicHash } from '../src/graph/compiler/hash.ts';
import { createDefaultImageGraph } from '../src/graph/editor/defaultGraph.ts';
import {
  inspectGraphCompilation,
  parseProjectGraph,
  serializeGraphDocument,
  validateGraphSave,
} from '../src/project/graphIO.ts';
import { parseProject } from '../src/project/migrations.ts';
import { writeTextFilesAtomic } from '../src/project/bridge.ts';
import {
  openProjectFrom,
  readLatestAutosave,
  saveProjectTo,
  selectLatestAutosavePayload,
  writeAutosave,
} from '../src/project/projectIO.ts';
import {
  classifyPersistedGraph,
  graphRecoveryPreview,
  loadedGraphRuntimeAction,
} from '../src/state/graphRecovery.ts';
import {
  PROJECT_CONFIG_FILE,
  createProject,
  joinPath,
  serializeProject,
  sourcesWithDefaults,
} from '../src/project/types.ts';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};

const files = new Map();
const atomicCalls = [];
const directories = [];
globalThis.window = {
  __slpMockBridge: {
    createDir: async (path) => { directories.push(path); },
    readTextFile: async (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    writeTextFilesAtomic: async (entries) => {
      atomicCalls.push(entries.map((entry) => ({ ...entry })));
      const targets = new Set(entries.map((entry) => entry.path));
      assert.equal(targets.size, entries.length, 'atomic batches reject duplicate targets');
      for (const entry of entries) files.set(entry.path, entry.contents);
    },
  },
};

await assert.rejects(
  () => writeTextFilesAtomic([
    { path: 'C:\\Project\\passes\\image.glsl', contents: 'a' },
    { path: 'C:\\Project\\passes\\IMAGE.glsl', contents: 'b' },
  ]),
  /重复目标/,
  'Windows case aliases must be rejected before invoking the native batch',
);

// 1.0 Code projects migrate losslessly to the 2.0 authoring shape.
const legacyImage = 'void mainImage(out vec4 c, in vec2 p){c=vec4(p,0.,1.);}';
const migrated = parseProject(JSON.stringify({
  version: '1.0',
  name: 'Legacy M3',
  description: 'keep me',
  created: '2020-01-01T00:00:00.000Z',
  modified: '2020-01-02T00:00:00.000Z',
  render: { fps: 30 },
  passes: { image: { enabled: true, file: 'passes/custom.glsl' } },
  uniforms: [{ name: 'gain', value: 0.5 }],
}));
assert.equal(migrated.version, '2.0');
assert.equal(migrated.description, 'keep me');
assert.equal(migrated.created, '2020-01-01T00:00:00.000Z');
assert.equal(migrated.render.fps, 30);
assert.deepEqual(migrated.uniforms, [{ name: 'gain', value: 0.5 }]);
assert.equal(migrated.passes.image.file, 'passes/custom.glsl');
assert.equal(migrated.passes.image.authoring.kind, 'code');
assert.equal(legacyImage, legacyImage, 'legacy GLSL is byte-for-byte unchanged outside metadata migration');

assert.throws(
  () => parseProject(JSON.stringify({ version: '3.0', name: 'Future project', passes: {} })),
  /高于当前支持/,
  'future project versions must be rejected',
);

for (const pass of ['common']) {
  const unsupported = createProject(`Unsupported ${pass} Graph`);
  unsupported.passes[pass].authoring = {
    kind: 'graph',
    graphFile: `graphs/${pass}.shadergraph.json`,
    graphFormatVersion: 1,
  };
  assert.throws(
    () => parseProject(serializeProject(unsupported)),
    new RegExp(`${pass} Pass 仅支持 Code authoring`),
    `${pass} Graph authoring remains unsupported`,
  );
}
for (const pass of ['bufferA', 'bufferB', 'bufferC', 'bufferD', 'sound']) {
  const supported = createProject(`Supported ${pass} Graph`);
  supported.passes[pass].authoring = {
    kind: 'graph',
    graphFile: `graphs/${pass}.shadergraph.json`,
    graphFormatVersion: 1,
  };
  assert.equal(parseProject(serializeProject(supported)).passes[pass].authoring.kind, 'graph');
}

assert.equal(loadedGraphRuntimeAction(false, false), 'try-persisted-fallback');
assert.equal(loadedGraphRuntimeAction(true, false), 'keep-normal-flow', 'M2 accepted preview must survive normal edit rejection');
assert.equal(loadedGraphRuntimeAction(false, true), 'keep-normal-flow');
assert.equal(graphRecoveryPreview(true), 'persisted-fallback');
assert.equal(graphRecoveryPreview(false), 'safe-placeholder');

const dir = 'C:\\M3Project';
const graph = createDefaultImageGraph();
graph.nodes[0] = { ...graph.nodes[0], position: { x: -777, y: 123 } };
graph.ui = { viewport: { x: 321, y: -45, zoom: 1.25 } };
graph.parameters = [{
  id: 'roundtrip-param',
  name: 'Round Trip',
  valueType: 'float',
  defaultValue: 0.75,
  ui: { widget: 'slider', min: 0, max: 2, step: 0.05 },
}];
const compiled = compileGraph(graph);
assert.equal(compiled.ok, true, compiled.diagnostics.map((item) => item.message).join('\n'));
assert.ok(compiled.artifact);

const meta = createProject('Graph round trip');
meta.passes.image.authoring = {
  kind: 'graph',
  graphFile: 'graphs/image.shadergraph.json',
  graphFormatVersion: 99,
  generatedHash: 'stale-before-save',
};
const sources = sourcesWithDefaults({
  image: 'old source must not win',
  common: '// common',
});
const saved = await saveProjectTo(dir, meta, sources, {
  graphDocuments: { image: graph },
  graphArtifacts: { image: compiled.artifact },
});
assert.equal(saved.passes.image.authoring.graphFormatVersion, 1);
assert.equal(saved.passes.image.authoring.generatedHash, compiled.artifact.sourceHash);
assert.equal(atomicCalls.length, 1);
const projectBatch = atomicCalls[0];
assert.equal(projectBatch.at(-1).path, joinPath(dir, PROJECT_CONFIG_FILE), 'shaderlab.json must commit last');
assert.ok(projectBatch.findIndex((entry) => entry.path.endsWith('image.shadergraph.json')) < projectBatch.findIndex((entry) => entry.path.endsWith('image.glsl')));
assert.equal(projectBatch.find((entry) => entry.path.endsWith('image.glsl')).contents, compiled.artifact.source);

const opened = await openProjectFrom(dir);
assert.deepEqual(opened.graphDocuments.image, graph, 'nodes, edges, parameters, positions and viewport round trip');
assert.equal(opened.sources.image, compiled.artifact.source);
assert.deepEqual(opened.graphIssues, []);
assert.equal(opened.needsResave, false);

// Schema-valid but compiler-invalid Graphs retain the original document and use read-only recovery.
const graphPath = joinPath(dir, 'graphs/image.shadergraph.json');
const goodGraphText = files.get(graphPath);
const missingOutputGraph = {
  ...graph,
  nodes: graph.nodes.filter((node) => node.type !== 'output.fragment'),
  edges: graph.edges.filter((edge) => edge.to.nodeId !== 'starter-output'),
};
files.set(graphPath, JSON.stringify(missingOutputGraph));
const missingOutput = await openProjectFrom(dir);
assert.deepEqual(missingOutput.graphDocuments.image, missingOutputGraph, 'compiler-invalid Graph must not be discarded');
assert.equal(missingOutput.sources.image, compiled.artifact.source, 'persisted generated GLSL remains the recovery source');
const outputIssue = missingOutput.graphIssues.find((issue) => issue.code === 'graph.output-count');
assert.ok(outputIssue);
assert.equal(outputIssue.severity, 'error');
assert.equal(outputIssue.stage, 'graph-validate');
assert.equal(outputIssue.origin.kind, 'graph');
assert.equal(classifyPersistedGraph(missingOutputGraph).kind, 'readonly-recovery');
assert.ok(inspectGraphCompilation('image', missingOutputGraph).some((issue) => issue.code === 'graph.output-count'));

const wave = graph.nodes.find((node) => node.id === 'starter-wave');
assert.ok(wave);
const cyclicGraph = {
  ...graph,
  nodes: [
    ...graph.nodes,
    { ...wave, id: 'cycle-sin', position: { x: -420, y: 300 } },
  ],
  edges: [
    ...graph.edges.filter((edge) => edge.id !== 'starter-e-time'),
    {
      id: 'cycle-e-a',
      from: { nodeId: 'starter-wave', socketId: 'out' },
      to: { nodeId: 'cycle-sin', socketId: 'value' },
    },
    {
      id: 'cycle-e-b',
      from: { nodeId: 'cycle-sin', socketId: 'out' },
      to: { nodeId: 'starter-wave', socketId: 'value' },
    },
  ],
};
files.set(graphPath, JSON.stringify(cyclicGraph));
const cyclic = await openProjectFrom(dir);
assert.deepEqual(cyclic.graphDocuments.image, cyclicGraph);
const cycleIssues = cyclic.graphIssues.filter((issue) => issue.code === 'graph.cycle');
assert.ok(cycleIssues.length >= 2);
assert.ok(cycleIssues.every((issue) => issue.origin?.kind === 'graph' && issue.origin.nodeId), 'cycle diagnostics retain node mapping');
assert.equal(classifyPersistedGraph(cyclicGraph).kind, 'readonly-recovery');
files.set(graphPath, goodGraphText);

// Missing, corrupt, and future Graphs retain graph authoring and the generated GLSL fallback.
files.delete(graphPath);
const missing = await openProjectFrom(dir);
assert.equal(missing.meta.passes.image.authoring.kind, 'graph');
assert.equal(missing.graphDocuments.image, undefined);
assert.equal(missing.sources.image, compiled.artifact.source);
assert.ok(missing.graphIssues.some((issue) => issue.code === 'graph.missing'));

files.set(graphPath, '{ broken');
const corrupt = await openProjectFrom(dir);
assert.equal(corrupt.meta.passes.image.authoring.kind, 'graph');
assert.equal(corrupt.graphDocuments.image, undefined);
assert.equal(corrupt.sources.image, compiled.artifact.source);
assert.ok(corrupt.graphIssues.some((issue) => issue.code === 'graph.invalid-json'));

const futureGraph = { ...graph, version: 2 };
files.set(graphPath, JSON.stringify(futureGraph));
const future = await openProjectFrom(dir);
assert.equal(future.meta.passes.image.authoring.kind, 'graph');
assert.equal(future.graphDocuments.image, undefined);
assert.equal(future.sources.image, compiled.artifact.source);
assert.ok(future.graphIssues.some((issue) => issue.code === 'schema.future-version'));
assert.equal(parseProjectGraph(JSON.stringify(futureGraph), 'image').document, undefined);
files.set(graphPath, goodGraphText);

// Persisted generatedHash is checked independently from the source and current Graph output.
const configPath = joinPath(dir, PROJECT_CONFIG_FILE);
const goodConfig = files.get(configPath);
const mismatchConfig = JSON.parse(goodConfig);
mismatchConfig.passes.image.authoring.generatedHash = 'fnv1a32:00000000';
files.set(configPath, serializeProject(mismatchConfig));
const mismatch = await openProjectFrom(dir);
assert.equal(mismatch.graphDocuments.image?.pass, 'image');
assert.equal(mismatch.needsResave, true);
assert.ok(mismatch.graphIssues.some((issue) => issue.code === 'graph.generated-hash-mismatch'));
files.set(configPath, goodConfig);

// Save contracts reject absent, internally inconsistent, and stale artifacts.
assert.throws(() => validateGraphSave('image', graph, undefined), /Runtime accepted artifact/);
assert.throws(
  () => validateGraphSave('image', graph, { ...compiled.artifact, sourceHash: 'fnv1a32:bad' }),
  /sourceHash 与源码不一致/,
);
const semanticallyChanged = {
  ...graph,
  nodes: graph.nodes.map((node) => node.id === 'starter-color'
    ? { ...node, values: { ...node.values, z: 0.91 } }
    : node),
};
assert.throws(
  () => validateGraphSave('image', semanticallyChanged, compiled.artifact),
  /accepted artifact 已过期/,
);
assert.equal(deterministicHash(compiled.artifact.source), compiled.artifact.sourceHash);
assert.equal(JSON.parse(serializeGraphDocument(graph)).ui.viewport.zoom, 1.25);

// Autosave V2 persists meta/effective source/uniform/Graph and scans slots by savedAt.
const autosaveMeta = JSON.parse(goodConfig);
const beforeAutosaveCalls = atomicCalls.length;
const firstAutosave = await writeAutosave(
  dir,
  autosaveMeta,
  sourcesWithDefaults({ image: compiled.artifact.source, common: '// autosave common' }),
  [{ name: 'gain', value: 1 }],
  { image: graph },
);
assert.equal(atomicCalls.length, beforeAutosaveCalls + 1);
assert.equal(atomicCalls.at(-1).length, 1, 'autosave uses a single-file atomic batch');
const latest = await readLatestAutosave(dir);
assert.equal(latest.savedAt, firstAutosave.savedAt);
assert.equal(latest.sources.image, compiled.artifact.source);
assert.deepEqual(latest.graphDocuments.image, graph);
assert.deepEqual(latest.uniforms, [{ name: 'gain', value: 1 }]);

await new Promise((resolve) => setTimeout(resolve, 2));
const invalidAutosave = await writeAutosave(
  dir,
  autosaveMeta,
  sourcesWithDefaults({ image: compiled.artifact.source, common: '// autosave recovery common' }),
  [{ name: 'gain', value: 2 }],
  { image: missingOutputGraph },
);
const recoveredInvalidAutosave = await readLatestAutosave(dir);
assert.equal(recoveredInvalidAutosave.savedAt, invalidAutosave.savedAt);
assert.deepEqual(recoveredInvalidAutosave.graphDocuments.image, missingOutputGraph, 'Autosave keeps the original compiler-invalid Graph');
assert.equal(recoveredInvalidAutosave.sources.image, compiled.artifact.source, 'Autosave keeps persisted generated GLSL for read-only fallback');
const parsedAutosaveGraph = parseProjectGraph(JSON.stringify(recoveredInvalidAutosave.graphDocuments.image), 'image');
assert.ok(parsedAutosaveGraph.document, 'compiler-invalid Autosave Graph remains schema-valid');
assert.equal(classifyPersistedGraph(parsedAutosaveGraph.document).kind, 'readonly-recovery');
assert.ok(inspectGraphCompilation('image', parsedAutosaveGraph.document).some((issue) => issue.code === 'graph.output-count'));

const selected = selectLatestAutosavePayload([
  { ...latest, savedAt: 100 },
  { ...latest, savedAt: 300, sources: { ...latest.sources, image: 'newest' } },
  { ...latest, savedAt: 200 },
]);
assert.equal(selected.savedAt, 300);
assert.equal(selected.sources.image, 'newest');

console.log('M3 project I/O and atomic-contract checks passed');
