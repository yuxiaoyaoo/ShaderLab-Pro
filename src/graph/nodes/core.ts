import type { GraphValueType } from '../model';
import {
  asGraphParameterValue,
  commonNumericType,
  fixedOutputs,
  firstInputType,
  graphValueField,
  valueField,
  type NodeDefinition,
  type SocketDefinition,
} from '../registry';
import type { IrBuiltinName } from '../compiler/ir';

const BOTH_HOST_TARGETS = ['visual', 'sound'] as const;
const VISUAL_HOST_TARGETS = ['visual'] as const;

const numeric = (id: string, title: string, defaultValue = 0): SocketDefinition => ({
  id, title, type: 'numeric', defaultType: 'float', defaultValue,
});
const vector = (id: string, title: string, defaultValue: number[] = [0, 0]): SocketDefinition => ({
  id, title, type: 'vector', defaultType: 'vec2', defaultValue,
});
const output = (id = 'out', type: SocketDefinition['type'] = 'numeric'): SocketDefinition => ({ id, title: 'Out', type });

function source(type: string, title: string, valueType: GraphValueType, builtin: IrBuiltinName, hostTargets: NodeDefinition['hostTargets'] = BOTH_HOST_TARGETS): NodeDefinition {
  return {
    type, version: 1, title, category: 'Input', hostTargets, groupKind: 'contextual', inputs: [], outputs: [{ id: 'out', title: 'Out', type: valueType }],
    defaultValues: {}, inferTypes: fixedOutputs({ out: valueType }),
    lower: ({ ir }) => ({ out: ir.builtin(builtin, valueType) }),
  };
}

function unary(type: string, title: string, functionName: string): NodeDefinition {
  return {
    type, version: 1, title, category: 'Math', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [numeric('value', 'Value')], outputs: [output()],
    defaultValues: { value: 0 }, inferTypes: firstInputType(),
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.call(functionName, [inputs.value], outputTypes.out) }),
  };
}

function binary(type: string, title: string, operator: '+' | '-' | '*' | '/' | string, asFunction = false): NodeDefinition {
  return {
    type, version: 1, title, category: 'Math', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [numeric('a', 'A'), numeric('b', 'B')], outputs: [output()],
    defaultValues: { a: 0, b: type === 'math.divide' ? 1 : 0 },
    inferTypes: ({ inputTypes }) => {
      const result = commonNumericType([inputTypes.a, inputTypes.b]);
      return result ? { out: result } : null;
    },
    lower: ({ ir, inputs, outputTypes }) => ({
      out: asFunction
        ? ir.call(operator, [inputs.a, inputs.b], outputTypes.out)
        : ir.binary(operator as '+' | '-' | '*' | '/', inputs.a, inputs.b, outputTypes.out),
    }),
  };
}

export const CORE_NODES: readonly NodeDefinition[] = [
  {
    type: 'output.fragment', version: 1, title: 'Fragment Output', category: 'Output', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'output',
    inputs: [{ id: 'color', title: 'Color', type: 'color4', defaultType: 'color4', defaultValue: [0, 0, 0, 1] }],
    outputs: [], defaultValues: { color: [0, 0, 0, 1] }, output: true, outputTarget: 'visual',
    inferTypes: fixedOutputs({}), lower: ({ inputs }) => ({ fragment: inputs.color }),
  },
  source('input.uv', 'UV', 'vec2', 'uv', VISUAL_HOST_TARGETS),
  source('input.aspect_uv', 'Aspect UV', 'vec2', 'aspectUv', VISUAL_HOST_TARGETS),
  source('input.time', 'Time', 'float', 'time'),
  source('input.resolution', 'Resolution', 'vec2', 'resolution'),
  source('input.frag_coord', 'Fragment Coordinate', 'vec2', 'fragCoord', VISUAL_HOST_TARGETS),
  source('input.frame', 'Frame', 'float', 'frame'),
  source('input.mouse', 'Mouse', 'vec4', 'mouse'),
  {
    type: 'input.channel-sample', version: 1, title: 'iChannel Sample', category: 'Input', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'resource',
    inputs: [{ id: 'uv', title: 'UV', type: 'vec2', defaultType: 'vec2', defaultValue: [0, 0] }],
    outputs: [{ id: 'color', title: 'Color', type: 'color4' }], defaultValues: { uv: [0, 0] },
    inferTypes: fixedOutputs({ color: 'color4' }),
    lower: ({ node, inputs, ir, channelSlot }) => {
      const slot = channelSlot(node.id);
      if (slot === undefined) throw new Error(`Channel sample ${node.id} is not connected in the project Pass Graph`);
      return { color: ir.intrinsic(`texture(iChannel${slot}, {0})`, [inputs.uv], 'color4') };
    },
  },
  {
    type: 'value.float', version: 1, title: 'Float', category: 'Input', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [],
    outputs: [{ id: 'out', title: 'Value', type: 'float' }], defaultValues: { value: 0 },
    valueFields: { value: graphValueField('float') }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, value }) => ({ out: ir.literal(asGraphParameterValue(value('value')), 'float') }),
  },
  {
    type: 'value.int', version: 1, title: 'Integer', category: 'Input', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [],
    outputs: [{ id: 'out', title: 'Value', type: 'int' }], defaultValues: { value: 0 },
    valueFields: { value: graphValueField('int') }, inferTypes: fixedOutputs({ out: 'int' }),
    lower: ({ ir, value }) => ({ out: ir.literal(asGraphParameterValue(value('value')), 'int') }),
  },
  {
    type: 'value.bool', version: 1, title: 'Boolean', category: 'Input', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [],
    outputs: [{ id: 'out', title: 'Value', type: 'bool' }], defaultValues: { value: false },
    valueFields: { value: graphValueField('bool') }, inferTypes: fixedOutputs({ out: 'bool' }),
    lower: ({ ir, value }) => ({ out: ir.literal(asGraphParameterValue(value('value')), 'bool') }),
  },
  {
    type: 'core.parameter', version: 1, title: 'Parameter', category: 'Input', hostTargets: BOTH_HOST_TARGETS, groupKind: 'resource', inputs: [],
    outputs: [{ id: 'out', title: 'Value', type: 'any-value' }], defaultValues: { parameterId: '' },
    valueFields: { parameterId: valueField((value) => typeof value === 'string' ? undefined : { code: 'graph.value-string-required' }) },
    inferTypes: ({ parameterType }) => parameterType ? { out: parameterType } : null,
    lower: ({ ir, parameterName, parameterType }) => {
      if (!parameterName || !parameterType) throw new Error('Parameter lowering requires a validated parameter');
      return { out: ir.uniform(parameterName, parameterType) };
    },
  },
  {
    type: 'core.reroute', version: 1, title: 'Reroute', category: 'Layout', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure',
    inputs: [{ id: 'value', title: 'Value', type: 'any-value', defaultType: 'float', defaultValue: 0 }],
    outputs: [{ id: 'out', title: 'Value', type: 'any-value' }], defaultValues: { value: 0 },
    inferTypes: firstInputType(),
    lower: ({ inputs }) => ({ out: inputs.value }),
  },
  binary('math.add', 'Add', '+'),
  binary('math.subtract', 'Subtract', '-'),
  binary('math.multiply', 'Multiply', '*'),
  binary('math.divide', 'Divide', '/'),
  binary('math.minimum', 'Minimum', 'min', true),
  binary('math.maximum', 'Maximum', 'max', true),
  binary('math.power', 'Power', 'pow', true),
  binary('math.modulo', 'Modulo', 'mod', true),
  unary('math.sin', 'Sine', 'sin'), unary('math.cos', 'Cosine', 'cos'), unary('math.tan', 'Tangent', 'tan'),
  unary('math.abs', 'Absolute', 'abs'), unary('math.floor', 'Floor', 'floor'), unary('math.ceil', 'Ceiling', 'ceil'),
  unary('math.fract', 'Fraction', 'fract'), unary('math.sqrt', 'Square Root', 'sqrt'),
  unary('math.exp', 'Exponential', 'exp'), unary('math.log', 'Logarithm', 'log'),
  {
    type: 'math.negate', version: 1, title: 'Negate', category: 'Math', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [numeric('value', 'Value')],
    outputs: [output()], defaultValues: { value: 0 }, inferTypes: firstInputType(),
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.unary('-', inputs.value, outputTypes.out) }),
  },
  {
    type: 'math.one_minus', version: 1, title: 'One Minus', category: 'Math', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [numeric('value', 'Value')],
    outputs: [output()], defaultValues: { value: 0 }, inferTypes: firstInputType(),
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.binary('-', ir.literal(1, 'float'), inputs.value, outputTypes.out) }),
  },
  {
    type: 'math.clamp', version: 1, title: 'Clamp', category: 'Math', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure',
    inputs: [numeric('value', 'Value'), numeric('min', 'Min'), numeric('max', 'Max', 1)], outputs: [output()],
    defaultValues: { value: 0, min: 0, max: 1 },
    inferTypes: ({ inputTypes }) => {
      const result = commonNumericType([inputTypes.value, inputTypes.min, inputTypes.max]);
      return result ? { out: result } : null;
    },
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.call('clamp', [inputs.value, inputs.min, inputs.max], outputTypes.out) }),
  },
  {
    type: 'math.mix', version: 1, title: 'Mix', category: 'Math', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure',
    inputs: [numeric('a', 'A'), numeric('b', 'B'), { id: 'factor', title: 'Factor', type: 'float', defaultType: 'float', defaultValue: 0.5 }],
    outputs: [output()], defaultValues: { a: 0, b: 1, factor: 0.5 },
    inferTypes: ({ inputTypes }) => {
      const result = commonNumericType([inputTypes.a, inputTypes.b]);
      return result ? { out: result } : null;
    },
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.call('mix', [inputs.a, inputs.b, inputs.factor], outputTypes.out) }),
  },
  {
    type: 'math.step', version: 1, title: 'Step', category: 'Math', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure',
    inputs: [numeric('edge', 'Edge', 0.5), numeric('value', 'Value')], outputs: [output()], defaultValues: { edge: 0.5, value: 0 },
    inferTypes: ({ inputTypes }) => {
      const result = commonNumericType([inputTypes.edge, inputTypes.value]);
      return result ? { out: result } : null;
    },
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.call('step', [inputs.edge, inputs.value], outputTypes.out) }),
  },
  {
    type: 'math.smoothstep', version: 1, title: 'Smoothstep', category: 'Math', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure',
    inputs: [numeric('edge0', 'Edge 0'), numeric('edge1', 'Edge 1', 1), numeric('value', 'Value')],
    outputs: [output()], defaultValues: { edge0: 0, edge1: 1, value: 0 },
    inferTypes: ({ inputTypes }) => {
      const result = commonNumericType([inputTypes.edge0, inputTypes.edge1, inputTypes.value]);
      return result ? { out: result } : null;
    },
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.call('smoothstep', [inputs.edge0, inputs.edge1, inputs.value], outputTypes.out) }),
  },
  {
    type: 'vector.length', version: 1, title: 'Length', category: 'Vector', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [vector('value', 'Vector')],
    outputs: [{ id: 'out', title: 'Length', type: 'float' }], defaultValues: { value: [0, 0] }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({ out: ir.call('length', [inputs.value], 'float') }),
  },
  {
    type: 'vector.distance', version: 1, title: 'Distance', category: 'Vector', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [vector('a', 'A'), vector('b', 'B')],
    outputs: [{ id: 'out', title: 'Distance', type: 'float' }], defaultValues: { a: [0, 0], b: [0, 0] },
    inferTypes: ({ inputTypes }) => {
      const a = inputTypes.a === 'color3' ? 'vec3' : inputTypes.a === 'color4' ? 'vec4' : inputTypes.a;
      const b = inputTypes.b === 'color3' ? 'vec3' : inputTypes.b === 'color4' ? 'vec4' : inputTypes.b;
      return a === b ? { out: 'float' } : null;
    },
    lower: ({ ir, inputs }) => ({ out: ir.call('distance', [inputs.a, inputs.b], 'float') }),
  },
  {
    type: 'vector.dot', version: 1, title: 'Dot Product', category: 'Vector', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [vector('a', 'A'), vector('b', 'B')],
    outputs: [{ id: 'out', title: 'Dot', type: 'float' }], defaultValues: { a: [0, 0], b: [0, 0] },
    inferTypes: ({ inputTypes }) => {
      const a = inputTypes.a === 'color3' ? 'vec3' : inputTypes.a === 'color4' ? 'vec4' : inputTypes.a;
      const b = inputTypes.b === 'color3' ? 'vec3' : inputTypes.b === 'color4' ? 'vec4' : inputTypes.b;
      return a === b ? { out: 'float' } : null;
    },
    lower: ({ ir, inputs }) => ({ out: ir.call('dot', [inputs.a, inputs.b], 'float') }),
  },
  {
    type: 'vector.normalize', version: 1, title: 'Normalize', category: 'Vector', hostTargets: BOTH_HOST_TARGETS, groupKind: 'pure', inputs: [vector('value', 'Vector')],
    outputs: [{ id: 'out', title: 'Vector', type: 'vector' }], defaultValues: { value: [0, 0] }, inferTypes: firstInputType(),
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.call('normalize', [inputs.value], outputTypes.out) }),
  },
];
