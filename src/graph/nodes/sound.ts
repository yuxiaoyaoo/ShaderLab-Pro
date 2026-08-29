import {
  defineNodePolicy,
  defineNodesPolicy,
  fixedOutputs,
  type NodeDefinition,
} from '../registry';

const SOUND_HOST_TARGETS = ['sound'] as const;

export const SOUND_NODES: readonly NodeDefinition[] = [
  defineNodePolicy({
    type: 'output.sound', version: 1, title: 'Sound Output', category: 'Output', output: true, outputTarget: 'sound',
    inputs: [{ id: 'sample', title: 'Stereo Sample', type: 'vec2', defaultType: 'vec2', defaultValue: [0, 0] }],
    outputs: [], defaultValues: { sample: [0, 0] }, inferTypes: fixedOutputs({}), lower: ({ inputs }) => ({ output: inputs.sample }),
  }, SOUND_HOST_TARGETS, 'output'),
  ...defineNodesPolicy([
    {
      type: 'input.sample_time', version: 1, title: 'Sample Time', category: 'Sound', inputs: [], outputs: [{ id: 'out', title: 'Seconds', type: 'float' }],
      defaultValues: {}, inferTypes: fixedOutputs({ out: 'float' }), lower: ({ ir }) => ({ out: ir.builtin('sampleTime', 'float') }),
    },
    {
      type: 'input.sample_index', version: 1, title: 'Sample Index', category: 'Sound', inputs: [], outputs: [{ id: 'out', title: 'Sample', type: 'float' }],
      defaultValues: {}, inferTypes: fixedOutputs({ out: 'float' }), lower: ({ ir }) => ({ out: ir.builtin('sampleIndex', 'float') }),
    },
    {
      type: 'input.sample_rate', version: 1, title: 'Sample Rate', category: 'Sound', inputs: [], outputs: [{ id: 'out', title: 'Hz', type: 'float' }],
      defaultValues: {}, inferTypes: fixedOutputs({ out: 'float' }), lower: ({ ir }) => ({ out: ir.builtin('sampleRate', 'float') }),
    },
  ], SOUND_HOST_TARGETS, 'contextual'),
];
