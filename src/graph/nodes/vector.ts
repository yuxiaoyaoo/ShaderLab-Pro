import { defineNodesPolicy, fixedOutputs, firstInputType, valueField, type NodeDefinition } from '../registry';

const BOTH_HOST_TARGETS = ['visual', 'sound'] as const;

export const VECTOR_NODES: readonly NodeDefinition[] = defineNodesPolicy([
  {
    type: 'vector.combine2', version: 1, title: 'Combine Vec2', category: 'Vector',
    inputs: [
      { id: 'x', title: 'X', type: 'float', defaultType: 'float', defaultValue: 0 },
      { id: 'y', title: 'Y', type: 'float', defaultType: 'float', defaultValue: 0 },
    ],
    outputs: [{ id: 'out', title: 'Vector', type: 'vec2' }], defaultValues: { x: 0, y: 0 },
    inferTypes: fixedOutputs({ out: 'vec2' }), lower: ({ ir, inputs }) => ({ out: ir.construct('vec2', [inputs.x, inputs.y]) }),
  },
  {
    type: 'vector.combine3', version: 1, title: 'Combine Vec3', category: 'Vector',
    inputs: [
      { id: 'x', title: 'X', type: 'float', defaultType: 'float', defaultValue: 0 },
      { id: 'y', title: 'Y', type: 'float', defaultType: 'float', defaultValue: 0 },
      { id: 'z', title: 'Z', type: 'float', defaultType: 'float', defaultValue: 0 },
    ],
    outputs: [{ id: 'out', title: 'Vector', type: 'vec3' }], defaultValues: { x: 0, y: 0, z: 0 },
    inferTypes: fixedOutputs({ out: 'vec3' }), lower: ({ ir, inputs }) => ({ out: ir.construct('vec3', [inputs.x, inputs.y, inputs.z]) }),
  },
  {
    type: 'vector.combine4', version: 1, title: 'Combine Vec4', category: 'Vector',
    inputs: [
      { id: 'x', title: 'X', type: 'float', defaultType: 'float', defaultValue: 0 },
      { id: 'y', title: 'Y', type: 'float', defaultType: 'float', defaultValue: 0 },
      { id: 'z', title: 'Z', type: 'float', defaultType: 'float', defaultValue: 0 },
      { id: 'w', title: 'W', type: 'float', defaultType: 'float', defaultValue: 1 },
    ],
    outputs: [{ id: 'out', title: 'Vector', type: 'vec4' }], defaultValues: { x: 0, y: 0, z: 0, w: 1 },
    inferTypes: fixedOutputs({ out: 'vec4' }), lower: ({ ir, inputs }) => ({ out: ir.construct('vec4', [inputs.x, inputs.y, inputs.z, inputs.w]) }),
  },
  {
    type: 'vector.split2', version: 1, title: 'Split Vec2', category: 'Vector',
    inputs: [{ id: 'value', title: 'Vector', type: 'vec2', defaultType: 'vec2', defaultValue: [0, 0] }],
    outputs: [{ id: 'x', title: 'X', type: 'float' }, { id: 'y', title: 'Y', type: 'float' }],
    defaultValues: { value: [0, 0] }, inferTypes: fixedOutputs({ x: 'float', y: 'float' }),
    lower: ({ ir, inputs }) => ({ x: ir.swizzle(inputs.value, 'x', 'float'), y: ir.swizzle(inputs.value, 'y', 'float') }),
  },
  {
    type: 'vector.split3', version: 1, title: 'Split Vec3', category: 'Vector',
    inputs: [{ id: 'value', title: 'Vector', type: 'vec3', defaultType: 'vec3', defaultValue: [0, 0, 0] }],
    outputs: [{ id: 'x', title: 'X', type: 'float' }, { id: 'y', title: 'Y', type: 'float' }, { id: 'z', title: 'Z', type: 'float' }],
    defaultValues: { value: [0, 0, 0] }, inferTypes: fixedOutputs({ x: 'float', y: 'float', z: 'float' }),
    lower: ({ ir, inputs }) => ({
      x: ir.swizzle(inputs.value, 'x', 'float'), y: ir.swizzle(inputs.value, 'y', 'float'), z: ir.swizzle(inputs.value, 'z', 'float'),
    }),
  },
  {
    type: 'vector.split4', version: 1, title: 'Split Vec4', category: 'Vector',
    inputs: [{ id: 'value', title: 'Vector', type: 'vec4', defaultType: 'vec4', defaultValue: [0, 0, 0, 0] }],
    outputs: [
      { id: 'x', title: 'X', type: 'float' }, { id: 'y', title: 'Y', type: 'float' },
      { id: 'z', title: 'Z', type: 'float' }, { id: 'w', title: 'W', type: 'float' },
    ],
    defaultValues: { value: [0, 0, 0, 0] }, inferTypes: fixedOutputs({ x: 'float', y: 'float', z: 'float', w: 'float' }),
    lower: ({ ir, inputs }) => ({
      x: ir.swizzle(inputs.value, 'x', 'float'), y: ir.swizzle(inputs.value, 'y', 'float'),
      z: ir.swizzle(inputs.value, 'z', 'float'), w: ir.swizzle(inputs.value, 'w', 'float'),
    }),
  },
  {
    type: 'vector.swizzle', version: 1, title: 'Swizzle', category: 'Vector',
    inputs: [{ id: 'value', title: 'Vector', type: 'vector', defaultType: 'vec4', defaultValue: [0, 0, 0, 0] }],
    outputs: [{ id: 'out', title: 'Vector', type: 'vector' }], defaultValues: { mask: 'xy' },
    valueFields: {
      mask: valueField((value) => typeof value === 'string' && /^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(value)
        ? undefined
        : { code: 'graph.value-vector-mask-invalid' }),
    },
    inferTypes: ({ node, inputTypes }) => {
      const mask = node.values.mask === undefined ? 'xy' : node.values.mask;
      if (typeof mask !== 'string') return null;
      const inputType = inputTypes.value === 'color3' ? 'vec3' : inputTypes.value === 'color4' ? 'vec4' : inputTypes.value;
      const components = inputType === 'vec2' ? 2 : inputType === 'vec3' ? 3 : inputType === 'vec4' ? 4 : 0;
      const names = 'rgba'.includes(mask[0]) ? 'rgba' : 'xyzw';
      if ([...mask].some((component) => names.indexOf(component) >= components)) return null;
      return { out: mask.length === 1 ? 'float' : `vec${mask.length}` as 'vec2' | 'vec3' | 'vec4' };
    },
    lower: ({ ir, inputs, outputTypes, value }) => ({ out: ir.swizzle(inputs.value, value('mask') as string, outputTypes.out) }),
  },
  {
    type: 'vector.reflect', version: 1, title: 'Reflect', category: 'Vector',
    inputs: [
      { id: 'incident', title: 'Incident', type: 'vector', defaultType: 'vec2', defaultValue: [0, 0] },
      { id: 'normal', title: 'Normal', type: 'vector', defaultType: 'vec2', defaultValue: [0, 1] },
    ],
    outputs: [{ id: 'out', title: 'Vector', type: 'vector' }], defaultValues: { incident: [0, 0], normal: [0, 1] },
    inferTypes: ({ inputTypes }) => {
      const incident = inputTypes.incident === 'color3' ? 'vec3' : inputTypes.incident === 'color4' ? 'vec4' : inputTypes.incident;
      const normal = inputTypes.normal === 'color3' ? 'vec3' : inputTypes.normal === 'color4' ? 'vec4' : inputTypes.normal;
      return incident === normal ? { out: inputTypes.incident } : null;
    },
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.call('reflect', [inputs.incident, inputs.normal], outputTypes.out) }),
  },
  {
    type: 'vector.rotate2d', version: 1, title: 'Rotate 2D', category: 'Vector',
    inputs: [
      { id: 'vector', title: 'Vector', type: 'vec2', defaultType: 'vec2', defaultValue: [0, 0] },
      { id: 'angle', title: 'Angle', type: 'float', defaultType: 'float', defaultValue: 0 },
    ],
    outputs: [{ id: 'out', title: 'Vector', type: 'vec2' }], defaultValues: { vector: [0, 0], angle: 0 },
    inferTypes: fixedOutputs({ out: 'vec2' }),
    lower: ({ ir, inputs }) => ({ out: ir.intrinsic('(mat2(cos({0}), -sin({0}), sin({0}), cos({0})) * {1})', [inputs.angle, inputs.vector], 'vec2') }),
  },
  {
    type: 'vector.scale', version: 1, title: 'Scale Vector', category: 'Vector',
    inputs: [
      { id: 'vector', title: 'Vector', type: 'vector', defaultType: 'vec2', defaultValue: [0, 0] },
      { id: 'scale', title: 'Scale', type: 'float', defaultType: 'float', defaultValue: 1 },
    ],
    outputs: [{ id: 'out', title: 'Vector', type: 'vector' }], defaultValues: { vector: [0, 0], scale: 1 },
    inferTypes: ({ inputTypes }) => inputTypes.vector ? { out: inputTypes.vector } : null,
    lower: ({ ir, inputs, outputTypes }) => ({ out: ir.binary('*', inputs.vector, inputs.scale, outputTypes.out) }),
  },
  {
    type: 'vector.append_alpha', version: 1, title: 'Append Alpha', category: 'Vector',
    inputs: [
      { id: 'rgb', title: 'RGB', type: 'vec3', defaultType: 'vec3', defaultValue: [0, 0, 0] },
      { id: 'alpha', title: 'Alpha', type: 'float', defaultType: 'float', defaultValue: 1 },
    ],
    outputs: [{ id: 'out', title: 'RGBA', type: 'color4' }], defaultValues: { rgb: [0, 0, 0], alpha: 1 },
    inferTypes: fixedOutputs({ out: 'color4' }), lower: ({ ir, inputs }) => ({ out: ir.construct('color4', [inputs.rgb, inputs.alpha]) }),
  },
], BOTH_HOST_TARGETS, 'pure');
