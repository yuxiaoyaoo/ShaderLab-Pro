import type { ProjectSources, SrcPassId } from '../project/types';

export type UniformWidget = 'slider' | 'color' | 'toggle' | 'select' | 'input';
export type UniformType = 'float' | 'int' | 'bool' | 'vec2' | 'vec3' | 'vec4';
export type UniformValue = number | boolean | number[];

export interface UniformDecl {
  /** Runtime/API identity. */
  name: string;
  /** Optional author-facing label; never participates in runtime identity or conflicts. */
  displayName?: string;
  label?: string;
  type: UniformType;
  def: UniformValue;
  min: number;
  max: number;
  step: number;
  widget: UniformWidget;
  options?: string[];
  pass: SrcPassId;
}

export interface RuntimeUniform {
  name: string;
  type: UniformType;
  value: UniformValue;
}

export interface PersistedUniform {
  name: string;
  type: UniformType;
  value: UniformValue;
}

const PASS_SOURCES: { id: SrcPassId; key: keyof ProjectSources }[] = [
  { id: 'common', key: 'common' },
  { id: 'image', key: 'image' },
  { id: 'bufferA', key: 'bufferA' },
  { id: 'bufferB', key: 'bufferB' },
  { id: 'bufferC', key: 'bufferC' },
  { id: 'bufferD', key: 'bufferD' },
  { id: 'sound', key: 'sound' },
];

const DECL_RE =
  /^\s*uniform\s+(float|int|bool|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s*(?:=\s*([^;]*?))?\s*;/;
const SLIDER_RE = /@slider\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/;
const ANNOT_RE =
  /@uniform\s+(float|int|bool|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s+((?:\([^)]*\)|[^\s]+))(?:\s+([-+0-9.eE]+))?(?:\s+([-+0-9.eE]+))?(?:\s+([-+0-9.eE]+))?(?:\s+(slider|color|toggle|select))?(?::\s*([^\r\n]*))?/;

function parseScalar(raw: string): number {
  if (raw === 'true') return 1;
  if (raw === 'false') return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function parseDefault(type: UniformType, raw?: string): UniformValue {
  if (type === 'bool') {
    if (!raw) return false;
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'on';
  }
  if (type === 'float' || type === 'int') {
    if (!raw) return 0;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return 0;
    return type === 'int' ? Math.trunc(n) : n;
  }
  const nums = raw
    ? raw
        .replace(/[()[\]]/g, '')
        .split(',')
        .map((s) => parseScalar(s.trim()))
    : [];
  while (nums.length < COMPONENTS[type]) nums.push(0);
  return nums.slice(0, COMPONENTS[type]);
}

const COMPONENTS: Record<Exclude<UniformType, 'float' | 'int' | 'bool'>, number> = {
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

function defaultRange(type: UniformType): { min: number; max: number; step: number } {
  switch (type) {
    case 'int':
      return { min: 0, max: 100, step: 1 };
    case 'vec2':
    case 'vec3':
    case 'vec4':
      return { min: 0, max: 1, step: 0.01 };
    default:
      return { min: 0, max: 1, step: 0.01 };
  }
}

export interface UniformParseResult {
  decls: UniformDecl[];
  byPass: Record<string, UniformDecl[]>;
}

export function parseUniforms(
  sources: ProjectSources,
  enabled?: (pid: SrcPassId) => boolean,
): UniformParseResult {
  const map = new Map<string, UniformDecl>();
  for (const ps of PASS_SOURCES) {
    if (enabled && !enabled(ps.id)) continue;
    const src = sources[ps.key];
    if (typeof src !== 'string' || src === '') continue;
    for (const line of src.split('\n')) {
      let match: RegExpExecArray | null;
      ANNOT_RE.lastIndex = 0;
      match = ANNOT_RE.exec(line);
      if (match) {
        const type = match[1] as UniformType;
        const name = match[2];
        let widget: UniformWidget = (match[7] as UniformWidget) || 'slider';
        let opts: string[] | undefined;
        if (widget === 'select' && match[8]) {
          opts = match[8].split(',').map((s) => s.trim());
        }
        const { min, max, step } = defaultRange(type);
        map.set(`${ps.id}\u0000${name}`, {
          name,
          type,
          def: parseDefault(type, match[3]),
          min: match[4] !== undefined ? Number.parseFloat(match[4]) : min,
          max: match[5] !== undefined ? Number.parseFloat(match[5]) : max,
          step: match[6] !== undefined ? Number.parseFloat(match[6]) : step,
          widget,
          options: opts,
          pass: ps.id,
        });
        continue;
      }
      DECL_RE.lastIndex = 0;
      match = DECL_RE.exec(line);
      if (!match) continue;
      const type = match[1] as UniformType;
      const name = match[2];
      const rawDef = match[3]?.trim();
      const slider = SLIDER_RE.exec(line);
      const isColor = /@color\b/.test(line);
      const widget: UniformWidget = isColor ? 'color' : slider ? 'slider' : 'input';
      const { min, max, step } = slider
        ? {
            min: Number.parseFloat(slider[1]),
            max: Number.parseFloat(slider[2]),
            step: Number.parseFloat(slider[3]),
          }
        : defaultRange(type);
      const key = `${ps.id}\u0000${name}`;
      if (!map.has(key)) {
        map.set(key, {
          name,
          type,
          def: parseDefault(type, rawDef),
          min,
          max,
          step,
          widget,
          pass: ps.id,
        });
      } else {
        const prev = map.get(key)!;
        if (slider) {
          prev.widget = 'slider';
          prev.min = min;
          prev.max = max;
          prev.step = step;
        } else if (isColor) {
          prev.widget = 'color';
        }
      }
    }
  }
  const decls = [...map.values()];
  const byPass: Record<string, UniformDecl[]> = {};
  for (const d of decls) {
    (byPass[d.pass] ??= []).push(d);
  }
  return { decls, byPass };
}

export function valuesFromPersisted(list: unknown[]): Record<string, UniformValue> {
  const out: Record<string, UniformValue> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { name?: unknown; value?: unknown };
    if (typeof it.name === 'string' && it.value !== undefined) {
      out[it.name] = it.value as UniformValue;
    }
  }
  return out;
}

export function toPersistedUniforms(
  decls: UniformDecl[],
  values: Record<string, UniformValue>,
): PersistedUniform[] {
  return decls.map((d) => ({
    name: d.name,
    type: d.type,
    value: d.name in values ? values[d.name] : d.def,
  }));
}