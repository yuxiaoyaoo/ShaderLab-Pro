import { fixedOutputs, type NodeDefinition, type SocketDefinition } from '../registry';
import type { IrSdfSceneExpr, SdfSceneNode } from '../compiler/ir';

const VISUAL_HOST_TARGETS = ['visual'] as const;

const scalar = (id: string, title: string, value: number): SocketDefinition => ({ id, title, type: 'float', defaultType: 'float', defaultValue: value });
const vector3 = (id: string, title: string, value: number[]): SocketDefinition => ({ id, title, type: 'vec3', defaultType: 'vec3', defaultValue: value });
const sceneInput = (id: string, title: string): SocketDefinition => ({ id, title, type: 'sdf3', defaultType: 'sdf3', required: true });
const sceneOutput: SocketDefinition = { id: 'scene', title: 'Scene', type: 'sdf3' };

function asScene(value: { kind: string }, node: string): IrSdfSceneExpr {
  if (value.kind !== 'sdf-scene') throw new Error(`${node} 需要结构化 SDF Scene 输入`);
  return value as IrSdfSceneExpr;
}

function primitive(type: string, title: string, inputs: SocketDefinition[], defaults: Record<string, unknown>, build: (values: Record<string, import('../compiler/ir').IrExpr>) => SdfSceneNode): NodeDefinition {
  return {
    type, version: 1, title, category: 'SDF 3D', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'pure', inputs, outputs: [sceneOutput], defaultValues: defaults,
    inferTypes: fixedOutputs({ scene: 'sdf3' }),
    lower: ({ inputs: values, ir }) => ({ scene: ir.sdfScene(build(values)) }),
  };
}

export const SDF3D_NODES: readonly NodeDefinition[] = [
  primitive('sdf3.sphere', 'Sphere', [scalar('radius', 'Radius', 0.75)], { radius: 0.75 }, (v) => ({ kind: 'sphere', radius: v.radius })),
  primitive('sdf3.box', 'Box', [vector3('halfSize', 'Half Size', [0.6, 0.6, 0.6]), scalar('roundness', 'Roundness', 0.05)], { halfSize: [0.6, 0.6, 0.6], roundness: 0.05 }, (v) => ({ kind: 'box', halfSize: v.halfSize, roundness: v.roundness })),
  primitive('sdf3.torus', 'Torus', [vector3('radii', 'Major / Minor', [0.7, 0.22, 0])], { radii: [0.7, 0.22, 0] }, (v) => ({ kind: 'torus', radii: v.radii })),
  {
    type: 'sdf3.translate', version: 1, title: 'Translate', category: 'SDF 3D', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'pure',
    inputs: [sceneInput('scene', 'Scene'), vector3('offset', 'Offset', [0, 0, 0])], outputs: [sceneOutput], defaultValues: { scene: [1e6, 0.7, 0.7, 0.7], offset: [0, 0, 0] },
    inferTypes: fixedOutputs({ scene: 'sdf3' }), lower: ({ inputs, ir }) => ({ scene: ir.sdfScene({ kind: 'translate', child: asScene(inputs.scene, 'Translate').scene, offset: inputs.offset }) }),
  },
  {
    type: 'sdf3.scale', version: 1, title: 'Scale', category: 'SDF 3D', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'pure',
    inputs: [sceneInput('scene', 'Scene'), scalar('scale', 'Scale', 1)], outputs: [sceneOutput], defaultValues: { scene: [1e6, 0.7, 0.7, 0.7], scale: 1 },
    inferTypes: fixedOutputs({ scene: 'sdf3' }), lower: ({ inputs, ir }) => ({ scene: ir.sdfScene({ kind: 'scale', child: asScene(inputs.scene, 'Scale').scene, scale: inputs.scale }) }),
  },
  {
    type: 'sdf3.rotate_y', version: 1, title: 'Rotate Y', category: 'SDF 3D', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'pure',
    inputs: [sceneInput('scene', 'Scene'), scalar('angle', 'Angle', 0)], outputs: [sceneOutput], defaultValues: { scene: [1e6, 0.7, 0.7, 0.7], angle: 0 },
    inferTypes: fixedOutputs({ scene: 'sdf3' }), lower: ({ inputs, ir }) => ({ scene: ir.sdfScene({ kind: 'rotate-y', child: asScene(inputs.scene, 'Rotate Y').scene, angle: inputs.angle }) }),
  },
  ...(['union', 'intersection', 'difference'] as const).map((operator): NodeDefinition => ({
    type: `sdf3.${operator}`, version: 1, title: operator[0].toUpperCase() + operator.slice(1), category: 'SDF 3D', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'pure',
    inputs: [sceneInput('a', 'A'), sceneInput('b', 'B')], outputs: [sceneOutput], defaultValues: { a: [1e6, 0.7, 0.7, 0.7], b: [1e6, 0.7, 0.7, 0.7] },
    inferTypes: fixedOutputs({ scene: 'sdf3' }), lower: ({ inputs, ir }) => ({ scene: ir.sdfScene({ kind: 'csg', operator, a: asScene(inputs.a, operator).scene, b: asScene(inputs.b, operator).scene }) }),
  })),
  {
    type: 'sdf3.smooth_union', version: 1, title: 'Smooth Union', category: 'SDF 3D', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'pure',
    inputs: [sceneInput('a', 'A'), sceneInput('b', 'B'), scalar('smoothness', 'Smoothness', 0.2)], outputs: [sceneOutput], defaultValues: { a: [1e6, 0.7, 0.7, 0.7], b: [1e6, 0.7, 0.7, 0.7], smoothness: 0.2 },
    inferTypes: fixedOutputs({ scene: 'sdf3' }), lower: ({ inputs, ir }) => ({ scene: ir.sdfScene({ kind: 'smooth-union', a: asScene(inputs.a, 'Smooth Union').scene, b: asScene(inputs.b, 'Smooth Union').scene, smoothness: inputs.smoothness }) }),
  },
  {
    type: 'sdf3.material', version: 1, title: 'Material', category: 'SDF 3D', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'pure',
    inputs: [sceneInput('scene', 'Scene'), { id: 'color', title: 'Albedo', type: 'color3', defaultType: 'color3', defaultValue: [0.35, 0.65, 1] }], outputs: [sceneOutput], defaultValues: { scene: [1e6, 0.7, 0.7, 0.7], color: [0.35, 0.65, 1] },
    inferTypes: fixedOutputs({ scene: 'sdf3' }), lower: ({ inputs, ir }) => ({ scene: ir.sdfScene({ kind: 'material', child: asScene(inputs.scene, 'Material').scene, color: inputs.color }) }),
  },
  {
    type: 'output.raymarch', version: 1, title: 'Raymarch Output', category: 'Output', hostTargets: VISUAL_HOST_TARGETS, groupKind: 'output', output: true, outputTarget: 'visual',
    inputs: [
      sceneInput('scene', 'Scene'), vector3('camera', 'Camera', [0, 0, 4]), vector3('target', 'Target', [0, 0, 0]),
      { id: 'background', title: 'Background', type: 'color3', defaultType: 'color3', defaultValue: [0.02, 0.025, 0.04] },
      vector3('lightDirection', 'Light Direction', [0.5, 0.8, 0.3]), scalar('maxDistance', 'Max Distance', 30),
      { id: 'steps', title: 'Steps', type: 'int', defaultType: 'int', defaultValue: 96 },
    ],
    outputs: [], defaultValues: { scene: [1e6, 0.7, 0.7, 0.7], camera: [0, 0, 4], target: [0, 0, 0], background: [0.02, 0.025, 0.04], lightDirection: [0.5, 0.8, 0.3], maxDistance: 30, steps: 96 },
    inferTypes: fixedOutputs({}),
    lower: ({ inputs, ir }) => ({ output: ir.raymarch(asScene(inputs.scene, 'Raymarch Output').scene, inputs.camera, inputs.target, inputs.background, inputs.lightDirection, inputs.maxDistance, inputs.steps) }),
  },
];
