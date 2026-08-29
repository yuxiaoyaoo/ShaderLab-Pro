import { ProductError } from '../../productMessage';
import type { GraphPassId, GraphPoint, GraphViewport } from '../model';

export const GRAPH_WORKSPACE_FORMAT = 'shaderlab-graph-workspace' as const;
export const GRAPH_WORKSPACE_VERSION = 1 as const;

export type GraphPreviewDock = 'right' | 'top' | 'bottom' | 'floating' | 'hidden';

export interface GraphFrame {
  id: string;
  title: string;
  position: GraphPoint;
  size: { width: number; height: number };
  nodeIds: string[];
  color: string;
}

export interface GraphWorkspacePassState {
  collapsedNodeIds: string[];
  frames: GraphFrame[];
}

export interface GraphGroupLocation {
  groupId: string;
  version: number;
}

export interface GraphWorkspaceUiDocument {
  format: typeof GRAPH_WORKSPACE_FORMAT;
  version: typeof GRAPH_WORKSPACE_VERSION;
  mode: 'split' | 'fullscreen';
  previewDock: GraphPreviewDock;
  paletteOpen: boolean;
  inspectorOpen: boolean;
  generatedDrawer: { open: boolean; height: number };
  editPath: GraphGroupLocation[];
  groupViewports: Record<string, GraphViewport>;
  passes: Partial<Record<GraphPassId, GraphWorkspacePassState>>;
}

const PASS_IDS: GraphPassId[] = ['image', 'bufferA', 'bufferB', 'bufferC', 'bufferD', 'sound'];
const DOCKS = new Set<GraphPreviewDock>(['right', 'top', 'bottom', 'floating', 'hidden']);
const COLOR = /^#[0-9a-f]{6}$/i;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const finite = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const strings = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
  : [];

function normalizeViewport(value: unknown): GraphViewport {
  const viewport = record(value);
  return {
    x: finite(viewport?.x, 0),
    y: finite(viewport?.y, 0),
    zoom: Math.min(2.5, Math.max(0.15, finite(viewport?.zoom, 1))),
  };
}

function normalizeFrame(value: unknown, index: number): GraphFrame | undefined {
  const frame = record(value);
  const position = record(frame?.position);
  const size = record(frame?.size);
  if (!frame || typeof frame.id !== 'string' || !frame.id || !position || !size) return undefined;
  return {
    id: frame.id,
    title: typeof frame.title === 'string' && frame.title.trim() ? frame.title.trim().slice(0, 96) : `Frame ${index + 1}`,
    position: { x: finite(position.x, 0), y: finite(position.y, 0) },
    size: {
      width: Math.max(220, finite(size.width, 420)),
      height: Math.max(140, finite(size.height, 280)),
    },
    nodeIds: strings(frame.nodeIds),
    color: typeof frame.color === 'string' && COLOR.test(frame.color) ? frame.color : '#596780',
  };
}

export function createGraphWorkspaceUi(): GraphWorkspaceUiDocument {
  return {
    format: GRAPH_WORKSPACE_FORMAT,
    version: GRAPH_WORKSPACE_VERSION,
    mode: 'split',
    previewDock: 'top',
    paletteOpen: true,
    inspectorOpen: true,
    generatedDrawer: { open: false, height: 260 },
    editPath: [],
    groupViewports: {},
    passes: {},
  };
}

export function normalizeGraphWorkspaceUi(value: unknown): GraphWorkspaceUiDocument {
  const root = record(value);
  if (!root || root.format !== GRAPH_WORKSPACE_FORMAT || root.version !== GRAPH_WORKSPACE_VERSION) {
    throw new Error('Graph Workspace UI 格式或版本无效');
  }
  const drawer = record(root.generatedDrawer);
  const rawPasses = record(root.passes) ?? {};
  const passes: GraphWorkspaceUiDocument['passes'] = {};
  for (const pass of PASS_IDS) {
    const raw = record(rawPasses[pass]);
    if (!raw) continue;
    const frames = Array.isArray(raw.frames)
      ? raw.frames.map(normalizeFrame).filter((item): item is GraphFrame => !!item)
      : [];
    if (new Set(frames.map((frame) => frame.id)).size !== frames.length) throw new Error(`${pass} Workspace Frame ID 重复`);
    passes[pass] = { collapsedNodeIds: strings(raw.collapsedNodeIds), frames };
  }
  const rawPath = Array.isArray(root.editPath) ? root.editPath : [];
  const editPath = rawPath.flatMap((item) => {
    const location = record(item);
    return location && typeof location.groupId === 'string' && location.groupId && Number.isInteger(location.version) && Number(location.version) > 0
      ? [{ groupId: location.groupId, version: Number(location.version) }]
      : [];
  });
  const rawViewports = record(root.groupViewports) ?? {};
  const groupViewports = Object.fromEntries(Object.entries(rawViewports).flatMap(([key, viewport]) =>
    key && record(viewport) ? [[key, normalizeViewport(viewport)]] : [],
  ));
  return {
    format: GRAPH_WORKSPACE_FORMAT,
    version: GRAPH_WORKSPACE_VERSION,
    mode: root.mode === 'fullscreen' ? 'fullscreen' : 'split',
    previewDock: typeof root.previewDock === 'string' && DOCKS.has(root.previewDock as GraphPreviewDock)
      ? root.previewDock as GraphPreviewDock
      : 'top',
    paletteOpen: root.paletteOpen !== false,
    inspectorOpen: root.inspectorOpen !== false,
    generatedDrawer: {
      open: drawer?.open === true,
      height: Math.min(640, Math.max(140, finite(drawer?.height, 260))),
    },
    editPath,
    groupViewports,
    passes,
  };
}

export function parseGraphWorkspaceUi(text: string): GraphWorkspaceUiDocument {
  try {
    return normalizeGraphWorkspaceUi(JSON.parse(text) as unknown);
  } catch {
    throw new ProductError({ code: 'graph.workspace-invalid' });
  }
}

export function serializeGraphWorkspaceUi(value: unknown): string {
  return `${JSON.stringify(normalizeGraphWorkspaceUi(value), null, 2)}\n`;
}

export function graphWorkspacePassState(
  document: GraphWorkspaceUiDocument,
  pass: GraphPassId,
): GraphWorkspacePassState {
  return document.passes[pass] ?? { collapsedNodeIds: [], frames: [] };
}

export function graphGroupViewportKey(pass: GraphPassId, groupId: string, version: number): string {
  return `${pass}:${groupId}@${version}`;
}

/** Group semantic history is global; pass-local keys are reserved for viewport and selection only. */
export function graphGroupSemanticKey(groupId: string, version: number): string {
  return `${groupId}@${version}`;
}
