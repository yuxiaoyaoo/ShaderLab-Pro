import { compileGraph } from '../compiler/index';
import { createEmptyGraph, type GraphDocument, type GraphEdge, type GraphNode } from '../model';

const node = (id: string, type: string, x: number, y: number, values: Record<string, unknown> = {}): GraphNode => ({ id, type, typeVersion: 1, position: { x, y }, values });
const edge = (id: string, fromNode: string, fromSocket: string, toNode: string, toSocket: string): GraphEdge => ({ id, from: { nodeId: fromNode, socketId: fromSocket }, to: { nodeId: toNode, socketId: toSocket } });

/** A useful starter graph for visual passes: animated UV gradient with a stable Fragment Output. */
export function createDefaultGraph(pass: GraphDocument['pass'] = 'image'): GraphDocument {
  if (pass === 'sound') return createDefaultSoundGraph();
  return {
    ...createEmptyGraph(pass),
    nodes: [
      node('starter-uv', 'input.uv', -500, -80), node('starter-split', 'vector.split2', -300, -80),
      node('starter-time', 'input.time', -500, 170), node('starter-wave', 'math.sin', -300, 170),
      node('starter-add', 'math.add', -70, -30), node('starter-color', 'vector.combine4', 180, -40, { z: 0.35, w: 1 }),
      node('starter-output', 'output.fragment', 430, -30),
    ],
    edges: [
      edge('starter-e-uv', 'starter-uv', 'out', 'starter-split', 'value'), edge('starter-e-time', 'starter-time', 'out', 'starter-wave', 'value'),
      edge('starter-e-x', 'starter-split', 'x', 'starter-add', 'a'), edge('starter-e-wave', 'starter-wave', 'out', 'starter-add', 'b'),
      edge('starter-e-r', 'starter-add', 'out', 'starter-color', 'x'), edge('starter-e-g', 'starter-split', 'y', 'starter-color', 'y'),
      edge('starter-e-out', 'starter-color', 'out', 'starter-output', 'color'),
    ],
    ui: { viewport: { x: 520, y: 260, zoom: 0.85 } },
  };
}

export function createDefaultSoundGraph(): GraphDocument {
  return {
    ...createEmptyGraph('sound'),
    nodes: [
      node('sound-time', 'input.sample_time', -520, 0), node('sound-frequency', 'value.float', -520, 160, { value: 220 }),
      node('sound-multiply', 'math.multiply', -280, 20), node('sound-sine', 'math.sin', -60, 20),
      node('sound-gain', 'math.multiply', 140, 20, { b: 0.25 }), node('sound-stereo', 'vector.combine2', 350, 20),
      node('sound-output', 'output.sound', 570, 20),
    ],
    edges: [
      edge('sound-e-time', 'sound-time', 'out', 'sound-multiply', 'a'), edge('sound-e-frequency', 'sound-frequency', 'out', 'sound-multiply', 'b'),
      edge('sound-e-wave', 'sound-multiply', 'out', 'sound-sine', 'value'), edge('sound-e-gain', 'sound-sine', 'out', 'sound-gain', 'a'),
      edge('sound-e-left', 'sound-gain', 'out', 'sound-stereo', 'x'), edge('sound-e-right', 'sound-gain', 'out', 'sound-stereo', 'y'),
      edge('sound-e-output', 'sound-stereo', 'out', 'sound-output', 'sample'),
    ],
    ui: { viewport: { x: 580, y: 300, zoom: 0.85 } },
  };
}

export function createDefaultRaymarchGraph(pass: Exclude<GraphDocument['pass'], 'sound'> = 'image'): GraphDocument {
  return {
    ...createEmptyGraph(pass),
    nodes: [
      node('ray-sphere', 'sdf3.sphere', -520, -80, { radius: 0.8 }),
      node('ray-material', 'sdf3.material', -250, -80, { scene: [1e6, 0.7, 0.7, 0.7], color: [0.2, 0.55, 1] }),
      node('ray-output', 'output.raymarch', 80, -80, { scene: [1e6, 0.7, 0.7, 0.7], camera: [0, 0, 4], target: [0, 0, 0], background: [0.015, 0.02, 0.04], lightDirection: [0.5, 0.8, 0.3], maxDistance: 30, steps: 96 }),
    ],
    edges: [edge('ray-e-scene', 'ray-sphere', 'scene', 'ray-material', 'scene'), edge('ray-e-output', 'ray-material', 'scene', 'ray-output', 'scene')],
    ui: { viewport: { x: 580, y: 330, zoom: 0.9 } },
  };
}

export const createDefaultImageGraph = (): GraphDocument => createDefaultGraph('image');

/** Throws during development/tests if the shipped starter graph ever drifts out of registry compatibility. */
export function assertDefaultImageGraph(): GraphDocument {
  const document = createDefaultImageGraph();
  const result = compileGraph(document);
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join('\n'));
  return document;
}
