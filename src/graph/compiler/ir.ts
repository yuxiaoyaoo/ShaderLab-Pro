import type { GraphParameterValue, GraphPassId, GraphValueType } from '../model';
import type { GeneratedUniform } from './types';

export interface IrOrigin {
  nodeId: string;
  socketId?: string;
}

interface IrExprBase {
  type: GraphValueType;
  origin: IrOrigin;
}

export interface IrLiteralExpr extends IrExprBase { kind: 'literal'; value: GraphParameterValue; }
export type IrBuiltinName = 'uv' | 'aspectUv' | 'time' | 'resolution' | 'fragCoord' | 'frame' | 'mouse' | 'sampleTime' | 'sampleIndex' | 'sampleRate';
export interface IrBuiltinExpr extends IrExprBase { kind: 'builtin'; name: IrBuiltinName; }
export interface IrUniformExpr extends IrExprBase { kind: 'uniform'; name: string; }
export interface IrReferenceExpr extends IrExprBase { kind: 'reference'; bindingId: string; }
export interface IrUnaryExpr extends IrExprBase { kind: 'unary'; operator: '-' | '!'; value: IrExpr; }
export interface IrBinaryExpr extends IrExprBase { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: IrExpr; right: IrExpr; }
export interface IrCallExpr extends IrExprBase { kind: 'call'; callee: string; args: IrExpr[]; }
export interface IrConstructExpr extends IrExprBase { kind: 'construct'; args: IrExpr[]; }
export interface IrConvertExpr extends IrExprBase { kind: 'convert'; value: IrExpr; from: GraphValueType; }
export interface IrSwizzleExpr extends IrExprBase { kind: 'swizzle'; value: IrExpr; mask: string; }
/** A reviewed intrinsic template. Arguments are inserted through {0}, {1}, ... placeholders. */
export interface IrTrustedIntrinsicExpr extends IrExprBase { kind: 'trusted-intrinsic'; template: string; args: IrExpr[]; }

export type SdfSceneNode =
  | { kind: 'sphere'; radius: IrExpr }
  | { kind: 'box'; halfSize: IrExpr; roundness: IrExpr }
  | { kind: 'torus'; radii: IrExpr }
  | { kind: 'translate'; child: SdfSceneNode; offset: IrExpr }
  | { kind: 'scale'; child: SdfSceneNode; scale: IrExpr }
  | { kind: 'rotate-y'; child: SdfSceneNode; angle: IrExpr }
  | { kind: 'csg'; operator: 'union' | 'intersection' | 'difference'; a: SdfSceneNode; b: SdfSceneNode }
  | { kind: 'smooth-union'; a: SdfSceneNode; b: SdfSceneNode; smoothness: IrExpr }
  | { kind: 'material'; child: SdfSceneNode; color: IrExpr };

export interface IrSdfSceneExpr extends IrExprBase { kind: 'sdf-scene'; type: 'sdf3'; scene: SdfSceneNode; }
export interface IrRaymarchExpr extends IrExprBase {
  kind: 'raymarch';
  type: 'color4';
  scene: SdfSceneNode;
  camera: IrExpr;
  target: IrExpr;
  background: IrExpr;
  lightDirection: IrExpr;
  maxDistance: IrExpr;
  steps: IrExpr;
}

export type IrExpr =
  | IrLiteralExpr | IrBuiltinExpr | IrUniformExpr | IrReferenceExpr | IrUnaryExpr | IrBinaryExpr
  | IrCallExpr | IrConstructExpr | IrConvertExpr | IrSwizzleExpr | IrTrustedIntrinsicExpr
  | IrSdfSceneExpr | IrRaymarchExpr;

export interface IrBinding { id: string; type: GraphValueType; expression: IrExpr; origin: IrOrigin; }
export interface IrTrustedHelper { key: string; source: string; origin: IrOrigin; }

export interface TypedIrModule {
  version: 1;
  pass: GraphPassId;
  target: 'visual' | 'sound';
  revision: string;
  semanticHash: string;
  uniforms: GeneratedUniform[];
  helpers: IrTrustedHelper[];
  bindings: IrBinding[];
  output: IrExpr;
  outputNodeId: string;
}

export interface NodeIrBuilder {
  literal(value: GraphParameterValue, type: GraphValueType): IrLiteralExpr;
  builtin(name: IrBuiltinName, type: GraphValueType): IrBuiltinExpr;
  uniform(name: string, type: GraphValueType): IrUniformExpr;
  unary(operator: IrUnaryExpr['operator'], value: IrExpr, type?: GraphValueType): IrUnaryExpr;
  binary(operator: IrBinaryExpr['operator'], left: IrExpr, right: IrExpr, type: GraphValueType): IrBinaryExpr;
  call(callee: string, args: IrExpr[], type: GraphValueType): IrCallExpr;
  construct(type: GraphValueType, args: IrExpr[]): IrConstructExpr;
  convert(value: IrExpr, type: GraphValueType): IrConvertExpr;
  swizzle(value: IrExpr, mask: string, type: GraphValueType): IrSwizzleExpr;
  intrinsic(template: string, args: IrExpr[], type: GraphValueType): IrTrustedIntrinsicExpr;
  sdfScene(scene: SdfSceneNode): IrSdfSceneExpr;
  raymarch(scene: SdfSceneNode, camera: IrExpr, target: IrExpr, background: IrExpr, lightDirection: IrExpr, maxDistance: IrExpr, steps: IrExpr): IrRaymarchExpr;
}

export function createNodeIrBuilder(origin: IrOrigin): NodeIrBuilder {
  const base = <T extends Omit<IrExprBase, 'origin'>>(value: T): T & { origin: IrOrigin } => ({ ...value, origin });
  return {
    literal: (value, type) => base({ kind: 'literal' as const, value, type }),
    builtin: (name, type) => base({ kind: 'builtin' as const, name, type }),
    uniform: (name, type) => base({ kind: 'uniform' as const, name, type }),
    unary: (operator, value, type = value.type) => base({ kind: 'unary' as const, operator, value, type }),
    binary: (operator, left, right, type) => base({ kind: 'binary' as const, operator, left, right, type }),
    call: (callee, args, type) => base({ kind: 'call' as const, callee, args, type }),
    construct: (type, args) => base({ kind: 'construct' as const, args, type }),
    convert: (value, type) => base({ kind: 'convert' as const, value, from: value.type, type }),
    swizzle: (value, mask, type) => base({ kind: 'swizzle' as const, value, mask, type }),
    intrinsic: (template, args, type) => base({ kind: 'trusted-intrinsic' as const, template, args, type }),
    sdfScene: (scene) => base({ kind: 'sdf-scene' as const, scene, type: 'sdf3' as const }),
    raymarch: (scene, camera, target, background, lightDirection, maxDistance, steps) => base({ kind: 'raymarch' as const, scene, camera, target, background, lightDirection, maxDistance, steps, type: 'color4' as const }),
  };
}
