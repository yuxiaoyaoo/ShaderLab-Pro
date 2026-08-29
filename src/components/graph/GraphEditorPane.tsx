import { Show, type Component } from 'solid-js';
import { formatProductMessage } from '../../productMessageFormatter';
import { t } from '../../i18n';
import type { UnifiedDiagnostic } from '../../diagnostics/model';
import type { GraphCommand } from '../../graph/editor/commands';
import { createSequentialGraphIdFactory, parseGraphClipboard, pasteGraphSelection, serializeGraphSelection } from '../../graph/editor/clipboard';
import { preflightConnection } from '../../graph/editor/connections';
import { graphBounds } from '../../graph/editor/geometry';
import { graphWorkspacePassState, type GraphGroupLocation, type GraphWorkspaceUiDocument } from '../../graph/editor/workspaceState';
import type { GraphDocument, GraphNode, GraphParameter, GraphPoint, GraphSocketRef } from '../../graph/model';
import type { TextureAsset } from '../../graph/assets';
import { isNodeAllowedInPureGroup, isNodeAvailableInPass, type NodeDefinition, type NodeRegistry } from '../../graph/registry';
import GraphBreadcrumbs from './GraphBreadcrumbs';
import GraphCanvas from './GraphCanvas';
import GraphInspector from './GraphInspector';
import GraphPalette from './GraphPalette';

interface Props {
  document: GraphDocument;
  registry: NodeRegistry;
  assets?: readonly TextureAsset[];
  selection: string[];
  diagnostics: UnifiedDiagnostic[];
  status: string;
  stale: boolean;
  revealNodeId?: string;
  workspace: GraphWorkspaceUiDocument;
  editingGroup?: GraphGroupLocation;
  breadcrumbPath?: readonly GraphGroupLocation[];
  titleForGroup?: (location: GraphGroupLocation) => string;
  onNavigateBreadcrumb?: (depth: number) => void;
  onEnterGroup?: (node: GraphNode) => void;
  onCreateGroup?: () => void;
  onWorkspaceChange: (workspace: GraphWorkspaceUiDocument) => void;
  onOpenResources?: () => void;
  onCommand: (command: GraphCommand) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSelection: (ids: string[]) => void;
  onNotify?: (message: string, kind: 'ok' | 'error') => void;
}
let internalClipboard = '';
let idSeed = 0;
const nextId = (kind: string) => `graph-${kind}-${Date.now().toString(36)}-${(++idSeed).toString(36)}`;

const GraphEditorPane: Component<Props> = (props) => {
  const notify = (message: string, kind: 'ok' | 'error' = 'ok') => props.onNotify?.(message, kind);
  const passState = () => graphWorkspacePassState(props.workspace, props.document.pass);
  const patchPassState = (patch: Partial<ReturnType<typeof passState>>) => props.onWorkspaceChange({
    ...props.workspace,
    passes: { ...props.workspace.passes, [props.document.pass]: { ...passState(), ...patch } },
  });
  const placement = () => {
    const view = props.document.ui.viewport;
    return { x: (360 - view.x) / view.zoom, y: (220 - view.y) / view.zoom };
  };
  const addNode = (definition: NodeDefinition, position: GraphPoint) => {
    if (!isNodeAvailableInPass(definition, props.document.pass)) return notify(t('graph.error.unavailablePass', { title: definition.title }), 'error');
    if (props.editingGroup && !isNodeAllowedInPureGroup(definition)) return notify(t('graph.error.notPure', { title: definition.title }), 'error');
    if (definition.output && props.editingGroup) return notify(t('graph.error.outputInGroup'), 'error');
    if (definition.output && props.document.nodes.some((node) => props.registry.get(node.type, node.typeVersion)?.output)) return notify(t('graph.error.singleOutput'), 'error');
    props.onCommand({ type: 'add-node', node: { id: nextId('node'), type: definition.type, typeVersion: definition.version, position, values: { ...definition.defaultValues } } });
  };
  const copy = async () => {
    const text = serializeGraphSelection(props.document, props.selection);
    internalClipboard = text;
    try { await navigator.clipboard.writeText(text); } catch { /* internal clipboard remains available */ }
  };
  const paste = async (duplicate = false) => {
    let text = internalClipboard;
    if (!duplicate) { try { text = await navigator.clipboard.readText() || text; } catch { /* fallback */ } }
    const validation = { registry: props.registry, pass: props.document.pass, insideGroup: !!props.editingGroup };
    const payload = parseGraphClipboard(text, validation);
    if (!payload) return notify(t('graph.error.clipboardEmpty'), 'error');
    const result = pasteGraphSelection(props.document, payload, { ...validation, offset: duplicate ? { x: 28, y: 28 } : { x: 48, y: 48 }, idFactory: createSequentialGraphIdFactory(nextId('paste')) });
    if (!result) return notify(t('graph.error.invalidPaste'), 'error');
    props.onCommand({ type: 'insert-fragment', parameters: result.document.parameters.slice(props.document.parameters.length), nodes: result.document.nodes.slice(props.document.nodes.length), edges: result.document.edges.slice(props.document.edges.length) });
    props.onSelection(result.nodeIds);
  };
  const duplicate = async () => { await copy(); await paste(true); };
  const onConnect = (from: GraphSocketRef, to: GraphSocketRef) => {
    const check = preflightConnection(props.document, from, to, { edgeId: nextId('edge'), registry: props.registry });
    if (!check.ok || !check.edge) return notify(
      check.descriptor ? formatProductMessage(check.descriptor) : t('graph.error.connect'),
      'error',
    );
    props.onCommand({ type: 'connect', edge: check.edge, replaceInput: check.replaceEdgeIds.length > 0 });
  };
  const createFrame = () => {
    const nodes = props.document.nodes.filter((node) => props.selection.includes(node.id));
    const bounds = graphBounds(nodes, props.registry, new Set(passState().collapsedNodeIds));
    if (!bounds) return notify(t('graph.error.selectForFrame'), 'error');
    patchPassState({ frames: [...passState().frames, {
      id: nextId('frame'), title: t('graph.frame.defaultTitle'), nodeIds: nodes.map((node) => node.id), color: '#596780',
      position: { x: bounds.x - 34, y: bounds.y - 64 }, size: { width: bounds.width + 68, height: bounds.height + 98 },
    }] });
  };
  const toggleCollapsed = (nodeId: string) => {
    const ids = new Set(passState().collapsedNodeIds);
    if (ids.has(nodeId)) ids.delete(nodeId); else ids.add(nodeId);
    patchPassState({ collapsedNodeIds: [...ids] });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); }
    const target = event.target as HTMLElement;
    if (target.matches('input,textarea,select,[contenteditable="true"]')) return;
    const mod = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase();
    if (mod && key === 'z') { event.preventDefault(); event.stopPropagation(); event.shiftKey ? props.onRedo() : props.onUndo(); }
    else if (mod && key === 'c') { event.preventDefault(); event.stopPropagation(); void copy(); }
    else if (mod && key === 'v') { event.preventDefault(); event.stopPropagation(); void paste(); }
    else if (mod && key === 'd') { event.preventDefault(); event.stopPropagation(); void duplicate(); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); const deletable = props.selection.filter((id) => props.document.nodes.find((node) => node.id === id)?.type !== 'output.fragment' && props.document.nodes.find((node) => node.id === id)?.type !== 'output.sound'); props.onCommand({ type: 'delete-nodes', nodeIds: deletable }); props.onSelection([]); }
  };
  const parameterPatch = (id: string, patch: Partial<Omit<GraphParameter, 'id'>>) => props.onCommand({ type: 'update-parameter', parameterId: id, patch });
  const statusLabel = () => {
    if (props.status === 'idle') return t('graph.status.idle');
    if (props.status === 'pending') return t('graph.status.pending');
    if (props.status === 'compiling') return t('graph.status.compiling');
    if (props.status === 'stale') return t('graph.status.stale');
    if (props.status === 'ready') return t('graph.status.ready');
    return props.status;
  };
  return <div class="graph-editor-pane" data-graph-keyboard-scope="true" tabindex="0" onKeyDown={onKeyDown}>
    <div class="graph-toolbar">
      <GraphBreadcrumbs passLabel={props.document.pass} path={props.breadcrumbPath ?? []} titleFor={props.titleForGroup ?? ((location) => location.groupId)} onNavigate={(depth) => props.onNavigateBreadcrumb?.(depth)} />
      <button class="btn mini" onClick={props.onOpenResources}>{t('graph.resources')}</button>
      <button class="btn mini" onClick={props.onUndo}>{t('graph.undo')}</button><button class="btn mini" onClick={props.onRedo}>{t('graph.redo')}</button>
      <button class="btn mini" onClick={() => void duplicate()} disabled={!props.selection.length}>{t('graph.duplicate')}</button>
      <button class="btn mini" onClick={createFrame} disabled={!props.selection.length}>{t('graph.frame')}</button>
      <button class="btn mini" onClick={props.onCreateGroup} disabled={!!props.editingGroup || !props.selection.length}>{t('graph.selectionGroup')}</button>
      <span class={`graph-status ${props.stale ? 'stale' : ''}`} aria-live="polite">{statusLabel()}{props.stale ? t('graph.stalePreview') : ''}</span>
    </div>
    <div class="graph-editor-body">
      <GraphPalette open={props.workspace.paletteOpen} pass={props.document.pass} registry={props.registry} allowOutput={!props.editingGroup} hasOutput={props.document.nodes.some((node) => props.registry.get(node.type, node.typeVersion)?.output)} placement={placement} onAdd={addNode} onToggle={() => props.onWorkspaceChange({ ...props.workspace, paletteOpen: !props.workspace.paletteOpen })} />
      <GraphCanvas document={props.document} registry={props.registry} selection={props.selection} diagnostics={props.diagnostics} revealNodeId={props.revealNodeId} collapsedNodeIds={passState().collapsedNodeIds} frames={props.editingGroup ? [] : passState().frames} allowOutputNodes={!props.editingGroup} onSelection={props.onSelection} onMoveNodes={(positions) => props.onCommand({ type: 'move-nodes', positions })} onViewport={(viewport) => props.onCommand({ type: 'set-viewport', viewport })} onConnect={onConnect} onDisconnect={(nodeId, socketId) => props.onCommand({ type: 'disconnect', edgeIds: props.document.edges.filter((edge) => edge.to.nodeId === nodeId && edge.to.socketId === socketId).map((edge) => edge.id) })} onAddNode={addNode} onToggleCollapsed={toggleCollapsed} onEnterGroup={props.onEnterGroup} onRemoveFrame={(id) => patchPassState({ frames: passState().frames.filter((frame) => frame.id !== id) })} onRenameFrame={(id, title) => patchPassState({ frames: passState().frames.map((frame) => frame.id === id ? { ...frame, title } : frame) })} />
      <Show when={props.workspace.inspectorOpen}><GraphInspector document={props.document} registry={props.registry} assets={props.assets} selectedNodeId={props.selection[0]} onSetValue={(nodeId, key, value) => props.onCommand({ type: 'set-node-value', nodeId, key, value })} onAddParameter={(parameter) => props.onCommand({ type: 'add-parameter', parameter })} onUpdateParameter={parameterPatch} onDeleteParameter={(parameterId) => props.onCommand({ type: 'delete-parameter', parameterId })} /></Show>
    </div>
  </div>;
};
export default GraphEditorPane;
