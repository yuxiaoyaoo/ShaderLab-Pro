import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildTypedIr, compileGraph, emitTypedIr, lookupGraphSource } from '../src/graph/compiler/index.ts';
import { fromRuntimeDiagnosticWithGraphSourceMap } from '../src/diagnostics/model.ts';
import { createEmptyGraph } from '../src/graph/model.ts';
import { DEFAULT_NODE_REGISTRY, NodeRegistry, validateNodeValues, valueField } from '../src/graph/registry.ts';

const node = (id, type, values = {}, x = 0, y = 0) => ({
  id, type, typeVersion: 1, position: { x, y }, values,
});
const edge = (id, fromNode, fromSocket, toNode, toSocket) => ({
  id,
  from: { nodeId: fromNode, socketId: fromSocket },
  to: { nodeId: toNode, socketId: toSocket },
});
const graph = (nodes, edges = [], parameters = []) => ({
  ...createEmptyGraph('image'), nodes, edges, parameters,
});
const codes = (result) => result.diagnostics.map((diagnostic) => diagnostic.code);

assert.ok(DEFAULT_NODE_REGISTRY.size >= 30, `expected >=30 nodes, got ${DEFAULT_NODE_REGISTRY.size}`);

const permissiveSocketDefinition = {
  type: 'test.permissive', version: 1, title: 'Permissive', category: 'Test',
  inputs: [{ id: 'value', title: 'Value', type: 'float', defaultType: 'float', defaultValue: 0 }],
  outputs: [{ id: 'out', title: 'Out', type: 'float' }], defaultValues: {},
  valueFields: { value: valueField(() => undefined) },
  inferTypes: () => ({ out: 'float' }), lower: ({ inputs }) => ({ out: inputs.value }),
};
assert.ok(validateNodeValues(node('custom', 'test.permissive', { value: 'bad' }), permissiveSocketDefinition).length > 0,
  'custom validators must not override socket GraphValueType validation');
assert.throws(() => new NodeRegistry().register({
  ...permissiveSocketDefinition,
  type: 'test.bad-default',
  inputs: [{ id: 'value', title: 'Value', type: 'float', defaultType: 'float', defaultValue: 'bad' }],
}), /Socket 默认值/);

const valid = graph([
  node('uv', 'input.uv', {}, -300, 10),
  node('scale', 'math.multiply', { b: 2 }, -100, 10),
  node('split', 'vector.split2', {}, 100, 10),
  node('rgba', 'vector.combine4', { z: 0, w: 1 }, 300, 10),
  node('output', 'output.fragment', {}, 500, 10),
], [
  edge('e1', 'uv', 'out', 'scale', 'a'),
  edge('e2', 'scale', 'out', 'split', 'value'),
  edge('e3', 'split', 'x', 'rgba', 'x'),
  edge('e4', 'split', 'y', 'rgba', 'y'),
  edge('e5', 'rgba', 'out', 'output', 'color'),
]);
const compiled = compileGraph(valid);
assert.equal(compiled.ok, true, compiled.diagnostics.map((d) => d.message).join('\n'));
assert.match(compiled.source, /void mainImage\(out vec4 fragColor, in vec2 fragCoord\)/);
assert.doesNotMatch(compiled.source, /#version/);
assert.doesNotMatch(compiled.source, /void\s+main\s*\(/);
assert.ok(compiled.sourceMap.entries.length > 0);
assert.equal(compiled.sourceHash, compileGraph(valid).sourceHash);

const shuffled = {
  ...valid,
  nodes: [...valid.nodes].reverse().map((item, index) => ({
    ...item,
    position: { x: 999 - index * 17, y: -500 + index },
  })),
  edges: [...valid.edges].reverse().map((item, index) => ({ ...item, id: `replacement-edge-${index}` })),
  ui: { viewport: { x: 987, y: -123, zoom: 2.5 } },
};
const shuffledCompiled = compileGraph(shuffled);
assert.equal(shuffledCompiled.ok, true);
assert.equal(shuffledCompiled.source, compiled.source);
assert.equal(shuffledCompiled.semanticHash, compiled.semanticHash);
assert.equal(shuffledCompiled.sourceHash, compiled.sourceHash);

const noOutput = compileGraph(graph([node('v', 'value.float', { value: 1 })]));
assert.equal(noOutput.ok, false);
assert.ok(codes(noOutput).includes('graph.output-count'));
assert.equal(noOutput.source, '');

const cycle = compileGraph(graph([
  node('a', 'math.add'), node('b', 'math.add'), node('output', 'output.fragment'),
], [
  edge('ab', 'a', 'out', 'b', 'a'), edge('ba', 'b', 'out', 'a', 'a'),
]));
assert.equal(cycle.ok, false);
assert.ok(codes(cycle).includes('graph.cycle'));

const dangling = compileGraph(graph([node('output', 'output.fragment')], [
  edge('dangling', 'missing', 'out', 'output', 'color'),
]));
assert.equal(dangling.ok, false);
assert.ok(codes(dangling).includes('graph.dangling-edge'));

const duplicateInput = compileGraph(graph([
  node('a', 'value.float', { value: 1 }), node('b', 'value.float', { value: 2 }),
  node('output', 'output.fragment'),
], [
  edge('first', 'a', 'out', 'output', 'color'), edge('second', 'b', 'out', 'output', 'color'),
]));
assert.equal(duplicateInput.ok, false);
assert.ok(codes(duplicateInput).includes('graph.duplicate-input'));

const typeError = compileGraph(graph([
  node('bool', 'value.bool', { value: true }), node('output', 'output.fragment'),
], [edge('bad-type', 'bool', 'out', 'output', 'color')]));
assert.equal(typeError.ok, false);
assert.ok(codes(typeError).includes('type.incompatible'));

for (const operation of ['vector.dot', 'vector.distance']) {
  const mismatchedVectors = compileGraph(graph([
    node('v2', 'vector.combine2'), node('v3', 'vector.combine3'), node('operation', operation),
    node('output', 'output.fragment'),
  ], [
    edge('a', 'v2', 'out', 'operation', 'a'), edge('b', 'v3', 'out', 'operation', 'b'),
    edge('result', 'operation', 'out', 'output', 'color'),
  ]));
  assert.equal(mismatchedVectors.ok, false, `${operation} must reject mixed dimensions`);
  assert.ok(codes(mismatchedVectors).includes('type.inference-failed'));
}

for (const mask of ['z', 'xrrr']) {
  const invalidSwizzle = compileGraph(graph([
    node('v2', 'vector.combine2'), node('swizzle', 'vector.swizzle', { mask }), node('output', 'output.fragment'),
  ], [
    edge('value', 'v2', 'out', 'swizzle', 'value'),
    edge('result', 'swizzle', 'out', 'output', 'color'),
  ]));
  assert.equal(invalidSwizzle.ok, false, `swizzle ${mask} must be rejected`);
  assert.ok(codes(invalidSwizzle).some((code) =>
    code === 'type.inference-failed'
      || code === 'graph.invalid-node-value'
      || code === 'graph.value-vector-mask-invalid'
  ));
  assert.equal(invalidSwizzle.source, '');
}

const reflectAlias = compileGraph(graph([
  node('incident-vector', 'vector.combine3'),
  node('incident-color', 'color.from_vec3'),
  node('normal', 'vector.combine3', { y: 1 }),
  node('reflect', 'vector.reflect'),
  node('rgba', 'vector.append_alpha'),
  node('output', 'output.fragment'),
], [
  edge('to-color', 'incident-vector', 'out', 'incident-color', 'value'),
  edge('incident', 'incident-color', 'out', 'reflect', 'incident'),
  edge('normal-edge', 'normal', 'out', 'reflect', 'normal'),
  edge('rgb', 'reflect', 'out', 'rgba', 'rgb'),
  edge('out', 'rgba', 'out', 'output', 'color'),
]));
assert.equal(reflectAlias.ok, true, reflectAlias.diagnostics.map((d) => d.message).join('\n'));

const unsafeUnknown = compileGraph(graph([
  node('unsafe', 'value.float', { value: 1n }), node('output', 'output.fragment'),
], [edge('unsafe-out', 'unsafe', 'out', 'output', 'color')]));
assert.equal(unsafeUnknown.ok, false);
assert.equal(unsafeUnknown.diagnostics[0]?.stage, 'graph-schema');
assert.ok(codes(unsafeUnknown).includes('schema.invalid-node-value'));

for (const malformed of [
  graph([node('bad', 'value.float', { value: 'bad' }), node('output', 'output.fragment')], [edge('out', 'bad', 'out', 'output', 'color')]),
  graph([node('bad', 'vector.swizzle', { mask: 12 }), node('output', 'output.fragment')], [edge('out', 'bad', 'out', 'output', 'color')]),
  graph([node('output', 'output.fragment', { color: [0, 0, 1] })]),
  graph([
    node('value', 'value.float', { value: 0.5 }),
    node('output', 'output.fragment'),
    node('unreachable-bad', 'value.float', { value: 'bad' }),
  ], [edge('out', 'value', 'out', 'output', 'color')]),
]) {
  const result = compileGraph(malformed);
  assert.equal(result.ok, false);
  assert.equal(result.source, '');
  assert.ok(codes(result).some((code) =>
    code === 'graph.invalid-node-value' || code.startsWith('graph.value-')
  ));
}
const unreachableInvalidSwizzle = compileGraph(graph([
  node('value', 'value.float', { value: 0.5 }),
  node('output', 'output.fragment'),
  node('dead-vec2', 'vector.combine2'),
  node('dead-swizzle', 'vector.swizzle', { mask: 'z' }),
], [
  edge('out', 'value', 'out', 'output', 'color'),
  edge('dead', 'dead-vec2', 'out', 'dead-swizzle', 'value'),
]));
assert.equal(unreachableInvalidSwizzle.ok, false);
assert.equal(unreachableInvalidSwizzle.source, '');
assert.ok(codes(unreachableInvalidSwizzle).includes('type.inference-failed'));
const unknownValueField = compileGraph(graph([
  node('value', 'value.float', { value: 1, legacy: true }), node('output', 'output.fragment'),
], [edge('out', 'value', 'out', 'output', 'color')]));
assert.equal(unknownValueField.ok, false);
assert.ok(codes(unknownValueField).some((code) =>
  code === 'graph.unknown-node-value' || code === 'graph.value-undeclared'
));

const builtIr = buildTypedIr(valid);
assert.equal(builtIr.ok, true, builtIr.diagnostics.map((item) => item.message).join('\n'));
assert.ok(builtIr.ir);
assert.ok(builtIr.ir.bindings.every((binding) => typeof binding.expression.kind === 'string'));
assert.ok(builtIr.ir.bindings.every((binding) => !Object.hasOwn(binding.expression, 'expression')));
assert.equal(emitTypedIr(builtIr.ir).source, compiled.source);
const changedIr = {
  ...builtIr.ir,
  output: { kind: 'literal', value: [1, 0, 0, 1], type: 'color4', origin: { nodeId: builtIr.ir.outputNodeId } },
};
assert.notEqual(emitTypedIr(changedIr).source, compiled.source, 'GLSL emission must consume Typed IR output');

const splat = compileGraph(graph([
  node('value', 'value.float', { value: 0.25 }), node('output', 'output.fragment'),
], [edge('splat', 'value', 'out', 'output', 'color')]));
assert.equal(splat.ok, true);
assert.match(splat.source, /vec4\(_sg_n\d+_out\)/);
assert.equal(splat.ir?.output.kind, 'convert');
assert.equal(splat.ir?.output.type, 'color4');

const parameterGraph = graph([
  node('param-a', 'core.parameter', { parameterId: 'stable-a' }),
  node('param-b', 'core.parameter', { parameterId: 'stable-b' }),
  node('color', 'vector.combine4', { z: 0, w: 1 }),
  node('output', 'output.fragment'),
], [
  edge('pa', 'param-a', 'out', 'color', 'x'),
  edge('pb', 'param-b', 'out', 'color', 'y'),
  edge('po', 'color', 'out', 'output', 'color'),
], [
  { id: 'stable-a', name: 'main', valueType: 'float', defaultValue: 0.2, ui: { widget: 'slider', min: 0, max: 1, step: 0.01 } },
  { id: 'stable-b', name: 'main', valueType: 'float', defaultValue: 0.8, ui: { widget: 'slider', min: 0, max: 1, step: 0.01 } },
]);
const parameters = compileGraph(parameterGraph);
assert.equal(parameters.ok, true, parameters.diagnostics.map((d) => d.message).join('\n'));
assert.deepEqual(parameters.uniforms.map((uniform) => uniform.id).sort(), ['stable-a', 'stable-b']);
assert.equal(new Set(parameters.uniforms.map((uniform) => uniform.emittedName)).size, 2);
assert.ok(parameters.uniforms.every((uniform) => uniform.emittedName.startsWith('_sg_u_id_')));
const originalNames = new Map(parameters.uniforms.map((uniform) => [uniform.id, uniform.emittedName]));
const insertedParameterGraph = {
  ...parameterGraph,
  nodes: [node('param-0', 'core.parameter', { parameterId: 'stable-0' }), ...parameterGraph.nodes],
  edges: [edge('p0', 'param-0', 'out', 'color', 'z'), ...parameterGraph.edges],
  parameters: [
    { id: 'stable-0', name: 'main', valueType: 'float', defaultValue: 0.5, ui: { widget: 'slider' } },
    ...parameterGraph.parameters,
  ],
};
const insertedParameters = compileGraph(insertedParameterGraph);
assert.equal(insertedParameters.ok, true, insertedParameters.diagnostics.map((d) => d.message).join('\n'));
for (const [id, emittedName] of originalNames) {
  assert.equal(insertedParameters.uniforms.find((uniform) => uniform.id === id)?.emittedName, emittedName);
}
const renamedParameterGraph = {
  ...parameterGraph,
  parameters: parameterGraph.parameters.map((parameter) => parameter.id === 'stable-a' ? { ...parameter, name: 'renamed display' } : parameter),
};
const renamedParameters = compileGraph(renamedParameterGraph);
assert.equal(renamedParameters.ok, true);
assert.equal(renamedParameters.uniforms.find((uniform) => uniform.id === 'stable-a')?.emittedName, originalNames.get('stable-a'));
assert.equal(compileGraph(parameterGraph).uniforms.find((uniform) => uniform.id === 'stable-b')?.emittedName, originalNames.get('stable-b'));

const mappedEntry = compiled.sourceMap.entries.find((entry) => entry.socketId === 'out');
assert.equal(compiled.sourceMap.version, 1);
assert.equal(compiled.sourceMap.sourceHash, compiled.sourceHash);
assert.equal(compiled.sourceMap.semanticHash, compiled.semanticHash);
assert.equal(compiled.sourceMap.revision, compiled.artifact?.revision);
assert.equal(compiled.artifact?.sourceMap.sourceHash, compiled.artifact?.sourceHash);
assert.ok(mappedEntry);
assert.equal(lookupGraphSource(compiled.sourceMap, mappedEntry.startLine)?.nodeId, mappedEntry.nodeId);
const mappedDiagnostic = fromRuntimeDiagnosticWithGraphSourceMap({
  line: mappedEntry.startLine, column: 1, message: 'synthetic compile error', pass: 'image',
}, compiled.sourceMap);
assert.equal(mappedDiagnostic.origin.kind, 'graph');
assert.equal(mappedDiagnostic.origin.nodeId, mappedEntry.nodeId);
const staleDiagnostic = fromRuntimeDiagnosticWithGraphSourceMap({
  line: mappedEntry.startLine, column: 1, message: 'stale compile error', pass: 'image',
}, compiled.sourceMap, { sourceHash: 'fnv1a32:deadbeef', revision: compiled.sourceMap.revision });
assert.equal(staleDiagnostic.origin.kind, 'code');
const wrongRevisionDiagnostic = fromRuntimeDiagnosticWithGraphSourceMap({
  line: mappedEntry.startLine, column: 1, message: 'wrong revision', pass: 'image',
}, compiled.sourceMap, { sourceHash: compiled.sourceHash, revision: 'old-revision' });
assert.equal(wrongRevisionDiagnostic.origin.kind, 'code');
const fallbackDiagnostic = fromRuntimeDiagnosticWithGraphSourceMap({
  line: 99999, column: 2, message: 'unmapped', pass: 'image',
}, compiled.sourceMap);
assert.equal(fallbackDiagnostic.origin.kind, 'code');

const future = compileGraph({ ...valid, version: 2 });
assert.equal(future.ok, false);
assert.ok(codes(future).includes('schema.future-version'));
assert.doesNotThrow(() => compileGraph('{ definitely not json'));

const dagNodes = [node('n000', 'value.float', { value: 0.1 })];
const dagEdges = [];
for (let index = 1; index < 199; index++) {
  const id = `n${String(index).padStart(3, '0')}`;
  const previous = `n${String(index - 1).padStart(3, '0')}`;
  dagNodes.push(node(id, 'math.add', { b: 0.01 }));
  dagEdges.push(edge(`e${index}`, previous, 'out', id, 'a'));
}
dagNodes.push(node('output', 'output.fragment'));
dagEdges.push(edge('e-output', 'n198', 'out', 'output', 'color'));
const largeGraph = graph(dagNodes, dagEdges);
assert.equal(compileGraph(largeGraph).ok, true);
const timings = [];
for (let run = 0; run < 6; run++) {
  const started = performance.now();
  const result = compileGraph(largeGraph);
  timings.push(performance.now() - started);
  assert.equal(result.ok, true);
}
const measured = timings.slice(1);
const averageMs = measured.reduce((sum, value) => sum + value, 0) / measured.length;
const maxMs = Math.max(...measured);
console.log(`M1 node definitions: ${DEFAULT_NODE_REGISTRY.size}`);
console.log(`M1 200-node DAG compile: avg=${averageMs.toFixed(2)}ms max=${maxMs.toFixed(2)}ms`);
assert.ok(averageMs < 50, `200-node average compile ${averageMs.toFixed(2)}ms exceeded 50ms target`);
assert.ok(maxMs < 250, `200-node compile ${maxMs.toFixed(2)}ms exceeded CI tolerance`);

console.log('M1 pure-function checks passed');
