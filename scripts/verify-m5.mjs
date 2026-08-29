import assert from 'node:assert/strict';
import { compileGraph } from '../src/graph/compiler/index.ts';
import { createEmptyGraph } from '../src/graph/model.ts';
import { createGraphEditorState, graphCompileResolved, acceptGraphCohort, acceptedGeneratedSources, graphCohortReady, selectGraphPersistenceArtifact } from '../src/state/graphEditorStore.ts';
import { exportEligibility, validateExportTicket } from '../src/export/exportEligibility.ts';
import { createProject, joinPath, PROJECT_CONFIG_FILE, serializeProject, sourcesWithDefaults } from '../src/project/types.ts';
import {
  convertPassGraphTargetToCode, convertPassGraphTargetToGraph, createPassGraphDocument,
  endpointChangedForTarget, endpointSelectionForTarget, migratePassGraphFromLegacy,
  parsePassGraph, passGraphFromLegacy, passGraphReferenceIssues, resolvePassGraph,
  retargetPassGraphEdge, serializePassGraph, shadertoyPassGraphIssue,
} from '../src/project/passGraph.ts';
import { classifyPersistedGraph, clearAcceptedRuntimeRecoveryFlags, persistedGraphRecoveryDecision, planPassGraphIdentityRecovery } from '../src/state/graphRecovery.ts';
import { captureFrameNeedsReset, selectChannelTexture } from '../src/shadertoy/channelTiming.ts';
import { planRuntimeFrame, ShadertoyRuntime } from '../src/shadertoy/runtime.ts';
import { buildRuntimeSetup } from '../src/shadertoy/setupBuilder.ts';
import { openProjectFrom, saveProjectTo, writeAutosave, readLatestAutosave } from '../src/project/projectIO.ts';
import { installFakeWebGL } from './fake-webgl.mjs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key), clear: () => storage.clear(),
};
const files = new Map();
const atomicCalls = [];
globalThis.window = { __slpMockBridge: {
  createDir: async () => {},
  readTextFile: async (path) => { if (!files.has(path)) throw new Error(`ENOENT ${path}`); return files.get(path); },
  writeTextFilesAtomic: async (entries) => { atomicCalls.push(entries.map((entry) => ({ ...entry }))); for (const entry of entries) files.set(entry.path, entry.contents); },
} };

const sampleGraph = (pass, nodeId) => ({
  ...createEmptyGraph(pass),
  nodes: [
    { id: nodeId, type: 'input.channel-sample', typeVersion: 1, position: { x: 0, y: 0 }, values: { uv: [0, 0] } },
    { id: `${pass}-out`, type: 'output.fragment', typeVersion: 1, position: { x: 240, y: 0 }, values: { color: [0, 0, 0, 1] } },
  ],
  edges: [{ id: `${pass}-edge`, from: { nodeId, socketId: 'color' }, to: { nodeId: `${pass}-out`, socketId: 'color' } }],
});
const project = createProject('M5 cohort');
project.passes.bufferA.enabled = true;
project.passes.bufferA.authoring = { kind: 'graph', graphFile: 'graphs/buffer_a.shadergraph.json', graphFormatVersion: 1 };
project.passes.image.authoring = { kind: 'graph', graphFile: 'graphs/image.shadergraph.json', graphFormatVersion: 1 };
const docs = { image: sampleGraph('image', 'image-channel'), bufferA: sampleGraph('bufferA', 'buffer-channel') };
const passGraph = createPassGraphDocument();
passGraph.edges = [
  { id: 'feedback-a', source: 'bufferA', target: 'bufferA', endpoint: { kind: 'graph-channel', nodeId: 'buffer-channel' }, slot: { mode: 'auto' }, filter: 'nearest', wrap: 'clamp', timing: 'previous' },
  { id: 'a-to-image', source: 'bufferA', target: 'image', endpoint: { kind: 'graph-channel', nodeId: 'image-channel' }, slot: { mode: 'auto' }, filter: 'linear', wrap: 'repeat', timing: 'current' },
];
const resolved = resolvePassGraph(passGraph, project, docs);
assert.equal(resolved.ok, true);
assert.deepEqual(resolved.resolved.bufferOrder, ['bufferA']);
assert.equal(resolved.resolved.edges.find((edge) => edge.id === 'feedback-a').slot, 0);
assert.equal(resolved.resolved.edges.find((edge) => edge.id === 'a-to-image').slot, 0);
assert.equal(shadertoyPassGraphIssue(resolved.resolved), undefined);
assert.deepEqual(parsePassGraph(serializePassGraph(passGraph)), passGraph);
assert.throws(() => parsePassGraph({ ...passGraph, version: 99 }), /高于当前支持/);

// Legacy timing migration records old semantics explicitly and never invents channel0 feedback over an occupied slot.
const legacy = createProject('legacy');
legacy.passes.bufferA.enabled = true;
legacy.passes.bufferB.enabled = true;
legacy.passes.bufferB.channels = [{ index: 2, type: 'buffer', src: 'bufferA', filter: 'linear', wrap: 'repeat' }];
legacy.passes.bufferB.feedback = true;
legacy.passes.image.channels = [{ index: 1, type: 'buffer', src: 'bufferB', filter: 'nearest', wrap: 'clamp' }];
const migrated = passGraphFromLegacy(legacy);
assert.equal(migrated.edges.find((edge) => edge.target === 'bufferB' && edge.source === 'bufferA').timing, 'previous');
assert.equal(migrated.edges.find((edge) => edge.target === 'image').timing, 'current');
const feedback = migrated.edges.find((edge) => edge.target === 'bufferB' && edge.source === 'bufferB');
assert.equal(feedback.timing, 'previous');
assert.notEqual(feedback.slot.index, 2);
const fullLegacy = createProject('full legacy feedback');
fullLegacy.passes.bufferA.enabled = true;
fullLegacy.passes.bufferA.feedback = true;
fullLegacy.passes.bufferA.channels = [0, 1, 2, 3].map((index) => ({ index, type: 'buffer', src: 'bufferA', filter: 'linear', wrap: 'repeat' }));
const fullLegacyGraph = passGraphFromLegacy(fullLegacy);
assert.equal(fullLegacyGraph.edges.filter((edge) => edge.target === 'bufferA').length, 4, 'explicit self channel already represents feedback without an extra edge');
const fullNoSelf = createProject('full legacy missing feedback source');
fullNoSelf.passes.bufferA.enabled = true; fullNoSelf.passes.bufferB.enabled = true;
fullNoSelf.passes.bufferA.feedback = true;
fullNoSelf.passes.bufferA.channels = [0, 1, 2, 3].map((index) => ({ index, type: 'buffer', src: 'bufferB', filter: 'linear', wrap: 'repeat' }));
assert.equal(resolvePassGraph(passGraphFromLegacy(fullNoSelf), fullNoSelf).ok, false, 'unrepresentable full-slot feedback fails closed instead of being dropped');

// M3 Graph targets migrate legacy slots by injecting deterministic stable sample nodes.
const legacyGraphProject = createProject('legacy graph channels');
delete legacyGraphProject.passGraph;
delete legacyGraphProject.assetManifest;
delete legacyGraphProject.graphLibrary;
legacyGraphProject.passes.bufferA.enabled = true;
legacyGraphProject.passes.image.authoring = { kind: 'graph', graphFile: 'graphs/image.shadergraph.json', graphFormatVersion: 1 };
legacyGraphProject.passes.image.channels = [{ index: 2, type: 'buffer', src: 'bufferA', filter: 'nearest', wrap: 'clamp' }];
const legacyGraphDocument = {
  ...createEmptyGraph('image'),
  nodes: [{ id: 'legacy-out', type: 'output.fragment', typeVersion: 1, position: { x: 240, y: 0 }, values: { color: [0.2, 0.3, 0.4, 1] } }],
};
const legacyGraphMigration = migratePassGraphFromLegacy(legacyGraphProject, { image: legacyGraphDocument });
const migratedSample = legacyGraphMigration.graphDocuments.image.nodes.find((node) => node.type === 'input.channel-sample');
assert.ok(migratedSample, 'migration injects a sample when the M3 graph had none');
assert.equal(legacyGraphMigration.passGraph.edges[0].endpoint.nodeId, migratedSample.id);
assert.equal(legacyGraphMigration.passGraph.edges[0].slot.index, 2);
const legacyGraphResolution = resolvePassGraph(legacyGraphMigration.passGraph, legacyGraphProject, legacyGraphMigration.graphDocuments);
assert.equal(legacyGraphResolution.ok, true);
const legacyCompileOptions = {
  channelEnvironment: legacyGraphResolution.resolved.channelEnvironment.image,
  channelEnvironmentRevision: legacyGraphResolution.resolved.revision,
};
assert.equal(classifyPersistedGraph(legacyGraphMigration.graphDocuments.image, legacyCompileOptions).kind, 'editable');
const repeatedLegacyMigration = migratePassGraphFromLegacy(legacyGraphProject, { image: legacyGraphDocument });
assert.equal(repeatedLegacyMigration.passGraph.edges[0].endpoint.nodeId, migratedSample.id, 'injected endpoint identity is deterministic');
const connectedLegacyDocument = sampleGraph('image', 'old-m3-sample');
const connectedLegacyMigration = migratePassGraphFromLegacy(legacyGraphProject, { image: connectedLegacyDocument });
const connectedMigratedId = connectedLegacyMigration.passGraph.edges[0].endpoint.nodeId;
assert.ok(connectedLegacyMigration.graphDocuments.image.edges.some((edge) => edge.from.nodeId === connectedMigratedId), 'migration renames and preserves existing sample expression wiring');
const connectedLegacyResolution = resolvePassGraph(connectedLegacyMigration.passGraph, legacyGraphProject, connectedLegacyMigration.graphDocuments);
assert.equal(connectedLegacyResolution.ok, true);
assert.equal(compileGraph(connectedLegacyMigration.graphDocuments.image, {
  channelEnvironment: connectedLegacyResolution.resolved.channelEnvironment.image,
  channelEnvironmentRevision: connectedLegacyResolution.resolved.revision,
}).ok, true);

// UI and authoring conversions rebuild the endpoint union from the target's current authoring.
const uiProject = createProject('pass graph ui');
uiProject.passes.bufferA.enabled = true;
const uiDocument = createPassGraphDocument();
const codeSelection = endpointSelectionForTarget(uiDocument, uiProject, {}, 'image', 2);
assert.deepEqual(codeSelection, { endpoint: { kind: 'code-slot', slot: 2 }, slot: { mode: 'manual', index: 2 } });
const uiEdge = { id: 'ui-edge', source: 'bufferA', target: 'image', ...codeSelection, filter: 'linear', wrap: 'repeat', timing: 'current' };
uiDocument.edges.push(uiEdge);
assert.deepEqual(endpointChangedForTarget(uiEdge, uiProject, '3').slot, { mode: 'manual', index: 3 });
const graphTransition = convertPassGraphTargetToGraph(uiDocument, 'image', legacyGraphDocument);
const graphNodeId = graphTransition.passGraph.edges[0].endpoint.nodeId;
assert.ok(graphTransition.graphDocument.nodes.some((node) => node.id === graphNodeId && node.type === 'input.channel-sample'));
const graphUiProject = { ...uiProject, passes: { ...uiProject.passes, image: { ...uiProject.passes.image, authoring: { kind: 'graph', graphFile: 'graphs/image.shadergraph.json', graphFormatVersion: 1 } } } };
const graphTransitionResolution = resolvePassGraph(graphTransition.passGraph, graphUiProject, { image: graphTransition.graphDocument });
assert.equal(graphTransitionResolution.ok, true);
const codeTransition = convertPassGraphTargetToCode(graphTransition.passGraph, 'image', graphTransitionResolution.resolved);
assert.deepEqual(codeTransition.edges[0].endpoint, { kind: 'code-slot', slot: 2 });
assert.deepEqual(codeTransition.edges[0].slot, { mode: 'manual', index: 2 });
const retargetedGraph = retargetPassGraphEdge(
  { ...uiDocument, edges: [uiEdge] }, uiEdge, 'image', graphUiProject,
  { image: graphTransition.graphDocument },
);
assert.equal(retargetedGraph.endpoint.kind, 'graph-channel');

// Deterministic auto slots are independent from source array order.
const reversed = { ...passGraph, edges: [...passGraph.edges].reverse() };
assert.deepEqual(resolvePassGraph(reversed, project, docs).resolved.edges, resolved.resolved.edges);
const duplicateSlot = { ...passGraph, edges: passGraph.edges.map((edge) => ({ ...edge, slot: { mode: 'manual', index: 0 } })) };
// Different targets may use the same slot; duplicate within one target is rejected.
duplicateSlot.edges.push({ ...duplicateSlot.edges[1], id: 'dup-slot', source: 'bufferA', endpoint: { kind: 'graph-channel', nodeId: 'another-node' } });
const duplicateDocs = { ...docs, image: { ...docs.image, nodes: [...docs.image.nodes, { id: 'another-node', type: 'input.channel-sample', typeVersion: 1, position: { x: 0, y: 100 }, values: { uv: [0, 0] } }] } };
assert.ok(resolvePassGraph(duplicateSlot, project, duplicateDocs).diagnostics.some((item) => item.code === 'pass-graph.duplicate-slot'));
const duplicateEndpoint = { ...passGraph, edges: [...passGraph.edges, { ...passGraph.edges[1], id: 'dup-endpoint' }] };
assert.ok(resolvePassGraph(duplicateEndpoint, project, docs).diagnostics.some((item) => item.code === 'pass-graph.duplicate-endpoint'));

const cycleProject = createProject('cycle');
cycleProject.passes.bufferA.enabled = true; cycleProject.passes.bufferB.enabled = true;
const cycleGraph = createPassGraphDocument();
cycleGraph.edges = [
  { id: 'a-b', source: 'bufferA', target: 'bufferB', endpoint: { kind: 'code-slot', slot: 0 }, slot: { mode: 'manual', index: 0 }, filter: 'linear', wrap: 'repeat', timing: 'current' },
  { id: 'b-a', source: 'bufferB', target: 'bufferA', endpoint: { kind: 'code-slot', slot: 0 }, slot: { mode: 'manual', index: 0 }, filter: 'linear', wrap: 'repeat', timing: 'current' },
];
assert.ok(resolvePassGraph(cycleGraph, cycleProject).diagnostics.some((item) => item.code === 'pass-graph.current-cycle'));
cycleGraph.edges[1].timing = 'previous';
assert.equal(resolvePassGraph(cycleGraph, cycleProject).ok, true, 'previous edge breaks the current DAG and is explicit feedback');
const codeSlotMismatch = { ...createPassGraphDocument(), edges: [{ ...cycleGraph.edges[1], id: 'slot-mismatch', endpoint: { kind: 'code-slot', slot: 1 }, slot: { mode: 'manual', index: 2 } }] };
assert.ok(resolvePassGraph(codeSlotMismatch, cycleProject).diagnostics.some((item) => item.code === 'pass-graph.code-slot-mismatch'));
const codeAutoSlot = { ...createPassGraphDocument(), edges: [{ ...cycleGraph.edges[1], id: 'slot-auto', endpoint: { kind: 'code-slot', slot: 1 }, slot: { mode: 'auto' } }] };
assert.ok(resolvePassGraph(codeAutoSlot, cycleProject).diagnostics.some((item) => item.code === 'pass-graph.code-slot-mismatch'));
cycleGraph.edges[0] = { ...cycleGraph.edges[0], source: 'bufferB', target: 'bufferB' };
assert.ok(resolvePassGraph(cycleGraph, cycleProject).diagnostics.some((item) => item.code === 'pass-graph.current-self-loop'));
const disabledProject = createProject('disabled');
disabledProject.passes.bufferA.enabled = false;
assert.ok(resolvePassGraph({ ...createPassGraphDocument(), edges: [passGraph.edges[1]] }, disabledProject, docs).diagnostics.some((item) => item.code === 'pass-graph.source-disabled'));
assert.throws(() => parsePassGraph({ ...passGraph, edges: [{ ...passGraph.edges[0], source: 'image' }] }), /无效连接/, 'Image is never a valid channel source');

// Compiler identity includes the resolved channel environment while GraphDocument remains pass-local.
const imageA = compileGraph(docs.image, { channelEnvironment: { 'image-channel': 0 }, channelEnvironmentRevision: 'env-a' });
const imageB = compileGraph(docs.image, { channelEnvironment: { 'image-channel': 1 }, channelEnvironmentRevision: 'env-b' });
const bufferArtifact = compileGraph(docs.bufferA, { channelEnvironment: { 'buffer-channel': 0 }, channelEnvironmentRevision: resolved.resolved.revision });
assert.equal(imageA.ok && imageB.ok && bufferArtifact.ok, true);
assert.match(imageA.source, /texture\(iChannel0,/);
assert.match(imageB.source, /texture\(iChannel1,/);
assert.notEqual(imageA.artifact.revision, imageB.artifact.revision);
assert.equal(imageA.artifact.pass, 'image');
assert.equal(bufferArtifact.sourceMap.pass, 'bufferA');
assert.ok(imageA.sourceMap.entries.some((entry) => entry.nodeId === 'image-channel'));
assert.equal(classifyPersistedGraph(docs.image, {
  channelEnvironment: resolved.resolved.channelEnvironment.image,
  channelEnvironmentRevision: resolved.resolved.revision,
}).kind, 'editable');
assert.equal(classifyPersistedGraph(docs.image).kind, 'readonly-recovery', 'connected persisted channel sample requires the shared open/cohort environment');

// Identity recovery planning resolves and classifies every editor/recovery document in one exact environment.
const identityMismatchProject = {
  ...project,
  passGraph: { file: 'graphs/pass-graph.json', formatVersion: 1, revision: 'stale-reference' },
};
const identityReasons = { image: 'identity-mismatch', bufferA: 'identity-mismatch' };
const identityRecoveryPlan = planPassGraphIdentityRecovery(passGraph, identityMismatchProject, {}, docs, identityReasons);
assert.equal(identityRecoveryPlan.kind, 'promote', 'a legal candidate repairs stale persisted identity');
assert.equal(identityRecoveryPlan.resolution.resolved.revision, resolved.resolved.revision);
assert.deepEqual(Object.keys(identityRecoveryPlan.documents).sort(), ['bufferA', 'image'], 'every identity recovery document promotes together');

const selectiveRecoveryPlan = planPassGraphIdentityRecovery(
  passGraph,
  identityMismatchProject,
  {},
  docs,
  { image: 'identity-mismatch', bufferA: 'runtime-rejected' },
);
assert.equal(selectiveRecoveryPlan.kind, 'promote');
assert.deepEqual(Object.keys(selectiveRecoveryPlan.documents), ['image'], 'runtime-rejected recovery remains readonly during identity repair');

const invalidTopologyRecoveryPlan = planPassGraphIdentityRecovery(duplicateEndpoint, identityMismatchProject, {}, docs, identityReasons);
assert.equal(invalidTopologyRecoveryPlan.kind, 'blocked');
assert.deepEqual(invalidTopologyRecoveryPlan.documents, {}, 'invalid topology cannot promote any recovery document');
assert.ok(invalidTopologyRecoveryPlan.resolution.diagnostics.some((item) => item.code === 'pass-graph.duplicate-endpoint'));

const invalidRecoveryDocument = {
  ...docs.bufferA,
  nodes: docs.bufferA.nodes.filter((node) => node.type !== 'output.fragment'),
  edges: [],
};
const invalidClassification = classifyPersistedGraph(invalidRecoveryDocument, {
  channelEnvironment: resolved.resolved.channelEnvironment.bufferA,
  channelEnvironmentRevision: resolved.resolved.revision,
});
const priorityDecision = persistedGraphRecoveryDecision(invalidClassification, false);
assert.equal(priorityDecision.kind, 'readonly-recovery');
assert.equal(priorityDecision.reason, 'compiler-invalid', 'compiler rejection takes priority over identity mismatch');
assert.ok(priorityDecision.diagnostics.length);

const compileInvalidRecoveryPlan = planPassGraphIdentityRecovery(
  passGraph,
  identityMismatchProject,
  {},
  { image: docs.image, bufferA: invalidRecoveryDocument },
  identityReasons,
);
assert.equal(compileInvalidRecoveryPlan.kind, 'blocked');
assert.deepEqual(compileInvalidRecoveryPlan.documents, {}, 'one compiler-invalid recovery blocks the otherwise editable cohort');
assert.ok(compileInvalidRecoveryPlan.diagnostics.bufferA?.length);
assert.equal(compileInvalidRecoveryPlan.diagnostics.image, undefined, 'editable recovery documents are not partially promoted');

const candidateWithoutImageConnection = {
  ...passGraph,
  edges: passGraph.edges.filter((edge) => edge.target !== 'image'),
};
const mixedCohortPlan = planPassGraphIdentityRecovery(
  candidateWithoutImageConnection,
  identityMismatchProject,
  { image: docs.image },
  { bufferA: docs.bufferA },
  { bufferA: 'identity-mismatch' },
);
assert.equal(mixedCohortPlan.kind, 'blocked', 'candidate must classify existing dirty editors in the same environment');
assert.deepEqual(mixedCohortPlan.documents, {});
assert.ok(mixedCohortPlan.diagnostics.image?.some((item) =>
  item.code === 'compiler.internal' && /not connected/.test(item.rawDetail ?? '')
));
assert.equal(mixedCohortPlan.diagnostics.bufferA, undefined);

assert.deepEqual(
  clearAcceptedRuntimeRecoveryFlags({ image: true, bufferA: true }, ['image']),
  { bufferA: true },
  'a successful partial cohort must not consume disabled or otherwise non-participating recovery flags',
);
assert.deepEqual(
  clearAcceptedRuntimeRecoveryFlags({ bufferA: true }, []),
  { bufferA: true },
  'an empty cohort must preserve pending recovery flags',
);

// Multi-pass cohort acceptance is all-or-nothing; candidates never enter effective sources before acceptance.
let imageState = graphCompileResolved(createGraphEditorState(docs.image), 0, compileGraph(docs.image, { channelEnvironment: { 'image-channel': 0 }, channelEnvironmentRevision: resolved.resolved.revision }));
let bufferState = graphCompileResolved(createGraphEditorState(docs.bufferA), 0, bufferArtifact);
const states = { image: imageState, bufferA: bufferState };
const candidates = { image: { generation: 0, artifact: imageState.lastSuccessfulArtifact }, bufferA: { generation: 0, artifact: bufferState.lastSuccessfulArtifact } };
assert.deepEqual(acceptedGeneratedSources(states), {});
const rejected = acceptGraphCohort(states, candidates, false);
assert.deepEqual(acceptedGeneratedSources(rejected), {});
const accepted = acceptGraphCohort(states, candidates, true);
assert.equal(graphCohortReady(accepted, ['image', 'bufferA']), true);
assert.equal(acceptedGeneratedSources(accepted).bufferA, bufferArtifact.source);
const staleCandidates = { ...candidates, image: { generation: 1, artifact: candidates.image.artifact } };
assert.equal(acceptGraphCohort(states, staleCandidates, true), states, 'mixed generation cohort is rejected atomically');

// Export ticket freezes every graph identity, Pass Graph revision and effective source cohort.
const identities = ['bufferA', 'image'].map((pass) => ({ pass, generation: 0, revision: accepted[pass].runtimeAcceptedArtifact.revision, sourceHash: accepted[pass].runtimeAcceptedArtifact.sourceHash }));
const exportInput = { authoring: 'graph', runtimeSetupRevision: 7, successfulRuntimeSetupRevision: 7, compileStatus: 'ready', hasCompileError: false, hasUniformConflict: false, graphArtifacts: identities, passGraphRevision: resolved.resolved.revision, effectiveSourcesHash: 'cohort-1', graphAccepted: true };
const eligibility = exportEligibility(exportInput);
assert.equal(eligibility.eligible, true);
assert.ok(Object.isFrozen(eligibility.ticket.graphArtifacts));
assert.equal(validateExportTicket(eligibility.ticket, { ...exportInput, passGraphRevision: 'changed' }).eligible, false);
assert.equal(validateExportTicket(eligibility.ticket, { ...exportInput, effectiveSourcesHash: 'cohort-2' }).eligible, false);
assert.equal(validateExportTicket(eligibility.ticket, { ...exportInput, graphArtifacts: identities.map((item) => item.pass === 'image' ? { ...item, generation: 1 } : item) }).eligible, false);

// Runtime planning and the executor share one complete texture-selection matrix.
const runtimeSetup = buildRuntimeSetup(project, sourcesWithDefaults({ image: imageA.source, bufferA: bufferArtifact.source }), [], {}, [], resolved.resolved);
const framePlan = planRuntimeFrame(runtimeSetup);
assert.deepEqual(framePlan.map((step) => step.pass), ['bufferA', 'image']);
assert.equal(framePlan[0].channels[0].texture, 'previous');
assert.equal(framePlan[1].channels[0].texture, 'current');
assert.equal(runtimeSetup.options.bufferA.channels[0].filter, 'nearest');
assert.equal(runtimeSetup.options.bufferA.channels[0].wrap, 'clamp');
for (const read of [0, 1]) {
  const afterFlip = read ^ 1;
  const bufferCurrent = selectChannelTexture('buffer-before-flip', 'current', read);
  const bufferPrevious = selectChannelTexture('buffer-before-flip', 'previous', read);
  const imageCurrent = selectChannelTexture('image-after-flip', 'current', afterFlip);
  const imagePrevious = selectChannelTexture('image-after-flip', 'previous', afterFlip);
  assert.deepEqual(bufferCurrent, { role: 'write', textureIndex: afterFlip });
  assert.deepEqual(bufferPrevious, { role: 'previous', textureIndex: read });
  assert.deepEqual(imageCurrent, { role: 'current', textureIndex: afterFlip });
  assert.deepEqual(imagePrevious, { role: 'previous', textureIndex: read });
}
assert.equal(captureFrameNeedsReset(false, -1, 0), true);
assert.equal(captureFrameNeedsReset(true, 3, 4), false);
assert.equal(captureFrameNeedsReset(true, 3, 3), true, 'repeat capture frame replays from a clean history');
assert.equal(captureFrameNeedsReset(true, 3, 1), true, 'backward capture seeks replay from a clean history');

const timingProject = createProject('timing matrix');
timingProject.passes.bufferA.enabled = true;
timingProject.passes.bufferB.enabled = true;
const timingGraph = createPassGraphDocument();
timingGraph.edges = [
  { id: 'a-b-current', source: 'bufferA', target: 'bufferB', endpoint: { kind: 'code-slot', slot: 0 }, slot: { mode: 'manual', index: 0 }, filter: 'linear', wrap: 'repeat', timing: 'current' },
  { id: 'a-b-previous', source: 'bufferA', target: 'bufferB', endpoint: { kind: 'code-slot', slot: 1 }, slot: { mode: 'manual', index: 1 }, filter: 'nearest', wrap: 'clamp', timing: 'previous' },
  { id: 'b-image-current', source: 'bufferB', target: 'image', endpoint: { kind: 'code-slot', slot: 0 }, slot: { mode: 'manual', index: 0 }, filter: 'linear', wrap: 'repeat', timing: 'current' },
  { id: 'b-image-previous', source: 'bufferB', target: 'image', endpoint: { kind: 'code-slot', slot: 1 }, slot: { mode: 'manual', index: 1 }, filter: 'nearest', wrap: 'clamp', timing: 'previous' },
];
const timingResolved = resolvePassGraph(timingGraph, timingProject);
assert.deepEqual(timingResolved.resolved.bufferOrder, ['bufferA', 'bufferB']);
const timingSetup = buildRuntimeSetup(timingProject, sourcesWithDefaults({ image: 'image', bufferA: 'a', bufferB: 'b' }), [], {}, [], timingResolved.resolved);
const timingFrame = planRuntimeFrame(timingSetup);
assert.deepEqual(timingFrame.map((step) => step.pass), ['bufferA', 'bufferB', 'image']);
assert.deepEqual(timingFrame[1].channels.map((channel) => channel.texture), ['write', 'previous']);
assert.deepEqual(timingFrame[2].channels.map((channel) => channel.texture), ['current', 'previous']);

// Drive the real executor exclusively through public APIs while fake WebGL records
// attachments, texture units, samplers and resource lifetime.
{
  const ioWindow = globalThis.window;
  const ioBridge = globalThis.window.__slpMockBridge;
  const fake = installFakeWebGL({ width: 320, height: 180 });
  let runtime;
  try {
    runtime = new ShadertoyRuntime(fake.canvas);
    const result = runtime.compile({
      sources: {
        common: '',
        bufferA: '/* @fake-pass bufferA */ void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }',
        bufferB: '/* @fake-pass bufferB */ void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }',
        image: '/* @fake-pass image */ void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }',
      },
      options: {
        bufferA: { channels: [] },
        bufferB: { channels: [
          { index: 0, type: 'buffer', src: 'bufferA', timing: 'current', filter: 'linear', wrap: 'repeat' },
          { index: 1, type: 'buffer', src: 'bufferA', timing: 'previous', filter: 'nearest', wrap: 'clamp' },
        ] },
        image: { channels: [
          { index: 0, type: 'buffer', src: 'bufferB', timing: 'current', filter: 'linear', wrap: 'repeat' },
          { index: 1, type: 'buffer', src: 'bufferB', timing: 'previous', filter: 'nearest', wrap: 'clamp' },
        ] },
      },
      timingPlan: { bufferOrder: ['bufferA', 'bufferB'], revision: 'executor-regression' },
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

    const passPrograms = Object.fromEntries(
      fake.programs.filter((program) => ['bufferA', 'bufferB', 'image'].includes(program.pass)).map((program) => [program.pass, program]),
    );
    for (const pass of ['bufferA', 'bufferB', 'image']) {
      assert.deepEqual(
        [0, 1, 2, 3].map((slot) => passPrograms[pass].uniforms.get(`iChannel${slot}`)),
        [0, 1, 2, 3],
        `${pass} sampler uniforms must map to texture units 0..3`,
      );
    }

    const previewTextureIds = new Set(fake.textures.filter((texture) => texture.width === 320 && texture.height === 180).map((texture) => texture.id));
    assert.equal(previewTextureIds.size, 4, 'two preview buffers allocate exactly four ping-pong textures');
    const dummy = fake.textures.find((texture) => texture.width === 1 && texture.height === 1);
    assert.ok(dummy, 'runtime allocates a dummy texture for unused channel slots');

    runtime.probePixel('image');
    runtime.probePixel('image');
    const previewDraws = fake.draws.filter((draw) => ['bufferA', 'bufferB', 'image'].includes(draw.pass));
    assert.deepEqual(previewDraws.map((draw) => draw.pass), ['bufferA', 'bufferB', 'image', 'bufferA', 'bufferB', 'image']);
    const [a1, b1, image1, a2, b2, image2] = previewDraws;

    assert.equal(b1.textures[0], a1.attachment, 'Buffer B current reads Buffer A write texture before the global flip');
    assert.notEqual(b1.textures[1], a1.attachment, 'Buffer B previous reads the other Buffer A texture');
    assert.equal(image1.textures[0], b1.attachment, 'Image current reads Buffer B after the global flip');
    assert.notEqual(image1.textures[1], b1.attachment, 'Image previous reads Buffer B previous texture');
    assert.notEqual(a2.attachment, a1.attachment, 'Buffer A ping-pong attachment flips between frames');
    assert.notEqual(b2.attachment, b1.attachment, 'Buffer B ping-pong attachment flips between frames');
    assert.equal(b2.textures[0], a2.attachment);
    assert.equal(b2.textures[1], a1.attachment);
    assert.equal(image2.textures[0], b2.attachment);
    assert.equal(image2.textures[1], b1.attachment);

    const samplerById = new Map(fake.samplers.map((sampler) => [sampler.id, sampler]));
    for (const draw of [b1, image1, b2, image2]) {
      const linearRepeat = samplerById.get(draw.samplers[0]);
      const nearestClamp = samplerById.get(draw.samplers[1]);
      assert.equal(linearRepeat.params.get(fake.gl.TEXTURE_MIN_FILTER), fake.gl.LINEAR);
      assert.equal(linearRepeat.params.get(fake.gl.TEXTURE_MAG_FILTER), fake.gl.LINEAR);
      assert.equal(linearRepeat.params.get(fake.gl.TEXTURE_WRAP_S), fake.gl.REPEAT);
      assert.equal(linearRepeat.params.get(fake.gl.TEXTURE_WRAP_T), fake.gl.REPEAT);
      assert.equal(nearestClamp.params.get(fake.gl.TEXTURE_MIN_FILTER), fake.gl.NEAREST);
      assert.equal(nearestClamp.params.get(fake.gl.TEXTURE_MAG_FILTER), fake.gl.NEAREST);
      assert.equal(nearestClamp.params.get(fake.gl.TEXTURE_WRAP_S), fake.gl.CLAMP_TO_EDGE);
      assert.equal(nearestClamp.params.get(fake.gl.TEXTURE_WRAP_T), fake.gl.CLAMP_TO_EDGE);
      assert.deepEqual(draw.textures.slice(2), [dummy.id, dummy.id]);
      assert.deepEqual(draw.samplers.slice(2), [null, null]);
    }

    const previewSecondFramePreviousLabel = a2.outputLabel;
    const beforeCaptureDrawCount = fake.draws.length;
    const frame0Blob = await runtime.captureAt(0, 0, 1 / 60, { width: 640, height: 360 });
    assert.ok(frame0Blob);
    assert.equal(fake.canvas.width, 640);
    assert.equal(fake.canvas.height, 360);
    assert.equal(fake.parent.children.filter((child) => child !== fake.canvas).length, 1, 'capture freezes the visible preview');

    const captureFrame0Draws = fake.draws.slice(beforeCaptureDrawCount).filter((draw) => ['bufferA', 'bufferB', 'image'].includes(draw.pass));
    assert.deepEqual(captureFrame0Draws.map((draw) => draw.pass), ['bufferA', 'bufferB', 'image']);
    const [captureA0, captureB0] = captureFrame0Draws;
    const captureTextureIds = new Set(fake.textures.filter((texture) => texture.width === 640 && texture.height === 360).map((texture) => texture.id));
    const previewFramebufferIds = new Set([a1.framebuffer, b1.framebuffer]);
    const captureFramebufferIds = new Set(captureFrame0Draws.filter((draw) => draw.framebuffer).map((draw) => draw.framebuffer));
    assert.equal(captureTextureIds.size, 4, 'capture allocates a separate full-size ping-pong set');
    assert.equal(captureFramebufferIds.size, 2, 'capture allocates separate framebuffers');
    assert.equal([...captureTextureIds].some((id) => previewTextureIds.has(id)), false);
    assert.equal([...captureFramebufferIds].some((id) => previewFramebufferIds.has(id)), false);

    const textureCountBeforeFrame1 = fake.textures.length;
    const framebufferCountBeforeFrame1 = fake.framebuffers.length;
    const captureAllocationsBeforeFrame1 = new Map(
      fake.textures.filter((texture) => captureTextureIds.has(texture.id)).map((texture) => [texture.id, texture.allocations]),
    );
    const frame1Start = fake.draws.length;
    const frame1Blob = await runtime.captureAt(1 / 60, 1, 1 / 60, { width: 640, height: 360 });
    assert.ok(frame1Blob);
    const captureFrame1Draws = fake.draws.slice(frame1Start).filter((draw) => ['bufferA', 'bufferB', 'image'].includes(draw.pass));
    assert.deepEqual(captureFrame1Draws.map((draw) => draw.pass), ['bufferA', 'bufferB', 'image']);
    assert.equal(fake.textures.length, textureCountBeforeFrame1, 'forward capture frame reuses capture textures');
    assert.equal(fake.framebuffers.length, framebufferCountBeforeFrame1, 'forward capture frame reuses capture framebuffers');
    for (const texture of fake.textures.filter((item) => captureTextureIds.has(item.id))) {
      assert.equal(texture.allocations, captureAllocationsBeforeFrame1.get(texture.id), 'forward capture does not reallocate feedback textures');
    }

    const [captureA1, captureB1, captureImage1] = captureFrame1Draws;
    assert.notEqual(captureA1.attachment, captureA0.attachment, 'capture Buffer A attachment flips on frame 1');
    assert.notEqual(captureB1.attachment, captureB0.attachment, 'capture Buffer B attachment flips on frame 1');
    assert.equal(captureB1.textures[0], captureA1.attachment, 'capture frame 1 Buffer B current reads Buffer A frame 1');
    assert.equal(captureB1.textures[1], captureA0.attachment, 'capture frame 1 Buffer B previous reads Buffer A frame 0');
    assert.equal(captureB1.textureLabels[1], captureA0.outputLabel, 'capture Buffer B previous preserves frame 0 contents');
    assert.equal(captureImage1.textures[0], captureB1.attachment, 'capture frame 1 Image current reads Buffer B frame 1');
    assert.equal(captureImage1.textures[1], captureB0.attachment, 'capture frame 1 Image previous reads Buffer B frame 0');
    assert.equal(captureImage1.textureLabels[1], captureB0.outputLabel, 'capture Image previous preserves frame 0 contents');

    const captureDraws = [...captureFrame0Draws, ...captureFrame1Draws];
    for (const draw of captureDraws) {
      assert.equal(captureTextureIds.has(draw.attachment), draw.pass !== 'image');
      assert.equal(draw.textures.some((id) => previewTextureIds.has(id)), false, 'capture never samples preview feedback textures');
    }

    const snapshotTexture = fake.textures.find((texture) =>
      texture.width === 320 && texture.height === 180
      && !previewTextureIds.has(texture.id));
    assert.ok(snapshotTexture, 'capture snapshots the paused preview frame');
    runtime.endCapture();
    assert.equal(fake.canvas.width, 320);
    assert.equal(fake.canvas.height, 180);
    assert.deepEqual(fake.parent.children, [fake.canvas], 'capture overlay is removed');
    assert.ok([...captureTextureIds].every((id) => fake.deletedTextures.has(id)), 'capture textures are deleted on cancellation/end');
    assert.ok([...captureFramebufferIds].every((id) => fake.deletedFramebuffers.has(id)), 'capture framebuffers are deleted on cancellation/end');
    assert.ok([...previewTextureIds].every((id) => !fake.deletedTextures.has(id)), 'preview feedback textures survive capture');
    assert.ok([...previewFramebufferIds].every((id) => !fake.deletedFramebuffers.has(id)), 'preview framebuffers survive capture');
    assert.ok(fake.deletedTextures.has(snapshotTexture.id), 'preview snapshot texture is released');

    const resumeStart = fake.draws.length;
    runtime.probePixel('image');
    const resumed = fake.draws.slice(resumeStart).filter((draw) => ['bufferA', 'bufferB', 'image'].includes(draw.pass));
    assert.deepEqual(resumed.map((draw) => draw.pass), ['bufferA', 'bufferB', 'image']);
    assert.equal(resumed[0].attachment, a1.attachment, 'preview resumes its own next ping-pong write target');
    assert.equal(resumed[1].textures[1], a2.attachment, 'preview previous channel continues from the pre-capture frame');
    assert.equal(resumed[1].textureLabels[1], previewSecondFramePreviousLabel, 'preview history was neither reset nor replaced by capture history');
    for (const draw of resumed) {
      assert.equal(captureTextureIds.has(draw.attachment), false);
      assert.equal(draw.textures.some((id) => captureTextureIds.has(id)), false);
    }
  } finally {
    try {
      runtime?.endCapture();
      runtime?.dispose();
    } finally {
      fake.restore();
    }
  }
  assert.equal(globalThis.window, ioWindow, 'executor harness preserves the I/O mock window');
  assert.equal(globalThis.window.__slpMockBridge, ioBridge, 'executor harness preserves the I/O bridge');
}

// Disabled Graph authoring persists a deterministic compiler artifact without pretending Runtime acceptance.
const disabledGraphProject = createProject('disabled graph roundtrip');
disabledGraphProject.passes.bufferA.enabled = false;
disabledGraphProject.passes.bufferA.authoring = {
  kind: 'graph',
  graphFile: 'graphs/buffer_a.shadergraph.json',
  graphFormatVersion: 1,
};
const disabledGraphDocument = {
  ...createEmptyGraph('bufferA'),
  nodes: [{
    id: 'disabled-out',
    type: 'output.fragment',
    typeVersion: 1,
    position: { x: 240, y: 0 },
    values: { color: [0.1, 0.2, 0.3, 1] },
  }],
};
const disabledPassGraph = createPassGraphDocument();
const disabledResolution = resolvePassGraph(disabledPassGraph, disabledGraphProject, { bufferA: disabledGraphDocument });
assert.equal(disabledResolution.ok, true);
const disabledState = createGraphEditorState(disabledGraphDocument);
const disabledCompileOptions = {
  channelEnvironment: disabledResolution.resolved.channelEnvironment.bufferA,
  channelEnvironmentRevision: disabledResolution.resolved.revision,
};
const disabledPersistence = selectGraphPersistenceArtifact(disabledState, false, disabledCompileOptions);
assert.equal(disabledPersistence.ok, true);
assert.equal(disabledPersistence.kind, 'authoring-compiled');
const runtimeRequiredPersistence = selectGraphPersistenceArtifact(disabledState, true, disabledCompileOptions);
assert.equal(runtimeRequiredPersistence.ok, false, 'the same state cannot satisfy enabled Runtime-required persistence');
assert.ok(runtimeRequiredPersistence.diagnostics.length);

const disabledDir = 'C:\\M5DisabledGraph';
await saveProjectTo(
  disabledDir,
  disabledGraphProject,
  sourcesWithDefaults({ image: 'void mainImage(out vec4 c,in vec2 p){c=vec4(0.);}' }),
  {
    graphDocuments: { bufferA: disabledGraphDocument },
    graphArtifacts: { bufferA: disabledPersistence.artifact },
    passGraph: disabledPassGraph,
  },
);
const openedDisabled = await openProjectFrom(disabledDir);
assert.equal(openedDisabled.meta.passes.bufferA.enabled, false);
assert.deepEqual(openedDisabled.graphDocuments.bufferA, disabledGraphDocument);
assert.equal(openedDisabled.sources.bufferA, disabledPersistence.artifact.source);
assert.equal(openedDisabled.meta.passes.bufferA.authoring.generatedHash, disabledPersistence.artifact.sourceHash);
assert.equal(openedDisabled.passGraphIdentityValid, true);
assert.equal(openedDisabled.graphIssues.length, 0, JSON.stringify(openedDisabled.graphIssues));

// Atomic persistence writes every Graph JSON, generated fallback and Pass Graph before meta; open/autosave restore all documents.
const assetProject = createProject('legacy texture preservation');
assetProject.passes.image.channels = [{ index: 3, type: 'texture', src: 'assets/noise.png', filter: 'nearest', wrap: 'clamp' }];
const assetDir = 'C:\\M5LegacyAsset';
await saveProjectTo(assetDir, assetProject, sourcesWithDefaults({ image: 'void mainImage(out vec4 c,in vec2 p){c=vec4(0.);}' }));
const savedAssetMeta = JSON.parse(files.get(joinPath(assetDir, PROJECT_CONFIG_FILE)));
assert.deepEqual(savedAssetMeta.passes.image.channels, assetProject.passes.image.channels, 'unsupported legacy asset channels are preserved losslessly');
const assetPassGraphPath = joinPath(assetDir, savedAssetMeta.passGraph.file);
const savedAssetPassGraph = files.get(assetPassGraphPath);
files.set(assetPassGraphPath, '{broken');
const brokenEmptyPassGraphOpen = await openProjectFrom(assetDir);
assert.equal(brokenEmptyPassGraphOpen.passGraphIdentityValid, false, 'a replacement empty document cannot impersonate a missing/corrupt referenced PassGraph');
assert.ok(brokenEmptyPassGraphOpen.graphIssues.some((issue) => issue.code === 'pass-graph.invalid-json'));
files.set(assetPassGraphPath, savedAssetPassGraph);
const artifacts = { image: accepted.image.runtimeAcceptedArtifact, bufferA: accepted.bufferA.runtimeAcceptedArtifact };
const dir = 'C:\\M5Project';
await saveProjectTo(dir, project, sourcesWithDefaults({ image: imageA.source, bufferA: bufferArtifact.source }), { graphDocuments: docs, graphArtifacts: artifacts, passGraph });
const batch = atomicCalls.at(-1);
assert.equal(batch.at(-1).path, joinPath(dir, PROJECT_CONFIG_FILE));
assert.ok(batch.some((entry) => entry.path === joinPath(dir, 'graphs/pass-graph.json')));
assert.ok(batch.some((entry) => entry.path === joinPath(dir, 'graphs/image.shadergraph.json')));
assert.ok(batch.some((entry) => entry.path === joinPath(dir, 'graphs/buffer_a.shadergraph.json')));
const opened = await openProjectFrom(dir);
assert.equal(opened.graphDocuments.image.pass, 'image');
assert.equal(opened.graphDocuments.bufferA.pass, 'bufferA');
assert.equal(opened.passGraph.edges.length, 2);
assert.equal(opened.graphIssues.length, 0);
assert.equal(opened.passGraphIdentityValid, true);
assert.equal(classifyPersistedGraph(opened.graphDocuments.image, {
  channelEnvironment: opened.resolvedPassGraph.channelEnvironment.image,
  channelEnvironmentRevision: opened.resolvedPassGraph.revision,
}).kind, 'editable', 'saved channel-sample Graph reopens editable with the exact open/cohort environment');
await writeAutosave(dir, opened.meta, opened.sources, [], docs, passGraph, {
  reasons: { image: 'runtime-rejected' },
  diagnostics: { image: [{
    message: 'persisted runtime rejection',
    severity: 'error',
    stage: 'runtime',
    code: 'graph.runtime-rejected-recovery',
    origin: { kind: 'graph', pass: 'image', nodeId: 'image-channel' },
  }] },
});
const autosave = await readLatestAutosave(dir);
assert.equal(autosave.version, 2);
assert.equal(autosave.graphDocuments.bufferA.pass, 'bufferA');
assert.equal(autosave.graphRecovery.reasons.image, 'runtime-rejected');
assert.equal(autosave.graphRecovery.diagnostics.image[0].code, 'graph.runtime-rejected-recovery');
assert.deepEqual(autosave.graphRecovery.diagnostics.image[0].origin, {
  kind: 'graph', pass: 'image', nodeId: 'image-channel',
});
assert.equal(parsePassGraph(autosave.passGraph).edges.length, 2);
const autosaveResolution = resolvePassGraph(parsePassGraph(autosave.passGraph), autosave.meta, docs);
assert.equal(autosave.meta.passGraph.revision, autosaveResolution.resolved.revision, 'autosave meta identifies its own PassGraph snapshot');
assert.deepEqual(passGraphReferenceIssues(autosave.meta.passGraph, parsePassGraph(autosave.passGraph), autosaveResolution.resolved), []);

// Referenced topology drift and future reference versions enter explicit recovery.
const savedPassGraphText = files.get(joinPath(dir, 'graphs/pass-graph.json'));
const driftedPassGraph = parsePassGraph(savedPassGraphText);
driftedPassGraph.edges[0].filter = driftedPassGraph.edges[0].filter === 'linear' ? 'nearest' : 'linear';
files.set(joinPath(dir, 'graphs/pass-graph.json'), serializePassGraph(driftedPassGraph));
const driftedOpen = await openProjectFrom(dir);
assert.equal(driftedOpen.passGraphIdentityValid, false);
assert.ok(driftedOpen.graphIssues.some((issue) => issue.code === 'pass-graph.reference-revision-mismatch'));
files.set(joinPath(dir, 'graphs/pass-graph.json'), savedPassGraphText);
const savedMetaText = files.get(joinPath(dir, PROJECT_CONFIG_FILE));
const futureReferenceMeta = JSON.parse(savedMetaText);
futureReferenceMeta.passGraph.formatVersion = 99;
files.set(joinPath(dir, PROJECT_CONFIG_FILE), JSON.stringify(futureReferenceMeta));
const futureReferenceOpen = await openProjectFrom(dir);
assert.equal(futureReferenceOpen.passGraphIdentityValid, false);
assert.ok(futureReferenceOpen.graphIssues.some((issue) => issue.code === 'pass-graph.reference-format-mismatch'));
files.set(joinPath(dir, PROJECT_CONFIG_FILE), savedMetaText);

// A no-reference M3 Graph project migrates separately from identity mismatch and is marked for resave.
const legacyDir = 'C:\\M5LegacyGraph';
const legacyFallback = compileGraph(legacyGraphDocument);
assert.equal(legacyFallback.ok, true);
files.set(joinPath(legacyDir, PROJECT_CONFIG_FILE), serializeProject(legacyGraphProject));
files.set(joinPath(legacyDir, legacyGraphProject.passes.image.file ?? 'passes/image.glsl'), legacyFallback.artifact.source);
files.set(joinPath(legacyDir, legacyGraphProject.passes.image.authoring.graphFile), JSON.stringify(legacyGraphDocument));
const openedLegacyGraph = await openProjectFrom(legacyDir);
assert.equal(openedLegacyGraph.passGraphIdentityValid, true, 'legacy projects without references are migration, not identity mismatch');
assert.equal(openedLegacyGraph.needsResave, true);
assert.equal(openedLegacyGraph.passGraph.edges[0].endpoint.kind, 'graph-channel');
assert.ok(openedLegacyGraph.graphDocuments.image.nodes.some((node) => node.type === 'input.channel-sample'));
assert.equal(resolvePassGraph(openedLegacyGraph.passGraph, openedLegacyGraph.meta, openedLegacyGraph.graphDocuments).ok, true, JSON.stringify(openedLegacyGraph.graphIssues));

// Small deterministic performance budget for repeated project resolution + environment compilation.
const samples = [];
for (let index = 0; index < 50; index++) {
  const start = performance.now();
  const plan = resolvePassGraph(passGraph, project, docs);
  compileGraph(docs.image, { channelEnvironment: plan.resolved.channelEnvironment.image, channelEnvironmentRevision: plan.resolved.revision });
  samples.push(performance.now() - start);
}
const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
const maximum = Math.max(...samples);
assert.ok(average < 25, `M5 average pure planning+compile budget exceeded: ${average.toFixed(2)}ms`);
assert.ok(maximum < 150, `M5 max pure planning+compile budget exceeded: ${maximum.toFixed(2)}ms`);
console.log(`M5 pass graph + compile: avg=${average.toFixed(2)}ms max=${maximum.toFixed(2)}ms`);
console.log('M5 schema, migration, cohort, persistence, ticket and Runtime planning checks passed');
