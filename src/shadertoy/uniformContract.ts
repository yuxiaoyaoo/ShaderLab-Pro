import type { DiagnosticOrigin, UnifiedDiagnostic } from '../diagnostics/model';
import type { GeneratedUniform } from '../graph/compiler/types';
import type { UniformDecl, UniformValue, RuntimeUniform, UniformWidget, UniformType } from './uniforms';

const PASS_ORDER = ['common', 'image', 'bufferA', 'bufferB', 'bufferC', 'bufferD', 'sound'] as const;
const passRank = (pass: UniformDecl['pass']) => Math.max(0, PASS_ORDER.indexOf(pass));
const defaultRange = (type: GeneratedUniform['type']) => type === 'int'
  ? { min: 0, max: 100, step: 1 }
  : { min: 0, max: 1, step: 0.01 };
const graphWidget = (widget: GeneratedUniform['widget']): UniformWidget => widget === 'number' ? 'input' : widget;
const codeOrigin = (decl: UniformDecl): DiagnosticOrigin => ({ kind: 'code', pass: decl.pass, line: 1, column: 1 });
const graphOrigin = (uniform: GeneratedUniform): DiagnosticOrigin => ({ kind: 'graph', pass: uniform.pass, nodeId: uniform.nodeId, parameterId: uniform.id });

interface ContractCandidate { decl: UniformDecl; graph: boolean; origin: DiagnosticOrigin; order: number }
export interface UniformContractResult { declarations: UniformDecl[]; runtimeUniforms: RuntimeUniform[]; diagnostics: UnifiedDiagnostic[]; hasErrors: boolean }

function graphDeclaration(uniform: GeneratedUniform): UniformDecl {
  const range = defaultRange(uniform.type);
  return {
    name: uniform.emittedName,
    displayName: uniform.displayName,
    label: uniform.displayName,
    type: uniform.type,
    def: uniform.defaultValue as UniformValue,
    min: uniform.min ?? range.min,
    max: uniform.max ?? range.max,
    step: uniform.step ?? range.step,
    widget: graphWidget(uniform.widget),
    pass: uniform.pass,
  };
}

/** Builds the single global Runtime uniform namespace without silently overwriting incompatible types. */
export function buildUniformContract(
  parsed: readonly UniformDecl[],
  graphUniforms: readonly GeneratedUniform[] = [],
  values: Readonly<Record<string, UniformValue>> = {},
): UniformContractResult {
  const candidates: ContractCandidate[] = [
    ...parsed.map((decl, order) => ({ decl: { ...decl }, graph: false, origin: codeOrigin(decl), order })),
    ...graphUniforms.map((uniform, order) => ({ decl: graphDeclaration(uniform), graph: true, origin: graphOrigin(uniform), order: parsed.length + order })),
  ];
  candidates.sort((a, b) => a.decl.name.localeCompare(b.decl.name) || passRank(a.decl.pass) - passRank(b.decl.pass) || a.order - b.order);
  const declarations: UniformDecl[] = [];
  const diagnostics: UnifiedDiagnostic[] = [];
  const grouped = new Map<string, ContractCandidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.decl.name) ?? [];
    group.push(candidate);
    grouped.set(candidate.decl.name, group);
  }
  for (const [name, group] of grouped) {
    const types = [...new Set(group.map((item) => item.decl.type))];
    if (types.length > 1) {
      diagnostics.push({
        message: `Uniform ${name} 在全局 Runtime namespace 中声明了不兼容类型：${types.join(' / ')}`,
        severity: 'error', stage: 'runtime', code: 'uniform.type-conflict',
        params: { name, types: types.join(' / ') },
        origin: group[0].origin,
        relatedOrigins: group.slice(1).map((item) => item.origin),
      });
      continue;
    }
    // Same-type declarations merge deterministically. Graph authoring metadata wins while emittedName remains identity.
    const selected = [...group].sort((a, b) => Number(b.graph) - Number(a.graph) || passRank(a.decl.pass) - passRank(b.decl.pass) || a.order - b.order)[0];
    declarations.push({ ...selected.decl });
  }
  declarations.sort((a, b) => passRank(a.pass) - passRank(b.pass) || a.name.localeCompare(b.name));
  const runtimeUniforms = declarations.map((decl) => ({ name: decl.name, type: decl.type, value: isUniformValueCompatible(decl.type, values[decl.name]) ? values[decl.name] : decl.def }));
  return { declarations, runtimeUniforms, diagnostics, hasErrors: diagnostics.some((item) => item.severity === 'error') };
}

export function isUniformValueCompatible(type: UniformType, value: UniformValue | undefined): value is UniformValue {
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'float') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'int') return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
  const count = type === 'vec2' ? 2 : type === 'vec3' ? 3 : 4;
  return Array.isArray(value) && value.length === count && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

/** Drops removed declarations, preserves valid values, and resets incompatible type/shape values to defaults. */
export function reconcileUniformValues(
  declarations: readonly UniformDecl[],
  values: Readonly<Record<string, UniformValue>>,
  previousTypes?: ReadonlyMap<string, UniformType>,
): Record<string, UniformValue> {
  return Object.fromEntries(declarations.map((decl) => {
    const typeUnchanged = previousTypes === undefined || previousTypes.get(decl.name) === decl.type;
    return [decl.name, typeUnchanged && isUniformValueCompatible(decl.type, values[decl.name]) ? values[decl.name] : decl.def];
  }));
}

export function mergeUniformDeclarations(parsed: readonly UniformDecl[], graphUniforms: readonly GeneratedUniform[] = []): UniformDecl[] {
  return buildUniformContract(parsed, graphUniforms).declarations;
}

export function buildRuntimeUniformContract(parsed: readonly UniformDecl[], graphUniforms: readonly GeneratedUniform[], values: Readonly<Record<string, UniformValue>>): RuntimeUniform[] {
  return buildUniformContract(parsed, graphUniforms, values).runtimeUniforms;
}
