import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compileGraph } from '../src/graph/compiler/index.ts';
import { createDefaultImageGraph } from '../src/graph/editor/defaultGraph.ts';
import { graphJsonExportArtifact, safeExportBaseName } from '../src/project/exportArtifacts.ts';
import { parseProjectGraph } from '../src/project/graphIO.ts';
import { sourcesWithDefaults } from '../src/project/types.ts';
import { parseUniforms } from '../src/shadertoy/uniforms.ts';
import { buildUniformContract, reconcileUniformValues } from '../src/shadertoy/uniformContract.ts';
import { exportEligibility, guardedExportStart, validateExportTicket } from '../src/export/exportEligibility.ts';
import { codeApplyBoundary, shouldDetachGraph } from '../src/state/codeApplyBoundary.ts';
import { activeKeyboardConnectionTarget, beginKeyboardConnection, graphKeyboardIntent, graphNodeActivationIntent, moveKeyboardConnection, nextNodeInDirection, nudgeNodePositions } from '../src/graph/editor/keyboard.ts';
import { applyGraphCommand } from '../src/graph/editor/commands.ts';
import { createGraphEditorState, graphCompileResolved, graphLayoutChanged, graphSemanticChanged } from '../src/state/graphEditorStore.ts';

const codeFloat = { name: 'u_shared', type: 'float', def: 0, min: 0, max: 1, step: 0.01, widget: 'slider', pass: 'common' };
const codeFloatImage = { ...codeFloat, def: 0.5, pass: 'image' };
const same = buildUniformContract([codeFloatImage, codeFloat]);
assert.equal(same.hasErrors, false);
assert.equal(same.declarations.length, 1);
assert.equal(same.declarations[0].pass, 'common', 'same-type merge follows deterministic pass order');
const conflict = buildUniformContract([codeFloat, { ...codeFloatImage, type: 'vec2', def: [0, 0] }]);
assert.equal(conflict.hasErrors, true);
assert.equal(conflict.declarations.length, 0, 'conflicted runtime name is never arbitrarily typed');
assert.equal(conflict.diagnostics[0].origin.pass, 'common');
assert.equal(conflict.diagnostics[0].relatedOrigins.length, 1);
const parsedDisabled = parseUniforms(sourcesWithDefaults({ image: 'uniform float u_x;', bufferA: 'uniform vec2 u_x;' }), (pass) => pass === 'image').decls;
assert.equal(buildUniformContract(parsedDisabled).hasErrors, false, 'disabled pass does not conflict');
const graphUniform = { id: 'gain-id', displayName: 'Gain', emittedName: '_sg_gain', type: 'float', defaultValue: 0.75, min: 0, max: 2, step: 0.05, widget: 'slider', pass: 'image', nodeId: 'gain-node' };
const graphOther = { ...graphUniform, id: 'gain-id-2', emittedName: '_sg_gain_2', nodeId: 'gain-node-2' };
const graphContract = buildUniformContract([], [graphUniform, graphOther]);
assert.equal(graphContract.declarations.length, 2, 'same displayName with distinct emittedName does not conflict');
assert.equal(graphContract.declarations[0].displayName, 'Gain');
assert.ok(graphContract.declarations.some((decl) => decl.name === '_sg_gain'), 'emittedName remains runtime identity');
assert.deepEqual(reconcileUniformValues([
  { ...codeFloat, name: 'keep', type: 'float', def: 0.1 },
  { ...codeFloat, name: 'reset', type: 'vec3', def: [1, 2, 3] },
  { ...codeFloat, name: 'int', type: 'int', def: 4 },
], { keep: 0.8, reset: [1, 2], int: 3.2, removed: true }), { keep: 0.8, reset: [1, 2, 3], int: 4 });
const previousFloat = new Map([['scalar', 'float']]);
assert.deepEqual(reconcileUniformValues([{ ...codeFloat, name: 'scalar', type: 'int', def: 4 }], { scalar: 1 }, previousFloat), { scalar: 4 }, 'float to int resets even when numeric shape is valid');
const previousInt = new Map([['scalar', 'int']]);
assert.deepEqual(reconcileUniformValues([{ ...codeFloat, name: 'scalar', type: 'float', def: 0.5 }], { scalar: 1 }, previousInt), { scalar: 0.5 }, 'int to float resets');
assert.deepEqual(reconcileUniformValues([{ ...codeFloat, name: 'scalar', type: 'float', def: 0.5 }], { scalar: 0.8 }, previousFloat), { scalar: 0.8 }, 'same type keeps valid value');

const readyCode = { authoring: 'code', runtimeSetupRevision: 4, successfulRuntimeSetupRevision: 4, compileStatus: 'ready', hasCompileError: false, hasUniformConflict: false, graphAccepted: false };
const codeReady = exportEligibility(readyCode);
assert.equal(codeReady.eligible, true);
for (const patch of [
  { compileStatus: 'pending' }, { compileStatus: 'compiling' }, { hasCompileError: true }, { hasUniformConflict: true }, { successfulRuntimeSetupRevision: 3 },
]) assert.equal(exportEligibility({ ...readyCode, ...patch }).eligible, false);
const graphInput = { ...readyCode, authoring: 'graph', graphAccepted: true, graphGeneration: 7, graphArtifactRevision: 'rev-a', graphSourceHash: 'hash-a' };
const graphReady = exportEligibility(graphInput);
assert.equal(graphReady.eligible, true);
assert.equal(validateExportTicket(graphReady.ticket, graphInput).eligible, true);
for (const patch of [
  { runtimeSetupRevision: 5, successfulRuntimeSetupRevision: 5 }, { graphGeneration: 8 }, { graphArtifactRevision: 'rev-b' }, { graphSourceHash: 'hash-b' }, { graphAccepted: false },
]) assert.equal(validateExportTicket(graphReady.ticket, { ...graphInput, ...patch }).eligible, false);
let starts = 0;
guardedExportStart(codeReady.ticket, { ...readyCode, compileStatus: 'pending' }, () => starts++);
guardedExportStart(codeReady.ticket, { ...readyCode, runtimeSetupRevision: 5, successfulRuntimeSetupRevision: 5 }, () => starts++);
assert.equal(starts, 0, 'failed or replaced ticket performs zero export work');
guardedExportStart(codeReady.ticket, readyCode, () => starts++);
assert.equal(starts, 1);

const graph = createDefaultImageGraph();
const jsonArtifact = graphJsonExportArtifact('unsafe:/project?. ', graph);
assert.equal(jsonArtifact.fileName, 'unsafe__project_-image.shadergraph.json');
assert.deepEqual(parseProjectGraph(jsonArtifact.contents, 'image').document, graph);
assert.equal(safeExportBaseName('...'), 'shader');
assert.deepEqual(codeApplyBoundary('code'), { allowed: true });
assert.equal(codeApplyBoundary('graph').allowed, false);
assert.equal(shouldDetachGraph(false, true), false, 'cancelled detach is zero-mutation decision');
assert.equal(shouldDetachGraph(true, false), false);
assert.equal(shouldDetachGraph(true, true), true);

assert.equal(graphNodeActivationIntent('Enter'), 'connect');
assert.equal(graphNodeActivationIntent(' ', 'Space'), 'connect');
assert.equal(graphNodeActivationIntent('Escape'), 'none');
assert.equal(graphKeyboardIntent('f'), 'fit');
assert.equal(graphKeyboardIntent('+'), 'zoom-in');
assert.equal(graphKeyboardIntent('-', false), 'zoom-out');
assert.equal(graphKeyboardIntent('A', true), 'palette');
const positions = nudgeNodePositions(graph, ['starter-color'], 'right');
assert.equal(positions['starter-color'].x, graph.nodes.find((node) => node.id === 'starter-color').position.x + 16);
assert.equal(applyGraphCommand(graph, { type: 'move-nodes', positions }).impact, 'layout');
const nextRight = nextNodeInDirection(graph.nodes, 'starter-time', 'right');
assert.ok(nextRight);
const connection = beginKeyboardConnection(graph, { nodeId: 'starter-time', socketId: 'out' });
assert.ok(connection && connection.compatibleInputs.length > 0);
assert.notDeepEqual(activeKeyboardConnectionTarget(connection), activeKeyboardConnectionTarget(moveKeyboardConnection(connection, 1)));

const large = structuredClone(graph);
for (let i = 0; i < 500; i++) large.nodes.push({ id: `perf-${i}`, type: 'value.float', typeVersion: 1, position: { x: (i % 25) * 210, y: Math.floor(i / 25) * 120 }, values: { value: i / 500 } });
const times = [];
for (let i = 0; i < 5; i++) { const start = performance.now(); const result = compileGraph(large); times.push(performance.now() - start); assert.equal(result.ok, true); }
const avg = times.reduce((sum, value) => sum + value, 0) / times.length;
const max = Math.max(...times);
console.log(`M4 500-node compile: avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms`);
assert.ok(avg < 100, `500-node average compile ${avg.toFixed(2)}ms exceeds 100ms`);
assert.ok(max < 500, `500-node max compile ${max.toFixed(2)}ms exceeds 500ms`);

let state = createGraphEditorState(graph);
for (let i = 0; i < 100; i++) {
  const document = { ...state.document, nodes: state.document.nodes.map((node) => node.id === 'starter-color' ? { ...node, values: { ...node.values, z: i / 100 } } : node) };
  state = graphSemanticChanged(state, document);
}
assert.equal(state.generation, 100);
const finalGeneration = state.generation;
const finalResult = compileGraph(state.document);
const staleResolved = graphCompileResolved(state, finalGeneration - 1, finalResult);
assert.equal(staleResolved.latestResult, undefined, 'older semantic revision cannot win');
state = graphCompileResolved(state, finalGeneration, finalResult);
assert.equal(state.lastSuccessfulArtifact.revision, finalResult.artifact.revision);
const layoutGeneration = state.generation;
for (let i = 0; i < 100; i++) {
  const moved = applyGraphCommand(state.document, { type: 'move-nodes', positions: { 'starter-color': { x: i, y: i } } });
  state = graphLayoutChanged(state, moved.document);
}
assert.equal(state.generation, layoutGeneration, '100 layout edits do not trigger semantic generations');

console.log('M4 contract, export, AI boundary, keyboard and performance checks passed');
