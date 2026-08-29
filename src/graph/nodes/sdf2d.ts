import { defineNodesPolicy, fixedOutputs, type NodeDefinition } from '../registry';

const BOTH_HOST_TARGETS = ['visual', 'sound'] as const;

const point = { id: 'point', title: 'Point', type: 'vec2' as const, defaultType: 'vec2' as const, defaultValue: [0, 0] };
const distance = { id: 'distance', title: 'Distance', type: 'float' as const, defaultType: 'float' as const, defaultValue: 0 };
const distanceOut = { id: 'out', title: 'Distance', type: 'float' as const };

const BOX_HELPER = `float _sg_sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
}`;
const ROUND_BOX_HELPER = `float _sg_sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}`;
const SEGMENT_HELPER = `float _sg_sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}`;

export const SDF2D_NODES: readonly NodeDefinition[] = defineNodesPolicy([
  {
    type: 'sdf2d.circle', version: 1, title: 'Circle SDF', category: 'SDF 2D',
    inputs: [point, { id: 'radius', title: 'Radius', type: 'float', defaultType: 'float', defaultValue: 0.5 }],
    outputs: [distanceOut], defaultValues: { point: [0, 0], radius: 0.5 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({ out: ir.intrinsic('(length({0}) - {1})', [inputs.point, inputs.radius], 'float') }),
  },
  {
    type: 'sdf2d.box', version: 1, title: 'Box SDF', category: 'SDF 2D',
    inputs: [point, { id: 'halfSize', title: 'Half Size', type: 'vec2', defaultType: 'vec2', defaultValue: [0.5, 0.5] }],
    outputs: [distanceOut], defaultValues: { point: [0, 0], halfSize: [0.5, 0.5] }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs, addHelper }) => {
      addHelper('sdBox', BOX_HELPER);
      return { out: ir.call('_sg_sdBox', [inputs.point, inputs.halfSize], 'float') };
    },
  },
  {
    type: 'sdf2d.rounded_box', version: 1, title: 'Rounded Box SDF', category: 'SDF 2D',
    inputs: [point, { id: 'halfSize', title: 'Half Size', type: 'vec2', defaultType: 'vec2', defaultValue: [0.5, 0.5] }, { id: 'radius', title: 'Radius', type: 'float', defaultType: 'float', defaultValue: 0.1 }],
    outputs: [distanceOut], defaultValues: { point: [0, 0], halfSize: [0.5, 0.5], radius: 0.1 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs, addHelper }) => {
      addHelper('sdRoundBox', ROUND_BOX_HELPER);
      return { out: ir.call('_sg_sdRoundBox', [inputs.point, inputs.halfSize, inputs.radius], 'float') };
    },
  },
  {
    type: 'sdf2d.segment', version: 1, title: 'Segment SDF', category: 'SDF 2D',
    inputs: [point, { id: 'a', title: 'A', type: 'vec2', defaultType: 'vec2', defaultValue: [-0.5, 0] }, { id: 'b', title: 'B', type: 'vec2', defaultType: 'vec2', defaultValue: [0.5, 0] }],
    outputs: [distanceOut], defaultValues: { point: [0, 0], a: [-0.5, 0], b: [0.5, 0] }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs, addHelper }) => {
      addHelper('sdSegment', SEGMENT_HELPER);
      return { out: ir.call('_sg_sdSegment', [inputs.point, inputs.a, inputs.b], 'float') };
    },
  },
  {
    type: 'sdf2d.union', version: 1, title: 'Union', category: 'SDF 2D',
    inputs: [{ ...distance, id: 'a', title: 'A' }, { ...distance, id: 'b', title: 'B' }], outputs: [distanceOut],
    defaultValues: { a: 0, b: 0 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({ out: ir.call('min', [inputs.a, inputs.b], 'float') }),
  },
  {
    type: 'sdf2d.intersection', version: 1, title: 'Intersection', category: 'SDF 2D',
    inputs: [{ ...distance, id: 'a', title: 'A' }, { ...distance, id: 'b', title: 'B' }], outputs: [distanceOut],
    defaultValues: { a: 0, b: 0 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({ out: ir.call('max', [inputs.a, inputs.b], 'float') }),
  },
  {
    type: 'sdf2d.difference', version: 1, title: 'Difference', category: 'SDF 2D',
    inputs: [{ ...distance, id: 'a', title: 'A' }, { ...distance, id: 'b', title: 'B' }], outputs: [distanceOut],
    defaultValues: { a: 0, b: 0 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({ out: ir.call('max', [inputs.a, ir.unary('-', inputs.b)], 'float') }),
  },
  {
    type: 'sdf2d.smooth_union', version: 1, title: 'Smooth Union', category: 'SDF 2D',
    inputs: [{ ...distance, id: 'a', title: 'A' }, { ...distance, id: 'b', title: 'B' }, { id: 'smoothness', title: 'Smoothness', type: 'float', defaultType: 'float', defaultValue: 0.1 }],
    outputs: [distanceOut], defaultValues: { a: 0, b: 0, smoothness: 0.1 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({
      out: ir.intrinsic('(mix({1}, {0}, clamp(0.5 + 0.5 * ({1} - {0}) / {2}, 0.0, 1.0)) - {2} * clamp(0.5 + 0.5 * ({1} - {0}) / {2}, 0.0, 1.0) * (1.0 - clamp(0.5 + 0.5 * ({1} - {0}) / {2}, 0.0, 1.0)))', [inputs.a, inputs.b, inputs.smoothness], 'float'),
    }),
  },
  {
    type: 'sdf2d.fill', version: 1, title: 'Fill', category: 'SDF 2D',
    inputs: [distance, { id: 'feather', title: 'Feather', type: 'float', defaultType: 'float', defaultValue: 0.005 }],
    outputs: [{ id: 'out', title: 'Mask', type: 'float' }], defaultValues: { distance: 0, feather: 0.005 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({ out: ir.intrinsic('(1.0 - smoothstep(-{1}, {1}, {0}))', [inputs.distance, inputs.feather], 'float') }),
  },
  {
    type: 'sdf2d.outline', version: 1, title: 'Outline', category: 'SDF 2D',
    inputs: [distance, { id: 'width', title: 'Width', type: 'float', defaultType: 'float', defaultValue: 0.02 }, { id: 'feather', title: 'Feather', type: 'float', defaultType: 'float', defaultValue: 0.005 }],
    outputs: [{ id: 'out', title: 'Mask', type: 'float' }], defaultValues: { distance: 0, width: 0.02, feather: 0.005 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({ out: ir.intrinsic('(1.0 - smoothstep({1} - {2}, {1} + {2}, abs({0})))', [inputs.distance, inputs.width, inputs.feather], 'float') }),
  },
  {
    type: 'sdf2d.glow', version: 1, title: 'Glow', category: 'SDF 2D',
    inputs: [distance, { id: 'radius', title: 'Radius', type: 'float', defaultType: 'float', defaultValue: 0.1 }, { id: 'intensity', title: 'Intensity', type: 'float', defaultType: 'float', defaultValue: 1 }],
    outputs: [{ id: 'out', title: 'Glow', type: 'float' }], defaultValues: { distance: 0, radius: 0.1, intensity: 1 }, inferTypes: fixedOutputs({ out: 'float' }),
    lower: ({ ir, inputs }) => ({ out: ir.intrinsic('({2} * exp(-abs({0}) / max({1}, 0.00001)))', [inputs.distance, inputs.radius, inputs.intensity], 'float') }),
  },
], BOTH_HOST_TARGETS, 'pure');
