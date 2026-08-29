import { defineNodesPolicy, fixedOutputs, type NodeDefinition } from '../registry';

const BOTH_HOST_TARGETS = ['visual', 'sound'] as const;

const RGB_HSV_HELPER = `vec3 _sg_rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -0.3333333333, 0.6666666667, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}`;
const HSV_RGB_HELPER = `vec3 _sg_hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(0.0, 0.6666666667, 0.3333333333)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}`;

const color3 = { id: 'color', title: 'Color', type: 'color3' as const, defaultType: 'color3' as const, defaultValue: [0, 0, 0] };
const colorOut = { id: 'out', title: 'Color', type: 'color3' as const };

export const COLOR_NODES: readonly NodeDefinition[] = defineNodesPolicy([
  {
    type: 'color.rgb_to_hsv', version: 1, title: 'RGB to HSV', category: 'Color',
    inputs: [color3], outputs: [colorOut], defaultValues: { color: [0, 0, 0] }, inferTypes: fixedOutputs({ out: 'color3' }),
    lower: ({ ir, inputs, addHelper }) => {
      addHelper('rgb2hsv', RGB_HSV_HELPER);
      return { out: ir.call('_sg_rgb2hsv', [inputs.color], 'color3') };
    },
  },
  {
    type: 'color.hsv_to_rgb', version: 1, title: 'HSV to RGB', category: 'Color',
    inputs: [color3], outputs: [colorOut], defaultValues: { color: [0, 0, 0] }, inferTypes: fixedOutputs({ out: 'color3' }),
    lower: ({ ir, inputs, addHelper }) => {
      addHelper('hsv2rgb', HSV_RGB_HELPER);
      return { out: ir.call('_sg_hsv2rgb', [inputs.color], 'color3') };
    },
  },
  {
    type: 'color.brightness', version: 1, title: 'Brightness', category: 'Color',
    inputs: [color3, { id: 'amount', title: 'Amount', type: 'float', defaultType: 'float', defaultValue: 0 }],
    outputs: [colorOut], defaultValues: { color: [0, 0, 0], amount: 0 }, inferTypes: fixedOutputs({ out: 'color3' }),
    lower: ({ ir, inputs }) => ({ out: ir.binary('+', inputs.color, ir.construct('vec3', [inputs.amount]), 'color3') }),
  },
  {
    type: 'color.contrast', version: 1, title: 'Contrast', category: 'Color',
    inputs: [color3, { id: 'amount', title: 'Amount', type: 'float', defaultType: 'float', defaultValue: 1 }],
    outputs: [colorOut], defaultValues: { color: [0, 0, 0], amount: 1 }, inferTypes: fixedOutputs({ out: 'color3' }),
    lower: ({ ir, inputs }) => ({ out: ir.intrinsic('(({0} - vec3(0.5)) * {1} + vec3(0.5))', [inputs.color, inputs.amount], 'color3') }),
  },
  {
    type: 'color.saturation', version: 1, title: 'Saturation', category: 'Color',
    inputs: [color3, { id: 'amount', title: 'Amount', type: 'float', defaultType: 'float', defaultValue: 1 }],
    outputs: [colorOut], defaultValues: { color: [0, 0, 0], amount: 1 }, inferTypes: fixedOutputs({ out: 'color3' }),
    lower: ({ ir, inputs }) => ({ out: ir.intrinsic('mix(vec3(dot({0}, vec3(0.2126, 0.7152, 0.0722))), {0}, {1})', [inputs.color, inputs.amount], 'color3') }),
  },
  {
    type: 'color.invert', version: 1, title: 'Invert', category: 'Color', inputs: [color3], outputs: [colorOut],
    defaultValues: { color: [0, 0, 0] }, inferTypes: fixedOutputs({ out: 'color3' }),
    lower: ({ ir, inputs }) => ({ out: ir.binary('-', ir.construct('vec3', [ir.literal(1, 'float')]), inputs.color, 'color3') }),
  },
  {
    type: 'color.gamma', version: 1, title: 'Gamma', category: 'Color',
    inputs: [color3, { id: 'gamma', title: 'Gamma', type: 'float', defaultType: 'float', defaultValue: 2.2 }],
    outputs: [colorOut], defaultValues: { color: [0, 0, 0], gamma: 2.2 }, inferTypes: fixedOutputs({ out: 'color3' }),
    lower: ({ ir, inputs }) => ({ out: ir.intrinsic('pow(max({0}, vec3(0.0)), vec3(1.0 / {1}))', [inputs.color, inputs.gamma], 'color3') }),
  },
  {
    type: 'color.from_vec3', version: 1, title: 'Vector to Color', category: 'Color',
    inputs: [{ id: 'value', title: 'Vector', type: 'vec3', defaultType: 'vec3', defaultValue: [0, 0, 0] }],
    outputs: [colorOut], defaultValues: { value: [0, 0, 0] }, inferTypes: fixedOutputs({ out: 'color3' }),
    lower: ({ inputs }) => ({ out: inputs.value }),
  },
], BOTH_HOST_TARGETS, 'pure');
