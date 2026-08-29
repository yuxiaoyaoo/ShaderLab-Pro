import { glslType, graphTypeComponents, type GraphParameterValue, type GraphValueType } from '../model';
import { deterministicHash } from './hash';
import type { IrBinding, IrExpr, IrRaymarchExpr, SdfSceneNode, TypedIrModule } from './ir';
import type { GraphSourceMap, GraphSourceMapEntry } from './sourceMap';

export interface EmittedLine { text: string; nodeId?: string; socketId?: string; }
export interface GlslEmission { source: string; sourceHash: string; sourceMap: GraphSourceMap; }

function scalar(value: unknown, integer = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new Error(integer ? 'IR integer literal is invalid' : 'IR float literal is invalid');
  if (integer) return String(value);
  return Number.isInteger(value) ? `${value.toFixed(1)}` : String(value);
}

export function emitLiteral(value: GraphParameterValue, type: GraphValueType): string {
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new Error('IR boolean literal is invalid');
    return value ? 'true' : 'false';
  }
  if (type === 'int') return scalar(value, true);
  if (type === 'float') return scalar(value);
  const count = graphTypeComponents(type);
  if (!Array.isArray(value) || value.length !== count) throw new Error(`IR ${type} literal is invalid`);
  return `${glslType(type)}(${value.map((item) => scalar(item)).join(', ')})`;
}

export function canConvertType(from: GraphValueType, to: GraphValueType): boolean {
  if (from === to) return true;
  if ((from === 'color3' && to === 'vec3') || (from === 'vec3' && to === 'color3') || (from === 'color4' && to === 'vec4') || (from === 'vec4' && to === 'color4')) return true;
  return from === 'float' && ['vec2', 'vec3', 'vec4', 'color3', 'color4'].includes(to);
}

export function lowerUniformType(type: Exclude<GraphValueType, 'sdf3'>): Exclude<GraphValueType, 'color3' | 'color4' | 'sdf3'> {
  if (type === 'color3') return 'vec3';
  if (type === 'color4') return 'vec4';
  return type;
}

export function defaultWidget(type: Exclude<GraphValueType, 'sdf3'>): 'slider' | 'color' | 'number' {
  if (type === 'color3' || type === 'color4') return 'color';
  if (type === 'float') return 'slider';
  return 'number';
}

export function parameterDefault(value: GraphParameterValue): GraphParameterValue { return Array.isArray(value) ? value.slice() : value; }

const BUILTINS: Record<Extract<IrExpr, { kind: 'builtin' }>['name'], string> = {
  uv: '(fragCoord / iResolution.xy)',
  aspectUv: '((fragCoord - 0.5 * iResolution.xy) / iResolution.y)',
  time: 'iTime',
  resolution: 'iResolution.xy',
  fragCoord: 'fragCoord',
  frame: 'iFrame',
  mouse: 'iMouse',
  sampleTime: 'time',
  sampleIndex: 'float(samp)',
  sampleRate: 'iSampleRate',
};

type ReferenceResolver = (id: string) => IrExpr | undefined;

export function emitIrExpression(expression: IrExpr, resolveReference?: ReferenceResolver, resolving = new Set<string>()): string {
  switch (expression.kind) {
    case 'literal': return emitLiteral(expression.value, expression.type);
    case 'builtin': return BUILTINS[expression.name];
    case 'uniform':
      if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(expression.name)) throw new Error('IR uniform name is invalid');
      return expression.name;
    case 'reference': {
      if (!resolveReference) return expression.bindingId;
      if (resolving.has(expression.bindingId)) throw new Error(`IR reference cycle: ${expression.bindingId}`);
      const target = resolveReference(expression.bindingId);
      if (!target) throw new Error(`IR reference missing: ${expression.bindingId}`);
      const next = new Set(resolving); next.add(expression.bindingId);
      return emitIrExpression(target, resolveReference, next);
    }
    case 'unary': return `(${expression.operator}${emitIrExpression(expression.value, resolveReference, resolving)})`;
    case 'binary': return `(${emitIrExpression(expression.left, resolveReference, resolving)} ${expression.operator} ${emitIrExpression(expression.right, resolveReference, resolving)})`;
    case 'call':
      if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(expression.callee)) throw new Error('IR callee is invalid');
      return `${expression.callee}(${expression.args.map((arg) => emitIrExpression(arg, resolveReference, resolving)).join(', ')})`;
    case 'construct': return `${glslType(expression.type)}(${expression.args.map((arg) => emitIrExpression(arg, resolveReference, resolving)).join(', ')})`;
    case 'convert': {
      const value = emitIrExpression(expression.value, resolveReference, resolving);
      if (!canConvertType(expression.from, expression.type)) throw new Error(`Unsupported IR conversion ${expression.from} -> ${expression.type}`);
      if (glslType(expression.from) === glslType(expression.type)) return value;
      return `${glslType(expression.type)}(${value})`;
    }
    case 'swizzle':
      if (!/^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(expression.mask)) throw new Error('IR swizzle mask is invalid');
      return `(${emitIrExpression(expression.value, resolveReference, resolving)}).${expression.mask}`;
    case 'trusted-intrinsic': {
      const args = expression.args.map((arg) => emitIrExpression(arg, resolveReference, resolving));
      return expression.template.replace(/\{(\d+)\}/g, (_match, rawIndex: string) => {
        const value = args[Number(rawIndex)];
        if (value === undefined) throw new Error(`IR intrinsic argument ${rawIndex} is missing`);
        return value;
      });
    }
    case 'sdf-scene': throw new Error('SDF Scene may only be consumed by Raymarch Output');
    case 'raymarch': throw new Error('Raymarch expression must be emitted as a visual output');
  }
}

function uniformDeclaration(name: string, type: GraphValueType): string { return `uniform ${glslType(type)} ${name};`; }

const RAYMARCH_HELPERS = `vec4 _sg_sdfUnion(vec4 a, vec4 b) { return a.x < b.x ? a : b; }
vec4 _sg_sdfIntersection(vec4 a, vec4 b) { return a.x > b.x ? a : b; }
vec4 _sg_sdfDifference(vec4 a, vec4 b) { a.x = max(a.x, -b.x); return a; }
vec4 _sg_sdfSmoothUnion(vec4 a, vec4 b, float k) {
    k = max(abs(k), 0.0001);
    float h = clamp(0.5 + 0.5 * (b.x - a.x) / k, 0.0, 1.0);
    return vec4(mix(b.x, a.x, h) - k * h * (1.0 - h), mix(b.yzw, a.yzw, h));
}
vec4 _sg_sdfMaterial(vec4 sampleValue, vec3 color) { sampleValue.yzw = color; return sampleValue; }
vec4 _sg_sdfScale(vec4 sampleValue, float scaleValue) { sampleValue.x *= abs(scaleValue); return sampleValue; }
vec3 _sg_rotateY(vec3 p, float angle) {
    float c = cos(angle), s = sin(angle);
    return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}`;

function emitScene(scene: SdfSceneNode, point: string, expression: (value: IrExpr) => string): string {
  switch (scene.kind) {
    case 'sphere': return `vec4(length(${point}) - (${expression(scene.radius)}), vec3(0.7))`;
    case 'box': {
      const size = expression(scene.halfSize); const roundness = expression(scene.roundness);
      const q = `(abs(${point}) - (${size}) + vec3(${roundness}))`;
      return `vec4(length(max(${q}, vec3(0.0))) + min(max(${q}.x, max(${q}.y, ${q}.z)), 0.0) - (${roundness}), vec3(0.7))`;
    }
    case 'torus': {
      const radii = expression(scene.radii);
      return `vec4(length(vec2(length((${point}).xz) - (${radii}).x, (${point}).y)) - (${radii}).y, vec3(0.7))`;
    }
    case 'translate': return emitScene(scene.child, `((${point}) - (${expression(scene.offset)}))`, expression);
    case 'scale': {
      const scale = `max(abs(${expression(scene.scale)}), 0.0001)`;
      return `_sg_sdfScale(${emitScene(scene.child, `((${point}) / (${scale}))`, expression)}, ${scale})`;
    }
    case 'rotate-y': return emitScene(scene.child, `_sg_rotateY(${point}, -(${expression(scene.angle)}))`, expression);
    case 'csg': {
      const helper = scene.operator === 'union' ? '_sg_sdfUnion' : scene.operator === 'intersection' ? '_sg_sdfIntersection' : '_sg_sdfDifference';
      return `${helper}(${emitScene(scene.a, point, expression)}, ${emitScene(scene.b, point, expression)})`;
    }
    case 'smooth-union': return `_sg_sdfSmoothUnion(${emitScene(scene.a, point, expression)}, ${emitScene(scene.b, point, expression)}, ${expression(scene.smoothness)})`;
    case 'material': return `_sg_sdfMaterial(${emitScene(scene.child, point, expression)}, ${expression(scene.color)})`;
  }
}

function raymarchFunction(output: IrRaymarchExpr, expression: (value: IrExpr) => string): string {
  return `vec4 _sg_scene(vec3 p, vec2 fragCoord) {
    return ${emitScene(output.scene, 'p', expression)};
}
vec3 _sg_safeNormalize(vec3 value, vec3 fallbackValue) {
    float magnitude = length(value);
    return magnitude > 0.000001 ? value / magnitude : fallbackValue;
}
vec3 _sg_sceneNormal(vec3 p, vec2 fragCoord) {
    const vec2 e = vec2(0.001, 0.0);
    vec3 gradient = vec3(
        _sg_scene(p + e.xyy, fragCoord).x - _sg_scene(p - e.xyy, fragCoord).x,
        _sg_scene(p + e.yxy, fragCoord).x - _sg_scene(p - e.yxy, fragCoord).x,
        _sg_scene(p + e.yyx, fragCoord).x - _sg_scene(p - e.yyx, fragCoord).x);
    return _sg_safeNormalize(gradient, vec3(0.0, 1.0, 0.0));
}
vec4 _sg_raymarch(vec2 fragCoord, vec3 ro, vec3 target, vec3 background, vec3 lightDirection, float maxDistance, int requestedSteps) {
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / max(iResolution.y, 1.0);
    vec3 forward = _sg_safeNormalize(target - ro, vec3(0.0, 0.0, -1.0));
    vec3 right = _sg_safeNormalize(cross(forward, abs(forward.y) > 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0)), vec3(1.0, 0.0, 0.0));
    vec3 up = cross(right, forward);
    vec3 rd = _sg_safeNormalize(forward + uv.x * right + uv.y * up, forward);
    float limit = max(maxDistance, 0.001);
    float travel = 0.0;
    vec4 hit = vec4(limit, background);
    bool found = false;
    int steps = clamp(requestedSteps, 1, 128);
    for (int i = 0; i < 128; ++i) {
        if (i >= steps || travel > limit) break;
        vec3 p = ro + rd * travel;
        hit = _sg_scene(p, fragCoord);
        if (abs(hit.x) < 0.0008) { found = true; break; }
        travel += max(abs(hit.x) * 0.8, 0.0004);
    }
    if (!found) return vec4(background, 1.0);
    vec3 p = ro + rd * travel;
    vec3 normal = _sg_sceneNormal(p, fragCoord);
    vec3 light = _sg_safeNormalize(lightDirection, vec3(0.0, 1.0, 0.0));
    float diffuse = max(dot(normal, light), 0.0);
    float fresnel = pow(1.0 - max(dot(normal, -rd), 0.0), 3.0);
    vec3 color = hit.yzw * (0.14 + 0.86 * diffuse) + 0.18 * fresnel;
    return vec4(color, 1.0);
}`;
}

function pushSource(lines: EmittedLine[], source: string, nodeId: string, socketId?: string): void {
  for (const text of source.split('\n')) lines.push({ text, nodeId, ...(socketId ? { socketId } : {}) });
  lines.push({ text: '' });
}

export function emitTypedIr(module: TypedIrModule): GlslEmission {
  const lines: EmittedLine[] = [];
  for (const uniform of module.uniforms) lines.push({ text: uniformDeclaration(uniform.emittedName, uniform.type), nodeId: uniform.nodeId });
  if (module.uniforms.length > 0) lines.push({ text: '' });
  for (const helper of [...module.helpers].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) pushSource(lines, helper.source, helper.origin.nodeId, helper.origin.socketId);

  const bindingMap = new Map(module.bindings.map((binding) => [binding.id, binding]));
  const resolve = (id: string) => bindingMap.get(id)?.expression;
  const resolvedExpression = (value: IrExpr) => emitIrExpression(value, resolve);

  if (module.target === 'visual') {
    if (module.output.kind === 'raymarch') {
      pushSource(lines, RAYMARCH_HELPERS, module.outputNodeId);
      pushSource(lines, raymarchFunction(module.output, resolvedExpression), module.outputNodeId, 'scene');
    }
    lines.push({ text: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) {', nodeId: module.outputNodeId });
    for (const binding of module.bindings) {
      lines.push({ text: `    ${glslType(binding.type)} ${binding.id} = ${emitIrExpression(binding.expression)};`, nodeId: binding.origin.nodeId, socketId: binding.origin.socketId });
    }
    const output = module.output.kind === 'raymarch'
      ? `_sg_raymarch(fragCoord, ${resolvedExpression(module.output.camera)}, ${resolvedExpression(module.output.target)}, ${resolvedExpression(module.output.background)}, ${resolvedExpression(module.output.lightDirection)}, ${resolvedExpression(module.output.maxDistance)}, int(${resolvedExpression(module.output.steps)}))`
      : emitIrExpression(module.output);
    lines.push({ text: `    fragColor = ${output};`, nodeId: module.outputNodeId, socketId: module.output.kind === 'raymarch' ? 'scene' : 'color' });
    lines.push({ text: '}', nodeId: module.outputNodeId });
  } else {
    if (module.output.type !== 'vec2') throw new Error(`Sound Graph output must be vec2, received ${module.output.type}`);
    lines.push({ text: 'vec2 mainSound(int samp, float time) {', nodeId: module.outputNodeId });
    for (const binding of module.bindings) lines.push({ text: `    ${glslType(binding.type)} ${binding.id} = ${emitIrExpression(binding.expression)};`, nodeId: binding.origin.nodeId, socketId: binding.origin.socketId });
    lines.push({ text: `    return ${emitIrExpression(module.output)};`, nodeId: module.outputNodeId, socketId: 'sample' });
    lines.push({ text: '}', nodeId: module.outputNodeId });
  }

  const source = `${lines.map((line) => line.text).join('\n')}\n`;
  const sourceHash = deterministicHash(source);
  const entries: GraphSourceMapEntry[] = [];
  lines.forEach((line, index) => {
    if (line.nodeId) entries.push({ startLine: index + 1, endLine: index + 1, nodeId: line.nodeId, ...(line.socketId ? { socketId: line.socketId } : {}) });
  });
  return { source, sourceHash, sourceMap: { version: 1, pass: module.pass, revision: module.revision, semanticHash: module.semanticHash, sourceHash, entries } };
}
