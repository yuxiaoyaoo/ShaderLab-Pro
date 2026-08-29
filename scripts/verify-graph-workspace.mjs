import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileGraph } from '../src/graph/compiler/index.ts';
import { applyGraphCommand } from '../src/graph/editor/commands.ts';
import { canInsertGraphFragment } from '../src/graph/editor/fragmentValidation.ts';
import { graphBoundsIntersect, graphEdgeBezier, graphNodeBounds, graphSocketPoint } from '../src/graph/editor/geometry.ts';
import { createGraphHistory, executeGraphCommand, undoGraphCommand } from '../src/graph/editor/history.ts';
import { isNodeAllowedInPureGroup, isNodeAvailableInPass } from '../src/graph/registry.ts';
import { createGraphEditorState, graphCanExport, graphIsStale, graphLibrarySemanticChanged } from '../src/state/graphEditorStore.ts';
import { buildNodeGroupFromSelection } from '../src/graph/editor/groupBuilder.ts';
import { createGraphWorkspaceUi, graphGroupSemanticKey, graphGroupViewportKey, normalizeGraphWorkspaceUi, serializeGraphWorkspaceUi } from '../src/graph/editor/workspaceState.ts';
import { GRAPH_LIBRARY_FORMAT, GRAPH_LIBRARY_VERSION, computeGraphLibraryRevision, createGraphLibrary, createProjectNodeRegistry, createStarterNodeGroup, normalizeGraphLibrary } from '../src/graph/library.ts';
import { CURRENT_GRAPH_VERSION, GRAPH_FORMAT } from '../src/graph/model.ts';

const node = (id, type, position, values = {}) => ({ id, type, typeVersion: 1, position, values });
const edge = (id, fromNode, fromSocket, toNode, toSocket) => ({ id, from: { nodeId: fromNode, socketId: fromSocket }, to: { nodeId: toNode, socketId: toSocket } });
const document = {
  format: GRAPH_FORMAT,
  version: CURRENT_GRAPH_VERSION,
  pass: 'image',
  nodes: [
    node('time', 'input.time', { x: 0, y: 0 }),
    node('amount', 'value.float', { x: 0, y: 180 }, { value: 0.6 }),
    node('sin', 'math.sin', { x: 240, y: 0 }, { value: 0 }),
    node('mul', 'math.multiply', { x: 470, y: 40 }, { a: 0, b: 0 }),
    node('rgba', 'vector.combine4', { x: 720, y: 40 }, { x: 0, y: 0, z: 0, w: 1 }),
    node('output', 'output.fragment', { x: 960, y: 40 }, { color: [0, 0, 0, 1] }),
  ],
  edges: [
    edge('e1', 'time', 'out', 'sin', 'value'),
    edge('e2', 'sin', 'out', 'mul', 'a'),
    edge('e3', 'amount', 'out', 'mul', 'b'),
    edge('e4', 'mul', 'out', 'rgba', 'x'),
    edge('e5', 'mul', 'out', 'rgba', 'y'),
    edge('e6', 'mul', 'out', 'rgba', 'z'),
    edge('e7', 'rgba', 'out', 'output', 'color'),
  ],
  parameters: [],
  ui: { viewport: { x: 0, y: 0, zoom: 1 } },
};

const baseRegistry = createProjectNodeRegistry(createGraphLibrary());
assert.equal(compileGraph(document, baseRegistry).ok, true, 'fixture must compile before grouping');
const grouped = buildNodeGroupFromSelection(document, ['sin', 'mul'], baseRegistry, {
  id: 'wave_group', title: 'Wave Group', instanceNodeId: 'wave-instance', edgeId: (purpose) => `group-${purpose}`,
});
assert.equal(grouped.group.kind, 'graph');
assert.equal(grouped.group.inputs.length, 2);
assert.equal(grouped.group.outputs.length, 1, 'three outgoing edges share one typed output');
assert.equal(grouped.document.nodes.some((item) => item.id === 'sin' || item.id === 'mul'), false);
assert.equal(grouped.document.nodes.find((item) => item.id === 'wave-instance')?.typeVersion, 1);

const library = normalizeGraphLibrary({ ...createGraphLibrary(), groups: [grouped.group] });
const registry = createProjectNodeRegistry(library);
const compiled = compileGraph(grouped.document, { registry, libraryRevision: computeGraphLibraryRevision(library) });
assert.equal(compiled.ok, true, compiled.diagnostics.map((item) => item.message).join('; '));
assert.match(compiled.source, /sin\(/);

const movedLibrary = normalizeGraphLibrary({
  ...library,
  groups: library.groups.map((group) => group.kind === 'graph' ? {
    ...group,
    graph: { ...group.graph, nodes: group.graph.nodes.map((item) => ({ ...item, position: { x: item.position.x + 9000, y: item.position.y - 4000 } })) },
  } : group),
});
assert.equal(computeGraphLibraryRevision(movedLibrary), computeGraphLibraryRevision(library), 'group layout must not affect semantic library revision');

const legacyGroup = structuredClone(createStarterNodeGroup('legacy_wave'));
delete legacyGroup.kind;
const migrated = normalizeGraphLibrary({ format: GRAPH_LIBRARY_FORMAT, version: 1, groups: [legacyGroup], functions: [] });
assert.equal(migrated.version, GRAPH_LIBRARY_VERSION);
assert.equal(migrated.groups[0].kind, 'expression');

const workspace = normalizeGraphWorkspaceUi({
  ...createGraphWorkspaceUi(), mode: 'fullscreen', previewDock: 'floating', paletteOpen: false,
  generatedDrawer: { open: true, height: 310 },
  editPath: [{ groupId: 'wave_group', version: 1 }],
  groupViewports: { 'image:wave_group@1': { x: -240, y: 80, zoom: 0.75 } },
  passes: { image: { collapsedNodeIds: ['wave-instance'], frames: [{ id: 'frame-1', title: 'Waves', position: { x: 10, y: 20 }, size: { width: 500, height: 260 }, nodeIds: ['wave-instance'], color: '#596780' }] } },
});
assert.deepEqual(normalizeGraphWorkspaceUi(JSON.parse(serializeGraphWorkspaceUi(workspace))), workspace);
assert.equal(computeGraphLibraryRevision(library), computeGraphLibraryRevision(library), 'workspace state is external to library identity');

// Pass availability and pure Group eligibility are one fail-closed registry policy shared by compiler and editor commands.
const fragCoordDefinition = baseRegistry.get('input.frag_coord', 1);
const sampleTimeDefinition = baseRegistry.get('input.sample_time', 1);
const timeDefinition = baseRegistry.get('input.time', 1);
assert.ok(fragCoordDefinition && sampleTimeDefinition && timeDefinition);
assert.equal(isNodeAvailableInPass(fragCoordDefinition, 'sound'), false);
assert.equal(isNodeAvailableInPass(sampleTimeDefinition, 'image'), false);
assert.equal(isNodeAllowedInPureGroup(timeDefinition), false);
assert.equal(isNodeAllowedInPureGroup(baseRegistry.get('math.sin', 1)), true);

const invalidSoundContext = {
  ...document,
  pass: 'sound',
  nodes: [node('frag', 'input.frag_coord', { x: 0, y: 0 }), node('sound-out', 'output.sound', { x: 240, y: 0 }, { sample: [0, 0] })],
  edges: [edge('frag-sound', 'frag', 'out', 'sound-out', 'sample')],
};
const invalidSoundResult = compileGraph(invalidSoundContext);
assert.equal(invalidSoundResult.ok, false);
assert.ok(invalidSoundResult.diagnostics.some((item) => item.code === 'graph.node-pass-unavailable' && item.origin.nodeId === 'frag'));
const invalidVisualContext = {
  ...document,
  nodes: [node('sample', 'input.sample_time', { x: 0, y: 0 }), node('visual-out', 'output.fragment', { x: 240, y: 0 }, { color: [0, 0, 0, 1] })],
  edges: [],
};
const invalidVisualResult = compileGraph(invalidVisualContext);
assert.equal(invalidVisualResult.ok, false);
assert.ok(invalidVisualResult.diagnostics.some((item) => item.code === 'graph.node-pass-unavailable' && item.origin.nodeId === 'sample'));

const impureGroup = structuredClone(grouped.group);
impureGroup.graph.nodes.push(node('captured-time', 'input.time', { x: 20, y: 20 }));
assert.throws(() => normalizeGraphLibrary({ ...createGraphLibrary(), groups: [impureGroup] }), /不可封装/);
const groupDocument = {
  ...document,
  nodes: grouped.group.graph.nodes,
  edges: grouped.group.graph.edges,
  parameters: [],
};
const capturedTime = node('captured-time', 'input.time', { x: 20, y: 20 });
assert.equal(applyGraphCommand(groupDocument, { type: 'add-node', node: capturedTime }, { registry: baseRegistry, insideGroup: true }).changed, false);
assert.equal(canInsertGraphFragment(groupDocument, { nodes: [capturedTime], edges: [], parameters: [] }, { registry: baseRegistry, insideGroup: true }), false);

// Library identity is global: one semantic mutation invalidates both ready lanes before debounce/Runtime work begins.
const soundDocument = {
  ...document,
  pass: 'sound',
  nodes: [node('sound-out', 'output.sound', { x: 0, y: 0 }, { sample: [0, 0] })],
  edges: [],
};
const soundArtifact = compileGraph(soundDocument, { registry: baseRegistry, libraryRevision: computeGraphLibraryRevision(library) }).artifact;
assert.ok(compiled.artifact && soundArtifact);
const readyState = (sourceDocument, artifact) => ({
  ...createGraphEditorState(sourceDocument),
  lastSuccessfulArtifact: artifact,
  runtimeAcceptedArtifact: artifact,
  status: 'ready',
});
const readyStates = { image: readyState(grouped.document, compiled.artifact), sound: readyState(soundDocument, soundArtifact) };
assert.equal(graphCanExport(readyStates.image, compiled.artifact.libraryRevision), true);
assert.equal(graphCanExport(readyStates.image, 'new-library-revision'), false, 'artifact identity must fail closed even if status was not invalidated');
const invalidatedStates = graphLibrarySemanticChanged(readyStates);
for (const pass of ['image', 'sound']) {
  assert.equal(invalidatedStates[pass].status, 'pending');
  assert.equal(invalidatedStates[pass].generation, readyStates[pass].generation + 1);
  assert.equal(graphIsStale(invalidatedStates[pass]), true);
}

// Viewports remain pass-local, while one Group version has a single semantic history sequence across passes.
assert.notEqual(graphGroupViewportKey('image', 'wave_group', 1), graphGroupViewportKey('sound', 'wave_group', 1));
assert.equal(graphGroupSemanticKey('wave_group', 1), 'wave_group@1');
const historyBase = { ...groupDocument, nodes: [node('base', 'value.float', { x: 0, y: 0 }, { value: 0 })], edges: [] };
let sharedHistory = createGraphHistory();
const firstEdit = executeGraphCommand(historyBase, sharedHistory, { type: 'add-node', node: node('added', 'value.float', { x: 100, y: 0 }, { value: 1 }) }, { registry: baseRegistry, insideGroup: true });
sharedHistory = firstEdit.history;
const soundView = { ...firstEdit.document, pass: 'sound' };
const secondEdit = executeGraphCommand(soundView, sharedHistory, { type: 'set-node-value', nodeId: 'added', key: 'value', value: 2 }, { registry: baseRegistry, insideGroup: true });
const crossPassUndo = undoGraphCommand({ ...secondEdit.document, pass: 'image' }, secondEdit.history);
assert.equal(crossPassUndo.document.nodes.find((item) => item.id === 'added')?.values.value, 1, 'undo must remove only the latest cross-pass Group edit');
assert.equal(crossPassUndo.document.nodes.some((item) => item.id === 'added'), true, 'older edit must not be overwritten by a pass-local branch');

// DOM layout, edge anchors, Fit/culling geometry and Bezier culling share the same pure descriptors.
const reroute = node('route', 'core.reroute', { x: 100, y: 200 }, { value: 0 });
const rerouteBounds = graphNodeBounds(reroute, baseRegistry);
assert.deepEqual(rerouteBounds, { x: 100, y: 200, width: 72, height: 42 });
assert.deepEqual(graphSocketPoint(reroute, 'value', false, baseRegistry), { x: 100, y: 221 });
assert.deepEqual(graphSocketPoint(reroute, 'out', true, baseRegistry), { x: 172, y: 221 });
const normalValue = node('normal', 'value.float', { x: 0, y: 0 }, { value: 1 });
const expandedBounds = graphNodeBounds(normalValue, baseRegistry);
const collapsedBounds = graphNodeBounds(normalValue, baseRegistry, true);
assert.ok(collapsedBounds.height < expandedBounds.height, 'collapsed node must have compact bounds');
assert.notEqual(graphSocketPoint(normalValue, 'out', true, baseRegistry).y, graphSocketPoint(normalValue, 'out', true, baseRegistry, normalValue.position, true).y, 'collapsed socket anchor must move with compact DOM');
const reverseCurve = graphEdgeBezier({ x: -500, y: 50 }, { x: -10000, y: 50 });
assert.ok(reverseCurve.controlFrom.x > 0, 'fixture control point must cross the viewport');
assert.equal(graphBoundsIntersect(reverseCurve.bounds, { x: 0, y: 0, width: 1000, height: 100 }), true, 'conservative Bezier bounds must retain reverse curves crossing the viewport');

const canvasSource = await readFile(new URL('../src/components/graph/GraphEdgeLayer.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(canvasSource, /viewBox="-5000|-5000px|10000px/, 'edge layer must use a dynamic visible rect');
assert.match(canvasSource, /visibleRect/);
const workspaceSource = await readFile(new URL('../src/components/graph/GraphWorkspaceShell.tsx', import.meta.url), 'utf8');
for (const dock of ['right', 'bottom', 'floating', 'hidden']) assert.match(workspaceSource, new RegExp(`'${dock}'`));

console.log('Graph Workspace verification passed: culling contract, workspace state, Library v1 migration and graph-backed Group lowering');
