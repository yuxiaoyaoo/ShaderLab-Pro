import type { ProductMessageDescriptor } from '../../productMessage';
import { graphTypeComponents, type GraphParameter, type GraphParameterUi, type GraphParameterValue, type GraphValueType } from '../model';

export type GraphValueDraftResult =
  | { ok: true; value: GraphParameterValue }
  | { ok: false; error: ProductMessageDescriptor };

export function defaultGraphValue(type: GraphValueType): GraphParameterValue {
  if (type === 'bool') return false;
  const count = graphTypeComponents(type);
  return count === 1 ? 0 : Array<number>(count).fill(0);
}

export function formatGraphValueDraft(value: GraphParameterValue): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export function parseGraphValueDraft(type: GraphValueType, raw: string): GraphValueDraftResult {
  const text = raw.trim();
  if (type === 'bool') {
    if (text === 'true') return { ok: true, value: true };
    if (text === 'false') return { ok: true, value: false };
    return { ok: false, error: { code: 'graph.value-boolean-text-required' } };
  }
  const count = graphTypeComponents(type);
  const parts = count === 1 ? [text] : text.split(',').map((part) => part.trim());
  if (parts.length !== count || parts.some((part) => part.length === 0)) {
    return { ok: false, error: { code: 'graph.value-components-text-required', params: { count } } };
  }
  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    return { ok: false, error: { code: 'graph.value-finite-required' } };
  }
  if (type === 'int' && !Number.isInteger(values[0])) {
    return { ok: false, error: { code: 'graph.value-integer-text-required' } };
  }
  return { ok: true, value: count === 1 ? values[0] : values };
}

export function defaultGraphParameterUi(type: GraphValueType): GraphParameterUi {
  if (type === 'color3' || type === 'color4') return { widget: 'color', min: 0, max: 1, step: 0.01 };
  if (type === 'int') return { widget: 'number', min: 0, max: 100, step: 1 };
  if (type === 'bool') return { widget: 'number' };
  return { widget: 'slider', min: 0, max: 1, step: 0.01 };
}

export function graphParameterTypePatch(
  type: GraphParameter['valueType'],
): Pick<GraphParameter, 'valueType' | 'defaultValue' | 'ui'> {
  return { valueType: type, defaultValue: defaultGraphValue(type), ui: defaultGraphParameterUi(type) };
}
