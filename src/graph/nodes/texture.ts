import { defineNodesPolicy, fixedOutputs, valueField, type NodeDefinition } from '../registry';

const VISUAL_HOST_TARGETS = ['visual'] as const;

export const TEXTURE_NODES: readonly NodeDefinition[] = defineNodesPolicy([
  {
    type: 'input.texture2d', version: 1, title: 'Texture 2D', category: 'Texture',
    inputs: [{ id: 'uv', title: 'UV', type: 'vec2', defaultType: 'vec2', defaultValue: [0, 0] }],
    outputs: [
      { id: 'color', title: 'Color', type: 'color4' },
      { id: 'resolution', title: 'Resolution', type: 'vec2' },
    ],
    defaultValues: { uv: [0, 0], assetId: '', filter: 'linear', wrap: 'repeat' },
    valueFields: {
      assetId: valueField((value) => typeof value === 'string' ? undefined : { code: 'graph.value-asset-id-string-required' }),
      filter: valueField((value) => value === 'linear' || value === 'nearest' ? undefined : { code: 'graph.value-filter-invalid' }),
      wrap: valueField((value) => value === 'repeat' || value === 'clamp' ? undefined : { code: 'graph.value-wrap-invalid' }),
    },
    inferTypes: fixedOutputs({ color: 'color4', resolution: 'vec2' }),
    lower: ({ node, inputs, ir, textureBinding, addHelper }) => {
      const binding = textureBinding(node.id);
      if (!binding) throw new Error(`Texture2D ${node.id} 缺少 resolved asset binding`);
      if (binding.colorSpace === 'srgb') {
        addHelper('texture:srgb-decode', `vec4 _sg_decodeSrgb(vec4 value) {
    vec3 low = value.rgb / 12.92;
    vec3 high = pow((value.rgb + 0.055) / 1.055, vec3(2.4));
    return vec4(mix(low, high, step(vec3(0.04045), value.rgb)), value.a);
}`);
      }
      const sampled = binding.colorSpace === 'srgb'
        ? ir.intrinsic(`_sg_decodeSrgb(texture(iChannel${binding.slot}, {0}))`, [inputs.uv], 'color4')
        : ir.intrinsic(`texture(iChannel${binding.slot}, {0})`, [inputs.uv], 'color4');
      return {
        color: sampled,
        resolution: ir.intrinsic(`iChannelResolution[${binding.slot}].xy`, [], 'vec2'),
      };
    },
  },
], VISUAL_HOST_TARGETS, 'resource');
