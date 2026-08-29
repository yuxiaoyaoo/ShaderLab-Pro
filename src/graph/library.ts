import { ProductError } from '../productMessage';
import { deterministicHash, stableStringify } from './compiler/hash';
import type { IrExpr, NodeIrBuilder } from './compiler/ir';
import { graphTypeComponents, glslType, isGraphValueType, type GraphEdge, type GraphNode, type GraphParameterValue, type GraphSocketRef, type GraphValueType } from './model';
import {
  BOTH_GRAPH_HOST_TARGETS,
  createDefaultRegistry,
  graphValueField,
  isNodeAllowedInPureGroup,
  validateNodeValues,
  type NodeDefinition,
  type NodeLowerContext,
  type NodeRegistry,
  type SocketDefinition,
} from './registry';

export const GRAPH_LIBRARY_FORMAT = 'shaderlab-graph-library' as const;
export const GRAPH_LIBRARY_VERSION = 2 as const;

export interface LibrarySocket {
  id: string;
  title: string;
  type: GraphValueType;
  defaultValue: GraphParameterValue;
}

export type GroupExpression =
  | { kind: 'input'; input: string; type: GraphValueType }
  | { kind: 'literal'; value: GraphParameterValue; type: GraphValueType }
  | { kind: 'unary'; operator: '-' | '!'; value: GroupExpression; type: GraphValueType }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: GroupExpression; right: GroupExpression; type: GraphValueType }
  | { kind: 'call'; callee: string; args: GroupExpression[]; type: GraphValueType }
  | { kind: 'construct'; args: GroupExpression[]; type: GraphValueType }
  | { kind: 'swizzle'; value: GroupExpression; mask: string; type: GraphValueType }
  | { kind: 'group'; groupId: string; version: number; output: string; args: Record<string, GroupExpression>; type: GraphValueType };

export interface NodeGroupGraphDocument {
  nodes: GraphNode[];
  edges: GraphEdge[];
  inputBindings: { inputId: string; to: GraphSocketRef }[];
  outputBindings: { outputId: string; from: GraphSocketRef }[];
}

interface NodeGroupBase {
  id: string;
  version: number;
  title: string;
  inputs: LibrarySocket[];
}

export interface ExpressionNodeGroupDefinition extends NodeGroupBase {
  kind: 'expression';
  outputs: { id: string; title: string; type: GraphValueType; expression: GroupExpression }[];
}

export interface GraphNodeGroupDefinition extends NodeGroupBase {
  kind: 'graph';
  outputs: { id: string; title: string; type: GraphValueType }[];
  graph: NodeGroupGraphDocument;
}

export type NodeGroupDefinition = ExpressionNodeGroupDefinition | GraphNodeGroupDefinition;

export interface CustomFunctionDefinition {
  id: string;
  version: number;
  title: string;
  inputs: LibrarySocket[];
  output: { id: string; title: string; type: GraphValueType };
  /** Restricted single GLSL expression, never a declaration or statement block. */
  expression: string;
}

export interface GraphLibraryDocument {
  format: typeof GRAPH_LIBRARY_FORMAT;
  version: typeof GRAPH_LIBRARY_VERSION;
  groups: NodeGroupDefinition[];
  functions: CustomFunctionDefinition[];
}

const ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const GLSL_RESERVED = new Set([
  'attribute', 'break', 'buffer', 'case', 'const', 'continue', 'default', 'discard', 'do', 'else', 'for',
  'highp', 'if', 'in', 'inout', 'layout', 'lowp', 'mediump', 'out', 'precision', 'return', 'struct',
  'switch', 'uniform', 'varying', 'void', 'while', 'bool', 'int', 'float', 'vec2', 'vec3', 'vec4',
  'mat2', 'mat3', 'mat4', 'sampler2D', 'true', 'false',
]);
const GLSL_CALLS = new Set([
  'abs', 'acos', 'asin', 'atan', 'ceil', 'clamp', 'cos', 'cross', 'distance', 'dot', 'exp', 'floor', 'fract',
  'length', 'log', 'max', 'min', 'mix', 'mod', 'normalize', 'pow', 'reflect', 'refract', 'sign', 'sin', 'smoothstep',
  'sqrt', 'step', 'tan', 'vec2', 'vec3', 'vec4', 'float', 'int', 'bool',
]);

export function createGraphLibrary(): GraphLibraryDocument {
  return { format: GRAPH_LIBRARY_FORMAT, version: GRAPH_LIBRARY_VERSION, groups: [], functions: [] };
}

/** Canonical semantic identity shared by compilation and project persistence. UI positions are intentionally excluded. */
export function computeGraphLibraryRevision(library: GraphLibraryDocument): string {
  const semantic = {
    ...library,
    groups: library.groups.map((group) => group.kind === 'graph'
      ? {
        ...group,
        graph: {
          ...group.graph,
          nodes: group.graph.nodes.map(({ position: _position, ...node }) => node).sort((a, b) => a.id.localeCompare(b.id)),
          edges: group.graph.edges.map(({ id: _id, ...edge }) => edge).sort((a, b) => graphSocketKey(a.from).localeCompare(graphSocketKey(b.from)) || graphSocketKey(a.to).localeCompare(graphSocketKey(b.to))),
          inputBindings: [...group.graph.inputBindings].sort((a, b) => a.inputId.localeCompare(b.inputId)),
          outputBindings: [...group.graph.outputBindings].sort((a, b) => a.outputId.localeCompare(b.outputId)),
        },
      }
      : group),
  };
  return deterministicHash(stableStringify(semantic));
}

export const EMPTY_GRAPH_LIBRARY_REVISION = computeGraphLibraryRevision(createGraphLibrary());

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeValue(type: GraphValueType, value: unknown): GraphParameterValue {
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new Error('默认值必须是 bool');
    return value;
  }
  if (type === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('默认值必须是 int');
    return value;
  }
  if (type === 'float') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('默认值必须是 float');
    return value;
  }
  const count = graphTypeComponents(type);
  if (!Array.isArray(value) || value.length !== count || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) throw new Error(`默认值必须是 ${count} 分量数组`);
  return value.slice() as number[];
}

function normalizeSocket(value: unknown, path: string): LibrarySocket {
  const socket = record(value);
  if (!socket || typeof socket.id !== 'string' || !ID.test(socket.id) || GLSL_RESERVED.has(socket.id) || socket.id.startsWith('gl_') || socket.id.includes('__') || typeof socket.title !== 'string' || !isGraphValueType(socket.type)) throw new Error(`${path} socket 无效`);
  if (socket.type === 'sdf3') throw new Error(`${path} 不能公开 sdf3 参数`);
  return { id: socket.id, title: socket.title.trim() || socket.id, type: socket.type, defaultValue: normalizeValue(socket.type, socket.defaultValue) };
}

function normalizeExpression(value: unknown, path: string, depth = 0): GroupExpression {
  if (depth > 64) throw new Error(`${path} 表达式嵌套过深`);
  const expression = record(value);
  if (!expression || typeof expression.kind !== 'string' || !isGraphValueType(expression.type)) throw new Error(`${path} 表达式无效`);
  const type = expression.type;
  switch (expression.kind) {
    case 'input':
      if (typeof expression.input !== 'string' || !ID.test(expression.input)) throw new Error(`${path}.input 无效`);
      return { kind: 'input', input: expression.input, type };
    case 'literal': return { kind: 'literal', value: normalizeValue(type, expression.value), type };
    case 'unary':
      if (expression.operator !== '-' && expression.operator !== '!') throw new Error(`${path}.operator 无效`);
      return { kind: 'unary', operator: expression.operator, value: normalizeExpression(expression.value, `${path}.value`, depth + 1), type };
    case 'binary':
      if (!['+', '-', '*', '/'].includes(String(expression.operator))) throw new Error(`${path}.operator 无效`);
      return { kind: 'binary', operator: expression.operator as '+' | '-' | '*' | '/', left: normalizeExpression(expression.left, `${path}.left`, depth + 1), right: normalizeExpression(expression.right, `${path}.right`, depth + 1), type };
    case 'call':
      if (typeof expression.callee !== 'string' || !GLSL_CALLS.has(expression.callee) || !Array.isArray(expression.args)) throw new Error(`${path}.call 无效`);
      return { kind: 'call', callee: expression.callee, args: expression.args.map((arg, index) => normalizeExpression(arg, `${path}.args[${index}]`, depth + 1)), type };
    case 'construct':
      if (!Array.isArray(expression.args)) throw new Error(`${path}.args 无效`);
      return { kind: 'construct', args: expression.args.map((arg, index) => normalizeExpression(arg, `${path}.args[${index}]`, depth + 1)), type };
    case 'swizzle':
      if (typeof expression.mask !== 'string' || !/^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(expression.mask)) throw new Error(`${path}.mask 无效`);
      return { kind: 'swizzle', value: normalizeExpression(expression.value, `${path}.value`, depth + 1), mask: expression.mask, type };
    case 'group': {
      if (typeof expression.groupId !== 'string' || !ID.test(expression.groupId) || !Number.isInteger(expression.version) || typeof expression.output !== 'string' || !ID.test(expression.output)) throw new Error(`${path}.group 引用无效`);
      const args = record(expression.args);
      if (!args) throw new Error(`${path}.args 无效`);
      return { kind: 'group', groupId: expression.groupId, version: expression.version as number, output: expression.output, args: Object.fromEntries(Object.entries(args).map(([key, arg]) => [key, normalizeExpression(arg, `${path}.args.${key}`, depth + 1)])), type };
    }
    default: throw new Error(`${path}.kind 不受支持`);
  }
}

function inferCustomCall(callee: string, args: GraphValueType[]): GraphValueType {
  const requireNumeric = (type: GraphValueType) => {
    if (!isNumericType(type)) throw new Error(`${callee} 只接受数值参数`);
    return type;
  };
  const same = (count: number) => {
    if (args.length !== count) throw new Error(`${callee} 需要 ${count} 个参数`);
    const first = requireNumeric(args[0]);
    if (args.slice(1).some((type) => !equivalentType(type, first))) throw new Error(`${callee} 参数类型不一致`);
    return first;
  };
  if (['float', 'int', 'vec2', 'vec3', 'vec4'].includes(callee)) {
    const target = callee as GraphValueType;
    if (!args.length || args.some((type) => !isNumericType(type))) throw new Error(`${callee} 构造参数无效`);
    const components = args.reduce((sum, type) => sum + graphTypeComponents(type), 0);
    const targetComponents = graphTypeComponents(target);
    if (targetComponents === 1 ? args.length !== 1 || graphTypeComponents(args[0]) !== 1 : !(args.length === 1 && graphTypeComponents(args[0]) === 1) && components !== targetComponents) throw new Error(`${callee} 构造分量数不匹配`);
    return target;
  }
  if (callee === 'bool') {
    if (args.length !== 1 || graphTypeComponents(args[0]) !== 1) throw new Error('bool 构造需要一个标量');
    return 'bool';
  }
  if (['length'].includes(callee)) {
    if (args.length !== 1 || graphTypeComponents(requireNumeric(args[0])) < 2) throw new Error(`${callee} 需要一个向量`);
    return 'float';
  }
  if (callee === 'dot' || callee === 'distance') {
    const value = same(2);
    if (graphTypeComponents(value) < 2) throw new Error(`${callee} 需要向量`);
    return 'float';
  }
  if (callee === 'cross') {
    const value = same(2);
    if (graphTypeComponents(value) !== 3) throw new Error('cross 需要两个 vec3');
    return value;
  }
  if (callee === 'reflect') return same(2);
  if (callee === 'refract') {
    if (args.length !== 3 || !equivalentType(args[0], args[1]) || args[2] !== 'float' || graphTypeComponents(args[0]) < 2) throw new Error('refract 签名无效');
    return args[0];
  }
  if (['min', 'max', 'mod', 'pow'].includes(callee)) {
    if (args.length !== 2 || !isNumericType(args[0]) || !(equivalentType(args[0], args[1]) || scalarType(args[1]))) throw new Error(`${callee} 签名无效`);
    return args[0];
  }
  if (callee === 'clamp') {
    if (args.length !== 3 || !isNumericType(args[0]) || args.slice(1).some((type) => !(equivalentType(type, args[0]) || scalarType(type)))) throw new Error('clamp 签名无效');
    return args[0];
  }
  if (callee === 'mix') {
    if (args.length !== 3 || !equivalentType(args[0], args[1]) || !(equivalentType(args[2], args[0]) || args[2] === 'float')) throw new Error('mix 签名无效');
    return args[0];
  }
  if (callee === 'step') {
    if (args.length !== 2 || !(equivalentType(args[0], args[1]) || scalarType(args[0]))) throw new Error('step 签名无效');
    return args[1];
  }
  if (callee === 'smoothstep') {
    if (args.length !== 3 || !(equivalentType(args[0], args[2]) || scalarType(args[0])) || !(equivalentType(args[1], args[2]) || scalarType(args[1]))) throw new Error('smoothstep 签名无效');
    return args[2];
  }
  if (callee === 'atan') return args.length === 1 ? requireNumeric(args[0]) : same(2);
  if (args.length !== 1) throw new Error(`${callee} 需要一个参数`);
  return requireNumeric(args[0]);
}

function inferCustomExpressionType(tokens: readonly string[], inputs: readonly LibrarySocket[]): GraphValueType {
  const inputTypes = new Map(inputs.map((input) => [input.id, input.type]));
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const expect = (token: string) => { if (take() !== token) throw new Error(`Custom Function 需要 ${token}`); };
  const arithmetic = (left: GraphValueType, right: GraphValueType, operator: string): GraphValueType => {
    if (!isNumericType(left) || !isNumericType(right)) throw new Error(`${operator} 只接受数值`);
    if (equivalentType(left, right)) return left;
    if (scalarType(left) && !scalarType(right)) return right;
    if (!scalarType(left) && scalarType(right)) return left;
    throw new Error(`${operator} 两侧类型不兼容：${left} / ${right}`);
  };
  let parseConditional: () => GraphValueType;
  const parsePrimary = (): GraphValueType => {
    const token = take();
    if (!token) throw new Error('Custom Function 表达式不完整');
    let type: GraphValueType;
    if (token === '(') {
      type = parseConditional();
      expect(')');
    } else if (/^(?:\d|\.)/.test(token)) type = /[.eE]/.test(token) ? 'float' : 'int';
    else if (token === 'true' || token === 'false') type = 'bool';
    else if (peek() === '(') {
      take();
      const args: GraphValueType[] = [];
      if (peek() !== ')') {
        do {
          args.push(parseConditional());
          if (peek() !== ',') break;
          take();
        } while (true);
      }
      expect(')');
      type = inferCustomCall(token, args);
    } else {
      const input = inputTypes.get(token);
      if (!input) throw new Error(`Custom Function 未知输入：${token}`);
      type = input;
    }
    while (peek() === '.') {
      take();
      const mask = take();
      if (!/^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(mask ?? '')) throw new Error('Custom Function swizzle 无效');
      const width = graphTypeComponents(type);
      const indexes = mask.split('').map((part) => ({ x: 0, r: 0, y: 1, g: 1, z: 2, b: 2, w: 3, a: 3 } as Record<string, number>)[part]);
      if (width < 2 || indexes.some((index) => index >= width)) throw new Error(`Custom Function swizzle 超出 ${type} 范围`);
      type = mask.length === 1 ? 'float' : `vec${mask.length}` as GraphValueType;
    }
    return type;
  };
  const parseUnary = (): GraphValueType => {
    if (peek() === '!' || peek() === '-' || peek() === '+') {
      const operator = take();
      const value = parseUnary();
      if (operator === '!') {
        if (value !== 'bool') throw new Error('! 只接受 bool');
        return 'bool';
      }
      if (!isNumericType(value)) throw new Error(`${operator} 只接受数值`);
      return value;
    }
    return parsePrimary();
  };
  const binary = (next: () => GraphValueType, operators: readonly string[], comparison = false, logical = false) => () => {
    let left = next();
    while (operators.includes(peek())) {
      const operator = take();
      const right = next();
      if (logical) {
        if (left !== 'bool' || right !== 'bool') throw new Error(`${operator} 只接受 bool`);
        left = 'bool';
      } else if (comparison) {
        if (!(equivalentType(left, right) && (operator === '==' || operator === '!=' || isNumericType(left)))) throw new Error(`${operator} 两侧类型不兼容`);
        left = 'bool';
      } else left = arithmetic(left, right, operator);
    }
    return left;
  };
  const parseMultiplicative = binary(parseUnary, ['*', '/']);
  const parseAdditive = binary(parseMultiplicative, ['+', '-']);
  const parseRelational = binary(parseAdditive, ['<', '<=', '>', '>='], true);
  const parseEquality = binary(parseRelational, ['==', '!='], true);
  const parseAnd = binary(parseEquality, ['&&'], false, true);
  const parseOr = binary(parseAnd, ['||'], false, true);
  parseConditional = () => {
    const condition = parseOr();
    if (peek() !== '?') return condition;
    take();
    if (condition !== 'bool') throw new Error('?: 条件必须是 bool');
    const whenTrue = parseConditional();
    expect(':');
    const whenFalse = parseConditional();
    if (!equivalentType(whenTrue, whenFalse)) throw new Error('?: 分支类型不一致');
    return whenTrue;
  };
  const result = parseConditional();
  if (cursor !== tokens.length) throw new Error(`Custom Function 存在多余 token：${peek()}`);
  return result;
}

function validateCustomExpression(expression: string, inputs: readonly LibrarySocket[], outputType: GraphValueType): void {
  if (!expression.trim() || expression.length > 4096) throw new Error('Custom Function expression 必须为 1–4096 字符');
  if (/[#;{}\\]|\/\*|\/\//.test(expression) || /\b(?:for|while|do|if|else|switch|return|discard|uniform|layout|precision|struct|void)\b/.test(expression)) throw new Error('Custom Function 仅允许单个纯表达式，禁止语句、声明、注释和预处理器');
  const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_]*|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?|==|!=|<=|>=|&&|\|\||[+\-*/(),.!<>?:]/g) ?? [];
  if (tokens.join('').replace(/\s/g, '') !== expression.replace(/\s/g, '')) throw new Error('Custom Function 包含不允许的 token');
  const inputIds = new Set(inputs.map((input) => input.id));
  let balance = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '(') balance++;
    if (token === ')' && --balance < 0) throw new Error('Custom Function 括号不匹配');
    if (!/^[A-Za-z_]/.test(token)) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const swizzle = previous === '.' && /^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(token);
    const constant = token === 'true' || token === 'false';
    if (!inputIds.has(token) && !GLSL_CALLS.has(token) && !swizzle && !constant) throw new Error(`Custom Function 标识符不在签名/白名单中：${token}`);
    if (GLSL_CALLS.has(token) && next !== '(') throw new Error(`GLSL 函数 ${token} 必须作为调用使用`);
  }
  if (balance !== 0) throw new Error('Custom Function 括号不匹配');
  const inferred = inferCustomExpressionType(tokens, inputs);
  if (!equivalentType(inferred, outputType)) throw new Error(`Custom Function 返回类型为 ${inferred}，签名要求 ${outputType}`);
}

function collectGroupRefs(expression: GroupExpression, output: Set<string>): void {
  if (expression.kind === 'group') {
    output.add(`${expression.groupId}@${expression.version}`);
    Object.values(expression.args).forEach((arg) => collectGroupRefs(arg, output));
  } else if (expression.kind === 'unary' || expression.kind === 'swizzle') collectGroupRefs(expression.value, output);
  else if (expression.kind === 'binary') { collectGroupRefs(expression.left, output); collectGroupRefs(expression.right, output); }
  else if (expression.kind === 'call' || expression.kind === 'construct') expression.args.forEach((arg) => collectGroupRefs(arg, output));
}

function canonicalType(type: GraphValueType): GraphValueType {
  return glslType(type) as GraphValueType;
}

function equivalentType(left: GraphValueType, right: GraphValueType): boolean {
  return canonicalType(left) === canonicalType(right);
}

function isNumericType(type: GraphValueType): boolean {
  return type !== 'bool' && type !== 'sdf3';
}

function scalarType(type: GraphValueType): boolean {
  return type === 'float' || type === 'int';
}

function assertExpressionType(expression: GroupExpression, inferred: GraphValueType, path: string): GraphValueType {
  if (!equivalentType(expression.type, inferred)) throw new Error(`${path} 声明为 ${expression.type}，实际为 ${inferred}`);
  return expression.type;
}

function inferGroupExpressionType(
  expression: GroupExpression,
  path: string,
  inputs: ReadonlyMap<string, LibrarySocket>,
  groups: ReadonlyMap<string, NodeGroupDefinition>,
): GraphValueType {
  const infer = (value: GroupExpression, child: string) => inferGroupExpressionType(value, `${path}.${child}`, inputs, groups);
  switch (expression.kind) {
    case 'input': {
      const socket = inputs.get(expression.input);
      if (!socket) throw new Error(`${path} 引用了未知输入 ${expression.input}`);
      return assertExpressionType(expression, socket.type, path);
    }
    case 'literal': return expression.type;
    case 'unary': {
      const value = infer(expression.value, 'value');
      if (expression.operator === '!') {
        if (value !== 'bool') throw new Error(`${path} 的 ! 只接受 bool`);
        return assertExpressionType(expression, 'bool', path);
      }
      if (!isNumericType(value)) throw new Error(`${path} 的一元 - 只接受数值`);
      return assertExpressionType(expression, value, path);
    }
    case 'binary': {
      const left = infer(expression.left, 'left');
      const right = infer(expression.right, 'right');
      if (!isNumericType(left) || !isNumericType(right)) throw new Error(`${path} 的 ${expression.operator} 只接受数值`);
      let result: GraphValueType;
      if (equivalentType(left, right)) result = left;
      else if (scalarType(left) && !scalarType(right)) result = right;
      else if (!scalarType(left) && scalarType(right)) result = left;
      else throw new Error(`${path} 的左右类型不兼容：${left} / ${right}`);
      return assertExpressionType(expression, result, path);
    }
    case 'construct': {
      if (!isNumericType(expression.type)) throw new Error(`${path} 构造目标必须是数值类型`);
      const args = expression.args.map((arg, index) => infer(arg, `args[${index}]`));
      if (!args.length || args.some((type) => !isNumericType(type))) throw new Error(`${path} 构造参数无效`);
      const targetComponents = graphTypeComponents(expression.type);
      const components = args.reduce((sum, type) => sum + graphTypeComponents(type), 0);
      if (targetComponents === 1 ? args.length !== 1 || graphTypeComponents(args[0]) !== 1 : !(args.length === 1 && graphTypeComponents(args[0]) === 1) && components !== targetComponents) {
        throw new Error(`${path} 构造分量数与 ${expression.type} 不匹配`);
      }
      return expression.type;
    }
    case 'swizzle': {
      const source = infer(expression.value, 'value');
      const width = graphTypeComponents(source);
      if (width < 2) throw new Error(`${path} 不能对 ${source} 使用 swizzle`);
      const positions = expression.mask.split('').map((part) => ({ x: 0, r: 0, y: 1, g: 1, z: 2, b: 2, w: 3, a: 3 } as Record<string, number>)[part] ?? 99);
      if (positions.some((position) => position >= width)) throw new Error(`${path} swizzle 超出 ${source} 分量范围`);
      const result = expression.mask.length === 1 ? 'float' : `vec${expression.mask.length}` as GraphValueType;
      return assertExpressionType(expression, result, path);
    }
    case 'group': {
      const key = `${expression.groupId}@${expression.version}`;
      const group = groups.get(key);
      const output = group?.outputs.find((item) => item.id === expression.output);
      if (!group || !output) throw new Error(`${path} 引用了不存在的 Group 输出 ${key}.${expression.output}`);
      const expected = new Set(group.inputs.map((input) => input.id));
      for (const argument of Object.keys(expression.args)) if (!expected.has(argument)) throw new Error(`${path} 包含多余参数 ${argument}`);
      for (const socket of group.inputs) {
        const argument = expression.args[socket.id];
        if (!argument) throw new Error(`${path} 缺少参数 ${socket.id}`);
        const actual = infer(argument, `args.${socket.id}`);
        if (!equivalentType(actual, socket.type)) throw new Error(`${path}.${socket.id} 需要 ${socket.type}，实际为 ${actual}`);
      }
      return assertExpressionType(expression, output.type, path);
    }
    case 'call': {
      const args = expression.args.map((arg, index) => infer(arg, `args[${index}]`));
      const one = () => { if (args.length !== 1 || !isNumericType(args[0])) throw new Error(`${path} 调用 ${expression.callee} 的参数无效`); return args[0]; };
      const same = (count: number) => {
        if (args.length !== count || !isNumericType(args[0]) || args.slice(1).some((type) => !equivalentType(type, args[0]))) throw new Error(`${path} 调用 ${expression.callee} 需要 ${count} 个同类型数值参数`);
        return args[0];
      };
      let result: GraphValueType;
      if (['float', 'int', 'vec2', 'vec3', 'vec4'].includes(expression.callee)) {
        const target = expression.callee as GraphValueType;
        if (!args.length || args.some((type) => !isNumericType(type))) throw new Error(`${path} 构造参数无效`);
        const components = args.reduce((sum, type) => sum + graphTypeComponents(type), 0);
        const targetComponents = graphTypeComponents(target);
        if (targetComponents === 1 ? args.length !== 1 || graphTypeComponents(args[0]) !== 1 : !(args.length === 1 && graphTypeComponents(args[0]) === 1) && components !== targetComponents) throw new Error(`${path} 构造分量数与 ${target} 不匹配`);
        result = target;
      } else if (expression.callee === 'bool') {
        if (args.length !== 1 || graphTypeComponents(args[0]) !== 1) throw new Error(`${path} bool 构造需要一个标量`);
        result = 'bool';
      } else if (['length'].includes(expression.callee)) {
        const value = one();
        if (graphTypeComponents(value) < 2) throw new Error(`${path} 的 length 需要向量`);
        result = 'float';
      } else if (['dot', 'distance'].includes(expression.callee)) {
        const value = same(2);
        if (graphTypeComponents(value) < 2) throw new Error(`${path} 的 ${expression.callee} 需要向量`);
        result = 'float';
      } else if (expression.callee === 'cross') {
        const value = same(2);
        if (graphTypeComponents(value) !== 3) throw new Error(`${path} 的 cross 需要 vec3`);
        result = value;
      } else if (['reflect'].includes(expression.callee)) result = same(2);
      else if (expression.callee === 'refract') {
        if (args.length !== 3 || !equivalentType(args[0], args[1]) || args[2] !== 'float' || graphTypeComponents(args[0]) < 2) throw new Error(`${path} 的 refract 签名无效`);
        result = args[0];
      } else if (['min', 'max', 'mod', 'pow'].includes(expression.callee)) {
        if (args.length !== 2 || !isNumericType(args[0]) || !(equivalentType(args[0], args[1]) || scalarType(args[1]))) throw new Error(`${path} 的 ${expression.callee} 签名无效`);
        result = args[0];
      } else if (expression.callee === 'clamp') {
        if (args.length !== 3 || !isNumericType(args[0]) || args.slice(1).some((type) => !(equivalentType(type, args[0]) || scalarType(type)))) throw new Error(`${path} 的 clamp 签名无效`);
        result = args[0];
      } else if (expression.callee === 'mix') {
        if (args.length !== 3 || !equivalentType(args[0], args[1]) || !(equivalentType(args[2], args[0]) || args[2] === 'float')) throw new Error(`${path} 的 mix 签名无效`);
        result = args[0];
      } else if (expression.callee === 'step') {
        if (args.length !== 2 || !(equivalentType(args[0], args[1]) || scalarType(args[0]))) throw new Error(`${path} 的 step 签名无效`);
        result = args[1];
      } else if (expression.callee === 'smoothstep') {
        if (args.length !== 3 || !(equivalentType(args[0], args[2]) || scalarType(args[0])) || !(equivalentType(args[1], args[2]) || scalarType(args[1]))) throw new Error(`${path} 的 smoothstep 签名无效`);
        result = args[2];
      } else if (expression.callee === 'atan') result = args.length === 1 ? one() : same(2);
      else result = one();
      return assertExpressionType(expression, result, path);
    }
  }
}

function normalizeGraphGroupDocument(
  value: unknown,
  key: string,
  inputIds: ReadonlySet<string>,
  outputIds: ReadonlySet<string>,
): NodeGroupGraphDocument {
  const graph = record(value);
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.inputBindings) || !Array.isArray(graph.outputBindings)) {
    throw new Error(`Group ${key}.graph 无效`);
  }
  const nodes = graph.nodes.map((raw, index): GraphNode => {
    const node = record(raw);
    const position = record(node?.position);
    const values = record(node?.values);
    if (!node || typeof node.id !== 'string' || !node.id || node.id.length > 256 || typeof node.type !== 'string' || !node.type || !Number.isInteger(node.typeVersion) || Number(node.typeVersion) < 1 || !position || typeof position.x !== 'number' || !Number.isFinite(position.x) || typeof position.y !== 'number' || !Number.isFinite(position.y) || !values) {
      throw new Error(`Group ${key}.graph.nodes[${index}] 无效`);
    }
    if (node.type.startsWith('output.') || node.type === 'core.parameter' || node.type.startsWith('input.texture') || node.type === 'input.channel-sample') {
      throw new Error(`Group ${key} 包含不可封装节点 ${node.type}`);
    }
    return { id: node.id, type: node.type, typeVersion: Number(node.typeVersion), position: { x: position.x, y: position.y }, values: { ...values } };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error(`Group ${key} 内部节点 ID 重复`);
  const edges = graph.edges.map((raw, index): GraphEdge => {
    const edge = record(raw);
    const from = record(edge?.from);
    const to = record(edge?.to);
    if (!edge || typeof edge.id !== 'string' || !edge.id || !from || !to || typeof from.nodeId !== 'string' || typeof from.socketId !== 'string' || typeof to.nodeId !== 'string' || typeof to.socketId !== 'string' || !nodeIds.has(from.nodeId) || !nodeIds.has(to.nodeId) || from.nodeId === to.nodeId) {
      throw new Error(`Group ${key}.graph.edges[${index}] 无效`);
    }
    return { id: edge.id, from: { nodeId: from.nodeId, socketId: from.socketId }, to: { nodeId: to.nodeId, socketId: to.socketId } };
  });
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) throw new Error(`Group ${key} 内部 Edge ID 重复`);
  const inputBindings = graph.inputBindings.map((raw, index) => {
    const binding = record(raw);
    const to = record(binding?.to);
    if (!binding || typeof binding.inputId !== 'string' || !inputIds.has(binding.inputId) || !to || typeof to.nodeId !== 'string' || typeof to.socketId !== 'string' || !nodeIds.has(to.nodeId)) throw new Error(`Group ${key}.graph.inputBindings[${index}] 无效`);
    return { inputId: binding.inputId, to: { nodeId: to.nodeId, socketId: to.socketId } };
  });
  if (new Set(inputBindings.map((binding) => binding.inputId)).size !== inputBindings.length) throw new Error(`Group ${key} 输入绑定重复`);
  const edgeTargets = new Set<string>();
  for (const edge of edges) {
    const target = graphSocketKey(edge.to);
    if (edgeTargets.has(target)) throw new Error(`Group ${key} 内部输入存在多条连接：${edge.to.nodeId}.${edge.to.socketId}`);
    edgeTargets.add(target);
  }
  for (const binding of inputBindings) if (edgeTargets.has(graphSocketKey(binding.to))) throw new Error(`Group ${key} 的公开输入与内部连接冲突：${binding.to.nodeId}.${binding.to.socketId}`);
  const outputBindings = graph.outputBindings.map((raw, index) => {
    const binding = record(raw);
    const from = record(binding?.from);
    if (!binding || typeof binding.outputId !== 'string' || !outputIds.has(binding.outputId) || !from || typeof from.nodeId !== 'string' || typeof from.socketId !== 'string' || !nodeIds.has(from.nodeId)) throw new Error(`Group ${key}.graph.outputBindings[${index}] 无效`);
    return { outputId: binding.outputId, from: { nodeId: from.nodeId, socketId: from.socketId } };
  });
  if (outputBindings.length !== outputIds.size || new Set(outputBindings.map((binding) => binding.outputId)).size !== outputBindings.length) throw new Error(`Group ${key} 必须绑定全部输出`);

  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    incoming.set(edge.to.nodeId, (incoming.get(edge.to.nodeId) ?? 0) + 1);
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }
  const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id).sort();
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const target of outgoing.get(id) ?? []) {
      const count = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, count);
      if (count === 0) queue.push(target);
    }
  }
  if (visited !== nodes.length) throw new Error(`Group ${key} 内部 Graph 存在环`);
  return { nodes, edges, inputBindings, outputBindings };
}

function collectDefinitionRefs(group: NodeGroupDefinition): Set<string> {
  const refs = new Set<string>();
  if (group.kind === 'expression') group.outputs.forEach((output) => collectGroupRefs(output.expression, refs));
  else {
    for (const node of group.graph.nodes) {
      const match = /^library\.group\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(node.type);
      if (match) refs.add(`${match[1]}@${node.typeVersion}`);
    }
  }
  return refs;
}

export function normalizeGraphLibrary(value: unknown): GraphLibraryDocument {
  const input = record(value);
  if (!input || input.format !== GRAPH_LIBRARY_FORMAT || (input.version !== 1 && input.version !== GRAPH_LIBRARY_VERSION) || !Array.isArray(input.groups) || !Array.isArray(input.functions)) throw new Error('Graph Library 格式或版本无效');
  const keys = new Set<string>();
  const groups = input.groups.map((raw, index): NodeGroupDefinition => {
    const group = record(raw);
    if (!group || typeof group.id !== 'string' || !ID.test(group.id) || !Number.isInteger(group.version) || Number(group.version) < 1 || typeof group.title !== 'string' || !Array.isArray(group.inputs) || !Array.isArray(group.outputs)) throw new Error(`Group[${index}] 无效`);
    const key = `${group.id}@${group.version}`;
    if (keys.has(`group:${key}`)) throw new Error(`Node Group 重复：${key}`);
    keys.add(`group:${key}`);
    const inputs = group.inputs.map((item, socketIndex) => normalizeSocket(item, `Group ${key}.inputs[${socketIndex}]`));
    const inputIds = new Set(inputs.map((item) => item.id));
    if (inputIds.size !== inputs.length) throw new Error(`Group ${key} 输入 ID 重复`);
    const outputRecords = group.outputs.map((item, outputIndex) => {
      const output = record(item);
      if (!output || typeof output.id !== 'string' || !ID.test(output.id) || typeof output.title !== 'string' || !isGraphValueType(output.type)) throw new Error(`Group ${key}.outputs[${outputIndex}] 无效`);
      return output;
    });
    if (!outputRecords.length || new Set(outputRecords.map((item) => item.id as string)).size !== outputRecords.length) throw new Error(`Group ${key} 必须有唯一输出`);
    const base = { id: group.id, version: group.version as number, title: group.title.trim() || group.id, inputs };
    if (group.kind === 'graph') {
      const outputs = outputRecords.map((output) => ({ id: output.id as string, title: (output.title as string).trim() || output.id as string, type: output.type as GraphValueType }));
      const graph = normalizeGraphGroupDocument(group.graph, key, inputIds, new Set(outputs.map((output) => output.id)));
      return { ...base, kind: 'graph', outputs, graph };
    }
    const outputs = outputRecords.map((output, outputIndex) => {
      if (output.type === 'sdf3') throw new Error(`Group ${key}.outputs[${outputIndex}] 无效`);
      const expression = normalizeExpression(output.expression, `Group ${key}.outputs[${outputIndex}].expression`);
      if (expression.type !== output.type) throw new Error(`Group ${key}.${output.id as string} 表达式类型不匹配`);
      return { id: output.id as string, title: (output.title as string).trim() || output.id as string, type: output.type as GraphValueType, expression };
    });
    const checkInputs = (expression: GroupExpression): void => {
      if (expression.kind === 'input' && !inputIds.has(expression.input)) throw new Error(`Group ${key} 引用了未知输入 ${expression.input}`);
      if (expression.kind === 'unary' || expression.kind === 'swizzle') checkInputs(expression.value);
      else if (expression.kind === 'binary') { checkInputs(expression.left); checkInputs(expression.right); }
      else if (expression.kind === 'call' || expression.kind === 'construct') expression.args.forEach(checkInputs);
      else if (expression.kind === 'group') Object.values(expression.args).forEach(checkInputs);
    };
    outputs.forEach((output) => checkInputs(output.expression));
    return { ...base, kind: 'expression', outputs };
  });
  const functions = input.functions.map((raw, index): CustomFunctionDefinition => {
    const fn = record(raw);
    if (!fn || typeof fn.id !== 'string' || !ID.test(fn.id) || !Number.isInteger(fn.version) || Number(fn.version) < 1 || typeof fn.title !== 'string' || !Array.isArray(fn.inputs)) throw new Error(`Function[${index}] 无效`);
    const key = `${fn.id}@${fn.version}`;
    if (keys.has(`function:${key}`)) throw new Error(`Custom Function 重复：${key}`);
    keys.add(`function:${key}`);
    const inputs = fn.inputs.map((item, socketIndex) => normalizeSocket(item, `Function ${key}.inputs[${socketIndex}]`));
    if (new Set(inputs.map((item) => item.id)).size !== inputs.length) throw new Error(`Function ${key} 输入 ID 重复`);
    const output = record(fn.output);
    if (!output || typeof output.id !== 'string' || !ID.test(output.id) || typeof output.title !== 'string' || !isGraphValueType(output.type) || output.type === 'sdf3') throw new Error(`Function ${key} 输出无效`);
    if (typeof fn.expression !== 'string') throw new Error(`Function ${key} expression 无效`);
    validateCustomExpression(fn.expression, inputs, output.type);
    return { id: fn.id, version: fn.version as number, title: fn.title.trim() || fn.id, inputs, output: { id: output.id, title: output.title.trim() || output.id, type: output.type }, expression: fn.expression.trim() };
  });

  const groupMap = new Map(groups.map((group) => [`${group.id}@${group.version}`, group]));
  const functionKeys = new Set(functions.map((fn) => `${fn.id}@${fn.version}`));
  const builtins = createDefaultRegistry();
  for (const group of groups) {
    if (group.kind !== 'graph') continue;
    for (const node of group.graph.nodes) {
      const groupMatch = /^library\.group\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(node.type);
      const functionMatch = /^library\.function\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(node.type);
      if (groupMatch) {
        if (!groupMap.has(`${groupMatch[1]}@${node.typeVersion}`)) throw new Error(`Group ${group.id}@${group.version} 包含未知节点 ${node.type}@${node.typeVersion}`);
        continue;
      }
      if (functionMatch) {
        if (!functionKeys.has(`${functionMatch[1]}@${node.typeVersion}`)) throw new Error(`Group ${group.id}@${group.version} 包含未知节点 ${node.type}@${node.typeVersion}`);
        continue;
      }
      const definition = builtins.get(node.type, node.typeVersion);
      if (!definition) throw new Error(`Group ${group.id}@${group.version} 包含未知节点 ${node.type}@${node.typeVersion}`);
      if (!isNodeAllowedInPureGroup(definition)) throw new Error(`Group ${group.id}@${group.version} 包含不可封装节点 ${node.type}`);
      const issue = validateNodeValues(node, definition)[0];
      if (issue) throw new Error(`Group ${group.id}@${group.version} 节点值 ${node.id}.${issue.field} 无效：${issue.message}`);
    }
  }
  for (const group of groups) {
    if (group.kind !== 'expression') continue;
    const inputs = new Map(group.inputs.map((input) => [input.id, input]));
    for (const output of group.outputs) {
      const actual = inferGroupExpressionType(output.expression, `Group ${group.id}@${group.version}.${output.id}`, inputs, groupMap);
      if (!equivalentType(actual, output.type)) throw new Error(`Group ${group.id}@${group.version}.${output.id} 输出类型不匹配`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error(`Node Group 递归调用：${[...visiting, key].join(' -> ')}`);
    if (visited.has(key)) return;
    const group = groupMap.get(key);
    if (!group) throw new Error(`Node Group 引用了不存在的 Group：${key}`);
    visiting.add(key);
    const refs = collectDefinitionRefs(group);
    [...refs].sort().forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  [...groupMap.keys()].sort().forEach(visit);
  return { format: GRAPH_LIBRARY_FORMAT, version: GRAPH_LIBRARY_VERSION, groups: groups.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version), functions: functions.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version) };
}

export function parseGraphLibrary(text: string): GraphLibraryDocument {
  try { return normalizeGraphLibrary(JSON.parse(text) as unknown); }
  catch { throw new ProductError({ code: 'graph.library-invalid' }); }
}

export function serializeGraphLibrary(value: unknown): string {
  return `${JSON.stringify(normalizeGraphLibrary(value), null, 2)}\n`;
}

function lowerGroupExpression(expression: GroupExpression, inputs: Readonly<Record<string, IrExpr>>, ir: NodeIrBuilder, groups: ReadonlyMap<string, NodeGroupDefinition>, stack: readonly string[]): IrExpr {
  switch (expression.kind) {
    case 'input': {
      const value = inputs[expression.input];
      if (!value) throw new Error(`Node Group 输入缺失：${expression.input}`);
      return value.type === expression.type ? value : ir.convert(value, expression.type);
    }
    case 'literal': return ir.literal(expression.value, expression.type);
    case 'unary': return ir.unary(expression.operator, lowerGroupExpression(expression.value, inputs, ir, groups, stack), expression.type);
    case 'binary': return ir.binary(expression.operator, lowerGroupExpression(expression.left, inputs, ir, groups, stack), lowerGroupExpression(expression.right, inputs, ir, groups, stack), expression.type);
    case 'call': return ir.call(expression.callee, expression.args.map((arg) => lowerGroupExpression(arg, inputs, ir, groups, stack)), expression.type);
    case 'construct': return ir.construct(expression.type, expression.args.map((arg) => lowerGroupExpression(arg, inputs, ir, groups, stack)));
    case 'swizzle': return ir.swizzle(lowerGroupExpression(expression.value, inputs, ir, groups, stack), expression.mask, expression.type);
    case 'group': {
      const key = `${expression.groupId}@${expression.version}`;
      if (stack.includes(key)) throw new Error(`Node Group 递归调用：${[...stack, key].join(' -> ')}`);
      const group = groups.get(key);
      if (!group) throw new Error(`Node Group 不存在：${key}`);
      if (group.kind !== 'expression') throw new Error(`表达式 Group 不能内联 graph-backed Group：${key}`);
      const output = group.outputs.find((item) => item.id === expression.output);
      if (!output) throw new Error(`Node Group 输出不存在：${key}.${expression.output}`);
      const nestedInputs = Object.fromEntries(group.inputs.map((socket) => {
        const arg = expression.args[socket.id];
        if (!arg) throw new Error(`Node Group ${key} 缺少参数 ${socket.id}`);
        return [socket.id, lowerGroupExpression(arg, inputs, ir, groups, stack)];
      }));
      return lowerGroupExpression(output.expression, nestedInputs, ir, groups, [...stack, key]);
    }
  }
}

function graphSocketKey(ref: GraphSocketRef): string {
  return `${ref.nodeId}\u0000${ref.socketId}`;
}

function lowerGraphBackedGroup(
  group: GraphNodeGroupDefinition,
  externalInputs: Readonly<Record<string, IrExpr>>,
  context: NodeLowerContext,
  registry: NodeRegistry,
): Record<string, IrExpr> {
  const nodeMap = new Map(group.graph.nodes.map((node) => [node.id, node]));
  const inputEdges = new Map(group.graph.edges.map((edge) => [graphSocketKey(edge.to), edge]));
  const externalBindings = new Map(group.graph.inputBindings.map((binding) => [graphSocketKey(binding.to), binding.inputId]));
  const incoming = new Map(group.graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(group.graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of group.graph.edges) {
    incoming.set(edge.to.nodeId, (incoming.get(edge.to.nodeId) ?? 0) + 1);
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }
  const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const count = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, count);
      if (count === 0) queue.push(target);
    }
    queue.sort();
  }
  if (order.length !== group.graph.nodes.length) throw new Error(`Node Group ${group.id}@${group.version} 内部存在环`);

  const references = new Map<string, IrExpr>();
  for (const nodeId of order) {
    const node = nodeMap.get(nodeId)!;
    const definition = registry.get(node.type, node.typeVersion);
    if (!definition || !isNodeAllowedInPureGroup(definition)) throw new Error(`Node Group ${group.id}@${group.version} 内部节点定义无效或非纯：${node.type}@${node.typeVersion}`);
    const inputs: Record<string, IrExpr> = {};
    const inputTypes: Record<string, GraphValueType> = {};
    for (const socket of definition.inputs) {
      const key = graphSocketKey({ nodeId, socketId: socket.id });
      const edge = inputEdges.get(key);
      const externalId = externalBindings.get(key);
      let expression: IrExpr | undefined;
      if (edge) expression = references.get(graphSocketKey(edge.from));
      else if (externalId) expression = externalInputs[externalId];
      if (!expression) {
        if (socket.required) throw new Error(`Node Group ${group.id}@${group.version} 的 ${node.type}.${socket.id} 缺少输入`);
        const defaultType = socket.defaultType ?? (!['numeric', 'vector', 'any-value'].includes(socket.type) ? socket.type as GraphValueType : 'float');
        const value = Object.prototype.hasOwnProperty.call(node.values, socket.id)
          ? node.values[socket.id]
          : Object.prototype.hasOwnProperty.call(definition.defaultValues, socket.id)
            ? definition.defaultValues[socket.id]
            : socket.defaultValue;
        expression = context.ir.literal(value as GraphParameterValue, defaultType);
      }
      if (!['numeric', 'vector', 'any-value'].includes(socket.type) && expression.type !== socket.type) {
        expression = context.ir.convert(expression, socket.type as GraphValueType);
      }
      inputs[socket.id] = expression;
      inputTypes[socket.id] = expression.type;
    }
    const outputTypes = definition.inferTypes({ node, inputTypes });
    if (!outputTypes) throw new Error(`Node Group ${group.id}@${group.version} 无法推导 ${node.type} 类型`);
    const lowered = definition.lower({
      ...context,
      node,
      inputs,
      inputTypes,
      outputTypes,
      parameterName: undefined,
      parameterType: undefined,
      value(key) {
        if (Object.prototype.hasOwnProperty.call(node.values, key)) return node.values[key];
        if (Object.prototype.hasOwnProperty.call(definition.defaultValues, key)) return definition.defaultValues[key];
        return definition.inputs.find((socket) => socket.id === key)?.defaultValue;
      },
    });
    for (const socket of definition.outputs) {
      const expression = lowered[socket.id];
      if (!expression) throw new Error(`Node Group ${group.id}@${group.version} 的 ${node.type}.${socket.id} 未生成 IR`);
      references.set(graphSocketKey({ nodeId, socketId: socket.id }), expression);
    }
  }
  return Object.fromEntries(group.outputs.map((output) => {
    const binding = group.graph.outputBindings.find((item) => item.outputId === output.id);
    let expression = binding ? references.get(graphSocketKey(binding.from)) : undefined;
    if (!expression) throw new Error(`Node Group ${group.id}@${group.version} 输出 ${output.id} 未绑定`);
    if (expression.type !== output.type) expression = context.ir.convert(expression, output.type);
    return [output.id, expression];
  }));
}

function socketDefinition(socket: LibrarySocket): SocketDefinition {
  return { id: socket.id, title: socket.title, type: socket.type, defaultType: socket.type, defaultValue: socket.defaultValue };
}

export function registerGraphLibrary(registry: NodeRegistry, value: GraphLibraryDocument): NodeRegistry {
  const library = normalizeGraphLibrary(value);
  const groups = new Map(library.groups.map((group) => [`${group.id}@${group.version}`, group]));
  for (const group of library.groups) {
    const outputs = group.outputs.map((output): SocketDefinition => ({ id: output.id, title: output.title, type: output.type }));
    const definition: NodeDefinition = {
      type: `library.group.${group.id}`, version: group.version, title: group.title, category: 'Node Groups',
      hostTargets: BOTH_GRAPH_HOST_TARGETS, groupKind: 'pure',
      inputs: group.inputs.map(socketDefinition), outputs,
      defaultValues: Object.fromEntries(group.inputs.map((input) => [input.id, input.defaultValue])),
      inferTypes: () => Object.fromEntries(group.outputs.map((output) => [output.id, output.type])),
      lower: (context) => group.kind === 'expression'
        ? Object.fromEntries(group.outputs.map((output) => [output.id, lowerGroupExpression(output.expression, context.inputs, context.ir, groups, [`${group.id}@${group.version}`])]))
        : lowerGraphBackedGroup(group, context.inputs, context, registry),
    };
    registry.register(definition);
  }
  for (const fn of library.functions) {
    const callee = `_sg_custom_${fn.id}_v${fn.version}`;
    const helper = `${glslType(fn.output.type)} ${callee}(${fn.inputs.map((input) => `${glslType(input.type)} ${input.id}`).join(', ')}) {\n    return (${fn.expression});\n}`;
    registry.register({
      type: `library.function.${fn.id}`, version: fn.version, title: fn.title, category: 'Custom Functions',
      hostTargets: BOTH_GRAPH_HOST_TARGETS, groupKind: 'pure',
      inputs: fn.inputs.map(socketDefinition), outputs: [{ id: fn.output.id, title: fn.output.title, type: fn.output.type }],
      defaultValues: Object.fromEntries(fn.inputs.map((input) => [input.id, input.defaultValue])),
      inferTypes: () => ({ [fn.output.id]: fn.output.type }),
      lower: ({ inputs, ir, addHelper }) => { addHelper(`custom:${fn.id}@${fn.version}`, helper); return { [fn.output.id]: ir.call(callee, fn.inputs.map((input) => inputs[input.id]), fn.output.type) }; },
    });
  }
  return registry;
}

export function createProjectNodeRegistry(library: GraphLibraryDocument = createGraphLibrary()): NodeRegistry {
  return registerGraphLibrary(createDefaultRegistry(), library);
}

export function createStarterNodeGroup(id = 'wave_mix'): NodeGroupDefinition {
  return {
    kind: 'expression',
    id, version: 1, title: 'Wave Mix',
    inputs: [
      { id: 'value', title: 'Value', type: 'float', defaultValue: 0 },
      { id: 'amount', title: 'Amount', type: 'float', defaultValue: 1 },
    ],
    outputs: [{
      id: 'out', title: 'Out', type: 'float',
      expression: { kind: 'binary', operator: '*', type: 'float', left: { kind: 'call', callee: 'sin', type: 'float', args: [{ kind: 'input', input: 'value', type: 'float' }] }, right: { kind: 'input', input: 'amount', type: 'float' } },
    }],
  };
}

export function createStarterCustomFunction(id = 'soft_pulse'): CustomFunctionDefinition {
  return {
    id, version: 1, title: 'Soft Pulse',
    inputs: [
      { id: 'value', title: 'Value', type: 'float', defaultValue: 0 },
      { id: 'width', title: 'Width', type: 'float', defaultValue: 0.25 },
    ],
    output: { id: 'out', title: 'Out', type: 'float' },
    expression: 'exp(-abs(value) / max(width, 0.0001))',
  };
}
