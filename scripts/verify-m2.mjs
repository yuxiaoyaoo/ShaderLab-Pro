import assert from 'node:assert/strict';
import { compileGraph } from '../src/graph/compiler/index.ts';
import { createDefaultImageGraph } from '../src/graph/editor/defaultGraph.ts';
import { applyGraphCommand } from '../src/graph/editor/commands.ts';
import { createGraphHistory, executeGraphCommand, redoGraphCommand, undoGraphCommand } from '../src/graph/editor/history.ts';
import { preflightConnection } from '../src/graph/editor/connections.ts';
import { createSequentialGraphIdFactory, parseGraphClipboard, pasteGraphSelection, serializeGraphSelection } from '../src/graph/editor/clipboard.ts';
import { blankCanvasPointerSelection, cancelledPointerSelection, nodePointerSelection } from '../src/graph/editor/canvasInteractions.ts';
import { graphBounds, graphNodeHeight } from '../src/graph/editor/geometry.ts';
import { graphParameterTypePatch, parseGraphValueDraft } from '../src/graph/editor/valueDraft.ts';
import { normalizeGraphDocument } from '../src/graph/schema.ts';
import { DEFAULT_NODE_REGISTRY } from '../src/graph/registry.ts';
import { buildRuntimeSetup } from '../src/shadertoy/setupBuilder.ts';
import { buildRuntimeUniformContract, mergeUniformDeclarations } from '../src/shadertoy/uniformContract.ts';
import { createProject, sourcesWithDefaults } from '../src/project/types.ts';
import { isCurrentRuntimeSetupRevision, nextRuntimeSetupRevision, selectGeneratedCodeSource, selectGraphRuntimeCandidate, shouldCommitGraphRuntimeCandidate } from '../src/state/graphRuntimeCoordinator.ts';
import { createGraphEditorState, detachAcceptedGraph, graphCanExport, graphCompileResolved, graphCompileStarted, graphIsStale, graphLayoutChanged, graphRuntimeResolved, graphSemanticChanged } from '../src/state/graphEditorStore.ts';

const defaultGraph = createDefaultImageGraph();
const initialCompile = compileGraph(defaultGraph);
assert.equal(initialCompile.ok, true, initialCompile.diagnostics.map((item) => item.message).join('\n'));
assert.equal(defaultGraph.nodes.filter((node) => node.type === 'output.fragment').length, 1);
assert.match(initialCompile.source, /iTime/);

const floatNode = { id: 'new-float', type: 'value.float', typeVersion: 1, position: { x: 1, y: 2 }, values: { value: 0.5 } };
const added = applyGraphCommand(defaultGraph, { type: 'add-node', node: floatNode });
assert.equal(added.impact, 'semantic');
assert.equal(defaultGraph.nodes.some((node) => node.id === floatNode.id), false, 'commands must be immutable');
assert.equal(added.document.nodes.some((node) => node.id === floatNode.id), true);
const moved = applyGraphCommand(added.document, { type: 'move-nodes', positions: { [floatNode.id]: { x: 30, y: 40 } } });
assert.equal(moved.impact, 'layout');
assert.equal(moved.document.nodes.find((node) => node.id === floatNode.id)?.position.x, 30);
const semanticBeforeMove = compileGraph(added.document).semanticHash;
assert.equal(compileGraph(moved.document).semanticHash, semanticBeforeMove, 'layout must not affect semantic hash');

let history = createGraphHistory();
let current = executeGraphCommand(defaultGraph, history, { type: 'add-node', node: floatNode });
history = current.history;
assert.equal(history.undo.length, 1);
let undone = undoGraphCommand(current.document, history);
assert.equal(undone.document.nodes.some((node) => node.id === floatNode.id), false);
let redone = redoGraphCommand(undone.document, undone.history);
assert.equal(redone.document.nodes.some((node) => node.id === floatNode.id), true);
const branched = executeGraphCommand(undone.document, undone.history, { type: 'set-node-value', nodeId: 'starter-color', key: 'z', value: 0.8 });
assert.equal(branched.history.redo.length, 0, 'new command clears redo');

const withParameter = {
  ...defaultGraph,
  parameters: [{ id: 'param-original', name: 'Gain', valueType: 'float', defaultValue: 0.5, ui: { widget: 'slider', min: 0, max: 1, step: 0.01 } }],
  nodes: [...defaultGraph.nodes, { id: 'param-node', type: 'core.parameter', typeVersion: 1, position: { x: -500, y: 320 }, values: { parameterId: 'param-original' } }, { id: 'param-add', type: 'math.add', typeVersion: 1, position: { x: -250, y: 320 }, values: { b: 1 } }],
  edges: [...defaultGraph.edges, { id: 'param-edge', from: { nodeId: 'param-node', socketId: 'out' }, to: { nodeId: 'param-add', socketId: 'a' } }],
};
const clipText = serializeGraphSelection(withParameter, ['param-node', 'param-add', 'starter-output']);
const clip = parseGraphClipboard(clipText);
assert.ok(clip);
assert.equal(clip.nodes.some((node) => node.type === 'output.fragment'), false, 'output cannot be copied');
assert.equal(clip.parameters.length, 1);
const pasted = pasteGraphSelection(defaultGraph, clip, { offset: { x: 20, y: 30 }, idFactory: createSequentialGraphIdFactory('test') });
assert.ok(pasted);
assert.equal(new Set(pasted.nodeIds).size, pasted.nodeIds.length);
assert.equal(pasted.edgeIds.length, 1);
assert.equal(pasted.parameterIds.length, 1);
const pastedParameterNode = pasted.document.nodes.find((node) => pasted.nodeIds.includes(node.id) && node.type === 'core.parameter');
assert.equal(pastedParameterNode?.values.parameterId, pasted.parameterIds[0]);
assert.equal(pasted.document.nodes.filter((node) => node.type === 'output.fragment').length, 1);
assert.equal(parseGraphClipboard(JSON.stringify({ format: 'shaderlab-graph-clipboard', version: 1, nodes: [{}], edges: [], parameters: [] })), null, 'malformed external clipboard must be rejected');
const pastedTransaction = executeGraphCommand(defaultGraph, createGraphHistory(), { type: 'insert-fragment', nodes: pasted.document.nodes.slice(defaultGraph.nodes.length), edges: pasted.document.edges.slice(defaultGraph.edges.length), parameters: pasted.document.parameters.slice(defaultGraph.parameters.length) });
assert.equal(pastedTransaction.history.undo.length, 1, 'paste is one history transaction');
assert.deepEqual(undoGraphCommand(pastedTransaction.document, pastedTransaction.history).document, defaultGraph);

const self = preflightConnection(defaultGraph, { nodeId: 'starter-add', socketId: 'out' }, { nodeId: 'starter-add', socketId: 'a' });
assert.equal(self.reason, 'self');
const wrongDirection = preflightConnection(defaultGraph, { nodeId: 'starter-add', socketId: 'a' }, { nodeId: 'starter-output', socketId: 'color' });
assert.equal(wrongDirection.reason, 'direction');
const typeBad = preflightConnection(defaultGraph, { nodeId: 'starter-uv', socketId: 'out' }, { nodeId: 'starter-color', socketId: 'x' });
assert.equal(typeBad.reason, 'type');
const replacement = preflightConnection(defaultGraph, { nodeId: 'starter-wave', socketId: 'out' }, { nodeId: 'starter-color', socketId: 'x' }, { edgeId: 'replacement' });
assert.equal(replacement.ok, true);
assert.deepEqual(replacement.replaceEdgeIds, ['starter-e-r']);
const cycle = preflightConnection(defaultGraph, { nodeId: 'starter-add', socketId: 'out' }, { nodeId: 'starter-wave', socketId: 'value' });
assert.equal(cycle.reason, 'cycle');

let store = createGraphEditorState(defaultGraph);
const generation0 = store.generation;
store = graphLayoutChanged(store, moved.document);
assert.equal(store.generation, generation0, 'layout does not increment compile generation');
store = graphSemanticChanged(store, defaultGraph);
const generation = store.generation;
store = graphCompileStarted(store, generation);
assert.equal(store.status, 'compiling');
const failedGraph = compileGraph({ ...defaultGraph, nodes: defaultGraph.nodes.filter((node) => node.type !== 'output.fragment') });
store = graphCompileResolved(store, generation, failedGraph);
assert.equal(store.status, 'stale');
assert.equal(store.runtimeAcceptedArtifact, undefined);

store = graphSemanticChanged(store, defaultGraph);
const successGeneration = store.generation;
store = graphCompileResolved(store, successGeneration, initialCompile);
assert.equal(store.lastSuccessfulArtifact?.revision, initialCompile.artifact?.revision);
store = graphRuntimeResolved(store, successGeneration, initialCompile.artifact.revision, false, [{ message: 'runtime failed', severity: 'error', stage: 'glsl-compile', origin: { kind: 'graph', pass: 'image', nodeId: 'starter-output' } }]);
assert.equal(graphIsStale(store), true);
assert.equal(graphCanExport(store), false);
store = graphRuntimeResolved(store, successGeneration, initialCompile.artifact.revision, true);
assert.equal(store.status, 'ready');
assert.equal(graphCanExport(store), true);
assert.equal(detachAcceptedGraph(store)?.source, initialCompile.source);
const readyStore = store;
const accepted = store.runtimeAcceptedArtifact;
store = graphSemanticChanged(store, { ...defaultGraph, nodes: defaultGraph.nodes.map((node) => node.id === 'starter-color' ? { ...node, values: { ...node.values, z: 0.9 } } : node) });
assert.equal(store.runtimeAcceptedArtifact, accepted, 'semantic edit keeps accepted preview');
assert.equal(graphIsStale(store), true, 'pending semantic edit is immediately stale');
assert.equal(graphCanExport(store), false, 'pending semantic edit disables export');
assert.equal(detachAcceptedGraph(store), null, 'pending semantic edit cannot detach old accepted GLSL');
let invalidCurrent = graphSemanticChanged(readyStore, { ...defaultGraph, nodes: defaultGraph.nodes.filter((node) => node.type !== 'output.fragment') });
const invalidGeneration = invalidCurrent.generation;
invalidCurrent = graphCompileResolved(invalidCurrent, invalidGeneration, compileGraph(invalidCurrent.document));
const incorrectlyRetriedOldArtifact = graphRuntimeResolved(invalidCurrent, invalidGeneration, initialCompile.artifact.revision, true);
assert.equal(incorrectlyRetriedOldArtifact.status, 'stale', 'old successful artifact cannot overwrite current Graph failure');
assert.equal(graphCanExport(incorrectlyRetriedOldArtifact), false);
const staleGenerationResult = graphCompileResolved(store, successGeneration, initialCompile);
assert.equal(staleGenerationResult.latestResult, undefined, 'outdated generation is ignored');
const staleRuntimeResult = graphRuntimeResolved(store, successGeneration, initialCompile.artifact.revision, true);
assert.equal(staleRuntimeResult.generation, store.generation, 'outdated runtime result is ignored');

// Runtime fallback coordination never promotes an accepted fallback to the current Graph.
const currentCandidate = selectGraphRuntimeCandidate(readyStore);
assert.equal(currentCandidate?.kind, 'current');
assert.equal(shouldCommitGraphRuntimeCandidate(readyStore, currentCandidate), true);
const fallbackCandidate = selectGraphRuntimeCandidate(invalidCurrent);
assert.equal(fallbackCandidate?.kind, 'accepted-fallback');
assert.equal(fallbackCandidate?.artifact.revision, accepted.revision);
assert.equal(shouldCommitGraphRuntimeCandidate(invalidCurrent, fallbackCandidate), false);
const queuedSetupRevision = 4;
const synchronousGraphRevision = nextRuntimeSetupRevision(queuedSetupRevision);
assert.equal(isCurrentRuntimeSetupRevision(queuedSetupRevision, synchronousGraphRevision), false, 'synchronous Graph compile supersedes queued setup work');
assert.equal(isCurrentRuntimeSetupRevision(synchronousGraphRevision, synchronousGraphRevision), true);
const changedDocument = { ...defaultGraph, nodes: defaultGraph.nodes.map((node) => node.id === 'starter-color' ? { ...node, values: { ...node.values, z: 0.37 } } : node) };
const changedCompile = compileGraph(changedDocument);
assert.equal(changedCompile.ok, true);
let rejectedWithFallback = graphSemanticChanged(readyStore, changedDocument);
rejectedWithFallback = graphCompileResolved(rejectedWithFallback, rejectedWithFallback.generation, changedCompile);
rejectedWithFallback = graphRuntimeResolved(rejectedWithFallback, rejectedWithFallback.generation, changedCompile.artifact.revision, false);
assert.deepEqual(selectGeneratedCodeSource(rejectedWithFallback), { source: accepted.source, accepted: true }, 'stale generated view prefers Runtime accepted fallback');
let rejectedWithoutFallback = graphCompileResolved(createGraphEditorState(changedDocument), 0, changedCompile);
rejectedWithoutFallback = graphRuntimeResolved(rejectedWithoutFallback, 0, changedCompile.artifact.revision, false);
assert.deepEqual(selectGeneratedCodeSource(rejectedWithoutFallback), { source: changedCompile.artifact.source, accepted: false }, 'unaccepted candidate is explicitly marked');
const fallbackMeta = createProject('fallback');
fallbackMeta.passes.bufferA = { ...fallbackMeta.passes.bufferA, enabled: true };
fallbackMeta.passes.image = { ...fallbackMeta.passes.image, channels: [{ index: 0, type: 'buffer', src: 'bufferA', filter: 'linear', wrap: 'repeat' }] };
const fallbackSetup = buildRuntimeSetup(
  fallbackMeta,
  sourcesWithDefaults({ common: '// refreshed common', image: fallbackCandidate.artifact.source, bufferA: '// refreshed buffer' }),
  [],
  {},
);
assert.equal(fallbackSetup.sources.image, accepted.source, 'accepted fallback is the stable Image source');
assert.equal(fallbackSetup.sources.common, '// refreshed common');
assert.equal(fallbackSetup.sources.bufferA, '// refreshed buffer');
assert.equal(fallbackSetup.options?.image?.channels?.[0]?.src, 'bufferA');

// Graph metadata wins over generated-source parser metadata; current values win over defaults.
const parsedUniform = { name: '_sg_gain', type: 'float', def: 0, min: 0, max: 1, step: 0.01, widget: 'input', pass: 'image' };
const graphUniform = { id: 'gain', displayName: 'Gain', emittedName: '_sg_gain', type: 'float', defaultValue: 0.75, min: 0.1, max: 2, step: 0.05, widget: 'slider', pass: 'image', nodeId: 'gain-node' };
const mergedUniforms = mergeUniformDeclarations([parsedUniform], [graphUniform]);
assert.equal(mergedUniforms.length, 1, 'uniform names must be unique');
assert.equal(mergedUniforms[0].def, 0.75, 'Graph metadata default wins');
assert.equal(mergedUniforms[0].min, 0.1);
assert.deepEqual(buildRuntimeUniformContract([parsedUniform], [graphUniform], { _sg_gain: 1.25 }), [{ name: '_sg_gain', type: 'float', value: 1.25 }]);
assert.deepEqual(buildRuntimeUniformContract([parsedUniform], [graphUniform], {}), [{ name: '_sg_gain', type: 'float', value: 0.75 }]);

// Inspector draft parsing is strict and never creates non-finite/schema-invalid values.
assert.deepEqual(parseGraphValueDraft('int', '12'), { ok: true, value: 12 });
assert.equal(parseGraphValueDraft('int', '1.2').ok, false);
assert.equal(parseGraphValueDraft('float', 'Infinity').ok, false);
assert.equal(parseGraphValueDraft('vec3', '1, 2').ok, false);
assert.deepEqual(parseGraphValueDraft('vec3', '1, 2, 3'), { ok: true, value: [1, 2, 3] });
assert.equal(parseGraphValueDraft('bool', 'yes').ok, false);
assert.deepEqual(parseGraphValueDraft('bool', 'true'), { ok: true, value: true });
const colorParameter = { id: 'color-parameter', name: 'Color', valueType: 'color3', defaultValue: [1, 0, 0], ui: { widget: 'color', min: 0, max: 1, step: 0.01 } };
const scalarPatch = graphParameterTypePatch('float');
const typeSwitched = { ...defaultGraph, parameters: [{ ...colorParameter, ...scalarPatch }] };
assert.equal(normalizeGraphDocument(typeSwitched).ok, true, 'type switching must replace incompatible widget metadata');
assert.equal(typeSwitched.parameters[0].ui.widget, 'slider');

const clipboardText = (nodes, edges = [], parameters = []) => JSON.stringify({ format: 'shaderlab-graph-clipboard', version: 1, nodes, edges, parameters });
const parameterNode = { id: 'missing-param-node', type: 'core.parameter', typeVersion: 1, position: { x: 0, y: 0 }, values: { parameterId: 'missing' } };
assert.equal(parseGraphClipboard(clipboardText([parameterNode])), null, 'clipboard parameter references must be self-contained');
const duplicateNode = { id: 'duplicate-node', type: 'value.float', typeVersion: 1, position: { x: 0, y: 0 }, values: { value: 1 } };
assert.equal(parseGraphClipboard(clipboardText([duplicateNode, { ...duplicateNode, position: { x: 20, y: 20 } }])), null, 'duplicate internal node IDs are rejected');
const duplicateParameter = { id: 'duplicate-parameter', name: 'Duplicate', valueType: 'float', defaultValue: 0, ui: { widget: 'slider', min: 0, max: 1, step: 0.01 } };
assert.equal(parseGraphClipboard(clipboardText([], [], [duplicateParameter, { ...duplicateParameter }])), null, 'duplicate internal parameter IDs are rejected');

const nodeOf = (type, id, x = 0) => {
  const definition = DEFAULT_NODE_REGISTRY.get(type, 1);
  assert.ok(definition);
  return { id, type, typeVersion: 1, position: { x, y: 0 }, values: { ...definition.defaultValues } };
};
const fragSource1 = nodeOf('value.float', 'frag-source-1');
const fragSource2 = nodeOf('value.float', 'frag-source-2', 20);
const fragTarget = nodeOf('math.add', 'frag-target', 40);
const validFragment = {
  nodes: [fragSource1, fragTarget],
  edges: [{ id: 'frag-edge', from: { nodeId: fragSource1.id, socketId: 'out' }, to: { nodeId: fragTarget.id, socketId: 'a' } }],
  parameters: [],
};
assert.ok(parseGraphClipboard(clipboardText(validFragment.nodes, validFragment.edges)), 'valid self-contained fragment remains accepted');
const duplicateIdEdges = [
  { id: 'duplicate-edge', from: { nodeId: fragSource1.id, socketId: 'out' }, to: { nodeId: fragTarget.id, socketId: 'a' } },
  { id: 'duplicate-edge', from: { nodeId: fragSource2.id, socketId: 'out' }, to: { nodeId: fragTarget.id, socketId: 'b' } },
];
assert.equal(parseGraphClipboard(clipboardText([fragSource1, fragSource2, fragTarget], duplicateIdEdges)), null, 'duplicate internal edge IDs are rejected');
const danglingEdge = { id: 'dangling-edge', from: { nodeId: 'absent', socketId: 'out' }, to: { nodeId: fragTarget.id, socketId: 'a' } };
assert.equal(parseGraphClipboard(clipboardText([fragTarget], [danglingEdge])), null, 'dangling clipboard edges are rejected');
const unknownSocket = { id: 'unknown-socket-edge', from: { nodeId: fragSource1.id, socketId: 'missing' }, to: { nodeId: fragTarget.id, socketId: 'a' } };
assert.equal(parseGraphClipboard(clipboardText([fragSource1, fragTarget], [unknownSocket])), null, 'unknown sockets are rejected');
const duplicateInputEdges = [
  { id: 'input-edge-1', from: { nodeId: fragSource1.id, socketId: 'out' }, to: { nodeId: fragTarget.id, socketId: 'a' } },
  { id: 'input-edge-2', from: { nodeId: fragSource2.id, socketId: 'out' }, to: { nodeId: fragTarget.id, socketId: 'a' } },
];
assert.equal(parseGraphClipboard(clipboardText([fragSource1, fragSource2, fragTarget], duplicateInputEdges)), null, 'duplicate input connections are rejected');

const rejectFragment = (fragment, message) => {
  const before = structuredClone(defaultGraph);
  const result = executeGraphCommand(defaultGraph, createGraphHistory(), { type: 'insert-fragment', ...fragment });
  assert.equal(result.changed, false, message);
  assert.equal(result.history.undo.length, 0, 'rejected fragment cannot create history');
  assert.deepEqual(result.document, before, 'rejected fragment is atomic');
};
rejectFragment({ nodes: [fragSource1, { ...fragSource1 }], edges: [], parameters: [] }, 'duplicate fragment IDs are rejected');
rejectFragment({ nodes: [], edges: [], parameters: [duplicateParameter, { ...duplicateParameter }] }, 'duplicate parameter IDs are rejected');
rejectFragment({ nodes: [fragSource1, fragSource2, fragTarget], edges: duplicateIdEdges, parameters: [] }, 'duplicate edge IDs are rejected');
rejectFragment({ nodes: [fragTarget], edges: [danglingEdge], parameters: [] }, 'dangling fragment is rejected');
rejectFragment({ nodes: [fragSource1, fragTarget], edges: [unknownSocket], parameters: [] }, 'unknown socket fragment is rejected');
rejectFragment({ nodes: [fragSource1, fragSource2, fragTarget], edges: duplicateInputEdges, parameters: [] }, 'duplicate input fragment is rejected');
const cycleA = nodeOf('math.add', 'cycle-a');
const cycleB = nodeOf('math.add', 'cycle-b');
rejectFragment({ nodes: [cycleA, cycleB], edges: [
  { id: 'cycle-1', from: { nodeId: cycleA.id, socketId: 'out' }, to: { nodeId: cycleB.id, socketId: 'a' } },
  { id: 'cycle-2', from: { nodeId: cycleB.id, socketId: 'out' }, to: { nodeId: cycleA.id, socketId: 'a' } },
], parameters: [] }, 'cycles introduced by a fragment are rejected');
assert.equal(pasteGraphSelection(defaultGraph, { format: 'shaderlab-graph-clipboard', version: 1, ...validFragment }, { idFactory: { node: () => 'same', edge: () => 'same', parameter: () => 'same' } }), null, 'ID factories cannot introduce collisions');

// Registry-driven geometry and pointer selection share deterministic pure helpers.
const tallestDefinition = DEFAULT_NODE_REGISTRY.list().reduce((best, definition) => Math.max(definition.inputs.length, definition.outputs.length) > Math.max(best.inputs.length, best.outputs.length) ? definition : best);
assert.ok(graphNodeHeight(tallestDefinition) > 118, 'multi-socket nodes are taller than the former fixed bound');
const allBounds = graphBounds(defaultGraph.nodes, DEFAULT_NODE_REGISTRY);
assert.ok(allBounds && allBounds.width > 0 && allBounds.height > 0);
assert.deepEqual(nodePointerSelection(['a', 'b'], 'a', true), { selection: ['b'], dragNodeIds: [], selectionBefore: ['a', 'b'] }, 'modifier deselection must not start dragging the old selection');
assert.deepEqual(nodePointerSelection(['a'], 'b', true), { selection: ['a', 'b'], dragNodeIds: ['a', 'b'], selectionBefore: ['a'] });
assert.deepEqual(cancelledPointerSelection(nodePointerSelection(['a'], 'b', false).selectionBefore), ['a'], 'cancel restores node selection');
assert.deepEqual(blankCanvasPointerSelection(['a'], false), { selection: [], selectionBefore: ['a'] });
assert.deepEqual(cancelledPointerSelection(blankCanvasPointerSelection(['a'], false).selectionBefore), ['a'], 'cancel restores blank-canvas selection');

console.log('M2 pure-function checks passed');
