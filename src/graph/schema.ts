import type { ProductMessageParams } from '../productMessage';
import {
  CURRENT_GRAPH_VERSION,
  GRAPH_FORMAT,
  createEmptyGraph,
  graphTypeComponents,
  isGraphParameterValueType,
  type GraphDocument,
  type GraphParameter,
  type GraphParameterUi,
  type GraphParameterValue,
  type GraphPassId,
} from './model';

export interface GraphSchemaIssue {
  code: string;
  message: string;
  params?: ProductMessageParams;
  rawDetail?: string;
  path: string;
  nodeId?: string;
  edgeId?: string;
  parameterId?: string;
}

export interface GraphSchemaResult {
  ok: boolean;
  document?: GraphDocument;
  diagnostics: GraphSchemaIssue[];
}

const PASSES = new Set<GraphPassId>(['image', 'bufferA', 'bufferB', 'bufferC', 'bufferD', 'sound']);
const WIDGETS = new Set(['slider', 'color', 'number']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function issue(
  diagnostics: GraphSchemaIssue[],
  code: string,
  path: string,
  message: string,
  origin: Partial<Pick<GraphSchemaIssue, 'nodeId' | 'edgeId' | 'parameterId' | 'params' | 'rawDetail'>> = {},
): void {
  diagnostics.push({ code, path, message, ...origin });
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function jsonSafeFiniteTree(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((item) =>
    jsonSafeFiniteTree(item, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

function normalizeParameterValue(type: GraphParameter['valueType'], value: unknown): GraphParameterValue | null {
  if (type === 'bool') return typeof value === 'boolean' ? value : null;
  if (type === 'int') return finite(value) && Number.isInteger(value) ? value : null;
  if (type === 'float') return finite(value) ? value : null;
  const components = graphTypeComponents(type);
  if (!Array.isArray(value) || value.length !== components || !value.every(finite)) return null;
  return value.slice() as number[];
}

function normalizeUi(value: unknown, path: string, diagnostics: GraphSchemaIssue[], parameterId: string): GraphParameterUi | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input || !WIDGETS.has(input.widget as string)) {
    issue(diagnostics, 'schema.parameter-ui', path, '参数 UI 必须包含 slider、color 或 number widget', { parameterId });
    return undefined;
  }
  const out: GraphParameterUi = { widget: input.widget as GraphParameterUi['widget'] };
  for (const key of ['min', 'max', 'step'] as const) {
    const item = input[key];
    if (item !== undefined && !finite(item)) {
      issue(diagnostics, 'schema.non-finite', `${path}.${key}`, `${key} 必须是有限数值`, { parameterId });
    } else if (finite(item)) {
      out[key] = item;
    }
  }
  if (out.step !== undefined && out.step <= 0) {
    issue(diagnostics, 'schema.parameter-step', `${path}.step`, 'step 必须大于 0', { parameterId });
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    issue(diagnostics, 'schema.parameter-range', path, '参数 min 不能大于 max', { parameterId });
  }
  if ((out.widget === 'color') && !['color3', 'color4', 'vec3', 'vec4'].includes(String((record(value) ?? {}).valueType ?? ''))) {
    // Type compatibility is checked with the enclosing parameter below; keep UI normalization pure.
  }
  return out;
}

/** Identity migration entry point. Future versions must add explicit migrations here. */
export function migrateGraphDocumentV1(document: GraphDocument): GraphDocument {
  return document;
}

export function parseGraphJson(json: string): GraphSchemaResult {
  try {
    return normalizeGraphDocument(JSON.parse(json) as unknown);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: 'schema.invalid-json',
        path: '$',
        message: 'Graph JSON 无效',
        rawDetail: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export function normalizeGraphDocument(value: unknown): GraphSchemaResult {
  const diagnostics: GraphSchemaIssue[] = [];
  const input = record(value);
  if (!input) {
    return { ok: false, diagnostics: [{ code: 'schema.document', path: '$', message: 'Graph 文档必须是对象' }] };
  }
  if (input.format !== GRAPH_FORMAT) {
    issue(diagnostics, 'schema.format', '$.format', `format 必须为 ${GRAPH_FORMAT}`);
  }
  if (!Number.isInteger(input.version)) {
    issue(diagnostics, 'schema.version', '$.version', 'Graph version 必须是整数');
  } else if ((input.version as number) > CURRENT_GRAPH_VERSION) {
    issue(
      diagnostics,
      'schema.future-version',
      '$.version',
      `Graph 版本 ${String(input.version)} 高于当前支持的 ${CURRENT_GRAPH_VERSION}`,
      { params: { version: String(input.version), supported: CURRENT_GRAPH_VERSION } },
    );
  } else if (input.version !== CURRENT_GRAPH_VERSION) {
    issue(diagnostics, 'schema.unsupported-version', '$.version', `不支持 Graph 版本 ${String(input.version)}`);
  }
  if (!PASSES.has(input.pass as GraphPassId)) {
    issue(diagnostics, 'schema.pass', '$.pass', 'Graph pass 必须是 image、bufferA-bufferD 或 sound');
  }

  const doc = createEmptyGraph(PASSES.has(input.pass as GraphPassId) ? input.pass as GraphPassId : 'image');
  const ui = record(input.ui);
  const viewport = record(ui?.viewport);
  if (!viewport || !finite(viewport.x) || !finite(viewport.y) || !finite(viewport.zoom) || viewport.zoom <= 0) {
    issue(diagnostics, 'schema.viewport', '$.ui.viewport', 'viewport 必须包含有限 x/y 和大于 0 的 zoom');
  } else {
    doc.ui.viewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  }

  if (!Array.isArray(input.nodes)) {
    issue(diagnostics, 'schema.nodes', '$.nodes', 'nodes 必须是数组');
  } else {
    input.nodes.forEach((raw, index) => {
      const path = `$.nodes[${index}]`;
      const node = record(raw);
      const nodeId = validId(node?.id) ? node.id : undefined;
      if (!node || !nodeId || !validId(node.type) || !Number.isInteger(node.typeVersion) || (node.typeVersion as number) < 1) {
        issue(diagnostics, 'schema.node', path, '节点必须包含有效 id、type 和正整数 typeVersion', nodeId ? { nodeId } : {});
        return;
      }
      const position = record(node.position);
      if (!position || !finite(position.x) || !finite(position.y)) {
        issue(diagnostics, 'schema.position', `${path}.position`, '节点位置必须是有限 x/y', { nodeId });
        return;
      }
      const values = record(node.values);
      if (!values) {
        issue(diagnostics, 'schema.node-values', `${path}.values`, '节点 values 必须是对象', { nodeId });
        return;
      }
      if (!jsonSafeFiniteTree(values)) {
        issue(diagnostics, 'schema.invalid-node-value', `${path}.values`, '节点 values 只能包含有限数值和 JSON 安全值，且不能循环引用', { nodeId });
        return;
      }
      doc.nodes.push({
        id: nodeId,
        type: node.type,
        typeVersion: node.typeVersion as number,
        position: { x: position.x, y: position.y },
        values: { ...values },
      });
    });
  }

  if (!Array.isArray(input.edges)) {
    issue(diagnostics, 'schema.edges', '$.edges', 'edges 必须是数组');
  } else {
    input.edges.forEach((raw, index) => {
      const path = `$.edges[${index}]`;
      const edge = record(raw);
      const from = record(edge?.from);
      const to = record(edge?.to);
      const edgeId = validId(edge?.id) ? edge.id : undefined;
      if (!edge || !edgeId || !validId(from?.nodeId) || !validId(from.socketId) || !validId(to?.nodeId) || !validId(to.socketId)) {
        issue(diagnostics, 'schema.edge', path, '边必须包含有效 id、from 和 to socket 引用', edgeId ? { edgeId } : {});
        return;
      }
      doc.edges.push({
        id: edgeId,
        from: { nodeId: from.nodeId, socketId: from.socketId },
        to: { nodeId: to.nodeId, socketId: to.socketId },
      });
    });
  }

  if (!Array.isArray(input.parameters)) {
    issue(diagnostics, 'schema.parameters', '$.parameters', 'parameters 必须是数组');
  } else {
    input.parameters.forEach((raw, index) => {
      const path = `$.parameters[${index}]`;
      const parameter = record(raw);
      const parameterId = validId(parameter?.id) ? parameter.id : undefined;
      if (!parameter || !parameterId || typeof parameter.name !== 'string' || !isGraphParameterValueType(parameter.valueType)) {
        issue(diagnostics, 'schema.parameter', path, '参数必须包含有效 id、name 和 valueType', parameterId ? { parameterId } : {});
        return;
      }
      const defaultValue = normalizeParameterValue(parameter.valueType, parameter.defaultValue);
      if (defaultValue === null) {
        issue(diagnostics, 'schema.parameter-default', `${path}.defaultValue`, `默认值与 ${parameter.valueType} 不匹配或不是有限值`, { parameterId });
        return;
      }
      const parameterUi = normalizeUi(parameter.ui, `${path}.ui`, diagnostics, parameterId);
      if (parameterUi?.widget === 'color' && !['color3', 'color4', 'vec3', 'vec4'].includes(parameter.valueType)) {
        issue(diagnostics, 'schema.parameter-widget', `${path}.ui.widget`, 'color widget 仅适用于 3/4 分量颜色或向量', { parameterId });
      }
      doc.parameters.push({
        id: parameterId,
        name: parameter.name,
        valueType: parameter.valueType,
        defaultValue,
        ...(parameterUi ? { ui: parameterUi } : {}),
      });
    });
  }

  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, document: migrateGraphDocumentV1(doc), diagnostics: [] };
}
