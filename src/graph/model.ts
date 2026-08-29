export const GRAPH_FORMAT = 'shaderlab-graph' as const;
export const CURRENT_GRAPH_VERSION = 1 as const;

export type GraphPassId = 'image' | 'bufferA' | 'bufferB' | 'bufferC' | 'bufferD' | 'sound';
export type VisualGraphPassId = Exclude<GraphPassId, 'sound'>;
export type GraphValueType =
  | 'bool'
  | 'int'
  | 'float'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'color3'
  | 'color4'
  /** Structured scene value. It lowers to vec4(distance, albedo.rgb), but cannot be authored as a Custom Function parameter. */
  | 'sdf3';

export const GRAPH_VALUE_TYPES: readonly GraphValueType[] = [
  'bool',
  'int',
  'float',
  'vec2',
  'vec3',
  'vec4',
  'color3',
  'color4',
  'sdf3',
];

export const GRAPH_PARAMETER_VALUE_TYPES: readonly Exclude<GraphValueType, 'sdf3'>[] = [
  'bool', 'int', 'float', 'vec2', 'vec3', 'vec4', 'color3', 'color4',
];

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  type: string;
  typeVersion: number;
  position: GraphPoint;
  values: Record<string, unknown>;
}

export interface GraphSocketRef {
  nodeId: string;
  socketId: string;
}

export interface GraphEdge {
  id: string;
  from: GraphSocketRef;
  to: GraphSocketRef;
}

export type GraphParameterWidget = 'slider' | 'color' | 'number';

export interface GraphParameterUi {
  widget: GraphParameterWidget;
  min?: number;
  max?: number;
  step?: number;
}

export type GraphParameterValue = number | boolean | number[];

export interface GraphParameter {
  id: string;
  name: string;
  valueType: Exclude<GraphValueType, 'sdf3'>;
  defaultValue: GraphParameterValue;
  ui?: GraphParameterUi;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphDocument {
  format: typeof GRAPH_FORMAT;
  version: typeof CURRENT_GRAPH_VERSION;
  pass: GraphPassId;
  nodes: GraphNode[];
  edges: GraphEdge[];
  parameters: GraphParameter[];
  ui: {
    viewport: GraphViewport;
  };
}

export function createEmptyGraph(pass: GraphPassId = 'image'): GraphDocument {
  return {
    format: GRAPH_FORMAT,
    version: CURRENT_GRAPH_VERSION,
    pass,
    nodes: [],
    edges: [],
    parameters: [],
    ui: { viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

export function isGraphValueType(value: unknown): value is GraphValueType {
  return typeof value === 'string' && (GRAPH_VALUE_TYPES as readonly string[]).includes(value);
}

export function isGraphParameterValueType(value: unknown): value is GraphParameter['valueType'] {
  return typeof value === 'string' && (GRAPH_PARAMETER_VALUE_TYPES as readonly string[]).includes(value);
}

export function graphTypeComponents(type: GraphValueType): number {
  switch (type) {
    case 'vec2': return 2;
    case 'vec3':
    case 'color3': return 3;
    case 'vec4':
    case 'color4':
    case 'sdf3': return 4;
    default: return 1;
  }
}

export function glslType(type: GraphValueType): 'bool' | 'int' | 'float' | 'vec2' | 'vec3' | 'vec4' {
  if (type === 'color3') return 'vec3';
  if (type === 'color4' || type === 'sdf3') return 'vec4';
  return type;
}
