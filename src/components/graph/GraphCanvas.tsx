import { For, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import type { UnifiedDiagnostic } from '../../diagnostics/model';
import { t } from '../../i18n';
import { blankCanvasPointerSelection, cancelledPointerSelection, nodePointerSelection } from '../../graph/editor/canvasInteractions';
import { activeKeyboardConnectionTarget, beginKeyboardConnection, graphKeyboardIntent, graphNodeActivationIntent, moveKeyboardConnection, nextNodeInDirection, nudgeNodePositions, type KeyboardConnectionState } from '../../graph/editor/keyboard';
import { graphBounds, graphBoundsIntersect, graphNodeBounds, graphSocketPoint, type GraphNodeBounds } from '../../graph/editor/geometry';
import type { GraphFrame } from '../../graph/editor/workspaceState';
import type { GraphDocument, GraphNode as GraphNodeModel, GraphPoint, GraphSocketRef, GraphViewport } from '../../graph/model';
import type { NodeDefinition, NodeRegistry, SocketType } from '../../graph/registry';
import GraphEdgeLayer from './GraphEdgeLayer';
import GraphFrameLayer from './GraphFrameLayer';
import GraphNode from './GraphNode';
import GraphQuickAdd from './GraphQuickAdd';

interface Props {
  document: GraphDocument;
  registry: NodeRegistry;
  selection: string[];
  diagnostics: UnifiedDiagnostic[];
  revealNodeId?: string;
  collapsedNodeIds?: readonly string[];
  frames?: readonly GraphFrame[];
  allowOutputNodes?: boolean;
  onSelection: (ids: string[]) => void;
  onMoveNodes: (positions: Record<string, GraphPoint>) => void;
  onViewport: (viewport: GraphViewport) => void;
  onConnect: (from: GraphSocketRef, to: GraphSocketRef) => void;
  onDisconnect: (nodeId: string, socketId: string) => void;
  onAddNode: (definition: NodeDefinition, position: GraphPoint) => void;
  onToggleCollapsed: (nodeId: string) => void;
  onEnterGroup?: (node: GraphNodeModel) => void;
  onRemoveFrame: (id: string) => void;
  onRenameFrame: (id: string, title: string) => void;
}
interface DragState { pointerId: number; start: GraphPoint; positions: Record<string, GraphPoint>; selectionBefore: string[] }
interface PanState { pointerId: number; start: GraphPoint; viewport: GraphViewport }
interface BoxState { pointerId: number; start: GraphPoint; current: GraphPoint; additive: boolean; selectionBefore: string[] }
interface ConnectState { pointerId: number; from: GraphSocketRef; point: GraphPoint; pointer: GraphPoint }
interface InputDisconnectState {
  pointerId: number;
  to: GraphSocketRef;
  startClient: GraphPoint;
  pointer: GraphPoint;
  armed: boolean;
}
interface PointerSample { pointerId: number; clientX: number; clientY: number }
interface QuickAddState { anchor: GraphPoint; screen: GraphPoint }

const INPUT_DISCONNECT_THRESHOLD_PX = 18;

const GraphCanvas: Component<Props> = (props) => {
  let root!: HTMLDivElement;
  const [drag, setDrag] = createSignal<DragState>();
  const [pan, setPan] = createSignal<PanState>();
  const [box, setBox] = createSignal<BoxState>();
  const [transient, setTransient] = createSignal<Record<string, GraphPoint>>({});
  const [viewportPreview, setViewportPreview] = createSignal<GraphViewport>();
  const [connecting, setConnecting] = createSignal<ConnectState>();
  const [disconnecting, setDisconnecting] = createSignal<InputDisconnectState>();
  const [keyboardConnection, setKeyboardConnection] = createSignal<KeyboardConnectionState>();
  const [focusedNodeId, setFocusedNodeId] = createSignal<string>();
  const [canvasSize, setCanvasSize] = createSignal({ width: 1, height: 1 });
  const [quickAdd, setQuickAdd] = createSignal<QuickAddState>();
  let pointerFrame = 0;
  let pendingPointer: PointerSample | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const viewport = () => viewportPreview() ?? props.document.ui.viewport;
  const focusKeyboardScope = () => root.focus({ preventScroll: true });
  const summary = () => t('graph.canvasSummary', { nodes: props.document.nodes.length, edges: props.document.edges.length });
  const errors = createMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const item of props.diagnostics) {
      if (item.origin.kind !== 'graph' || !item.origin.nodeId) continue;
      const sockets = map.get(item.origin.nodeId) ?? new Set<string>();
      if (item.origin.socketId) sockets.add(item.origin.socketId);
      map.set(item.origin.nodeId, sockets);
    }
    return map;
  });
  const collapsedNodeIds = createMemo(() => new Set(props.collapsedNodeIds ?? []));
  const connectedInputsByNode = createMemo(() => {
    const connected = new Map<string, Set<string>>();
    for (const edge of props.document.edges) {
      const sockets = connected.get(edge.to.nodeId) ?? new Set<string>();
      sockets.add(edge.to.socketId);
      connected.set(edge.to.nodeId, sockets);
    }
    return connected;
  });
  const visibleRect = createMemo<GraphNodeBounds>(() => {
    const view = viewport();
    const size = canvasSize();
    const overscan = 320 / view.zoom;
    return {
      x: -view.x / view.zoom - overscan,
      y: -view.y / view.zoom - overscan,
      width: size.width / view.zoom + overscan * 2,
      height: size.height / view.zoom + overscan * 2,
    };
  });
  const visibleNodes = createMemo(() => props.document.nodes.filter((node) => {
    const position = transient()[node.id];
    return graphBoundsIntersect(graphNodeBounds(node, props.registry, collapsedNodeIds().has(node.id), position), visibleRect());
  }));
  const screenToGraph = (clientX: number, clientY: number): GraphPoint => {
    const rect = root.getBoundingClientRect(); const view = viewport();
    return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
  };
  const canvasCenter = () => {
    const rect = root.getBoundingClientRect();
    return { anchor: screenToGraph(rect.left + rect.width / 2, rect.top + rect.height / 2), screen: { x: rect.width / 2, y: rect.height / 2 } };
  };
  const openQuickAdd = (clientX?: number, clientY?: number) => {
    const rect = root.getBoundingClientRect();
    if (clientX === undefined || clientY === undefined) return setQuickAdd(canvasCenter());
    const width = 300; const height = 390;
    setQuickAdd({
      anchor: screenToGraph(clientX, clientY),
      screen: { x: Math.max(8, Math.min(rect.width - width - 8, clientX - rect.left)), y: Math.max(8, Math.min(rect.height - height - 8, clientY - rect.top)) },
    });
  };
  const focusNode = (id: string) => {
    setFocusedNodeId(id); props.onSelection([id]);
    queueMicrotask(() => [...root.querySelectorAll<HTMLElement>('.graph-node')].find((node) => node.dataset.nodeId === id)?.focus({ preventScroll: true }));
  };
  const focusKeyboardTarget = (state: KeyboardConnectionState) => {
    const target = activeKeyboardConnectionTarget(state); if (!target) return;
    queueMicrotask(() => [...root.querySelectorAll<HTMLButtonElement>('[data-socket-kind="input"] .graph-socket')].find((button) => button.parentElement?.dataset.nodeId === target.nodeId && button.parentElement?.dataset.socketId === target.socketId)?.focus({ preventScroll: true }));
  };
  const fitAll = () => {
    const bounds = graphBounds(props.document.nodes, props.registry, collapsedNodeIds()); if (!bounds) return;
    const rect = root.getBoundingClientRect();
    const zoom = Math.min(1.5, Math.max(0.15, Math.min((rect.width - 80) / Math.max(1, bounds.width), (rect.height - 80) / Math.max(1, bounds.height))));
    props.onViewport({ zoom, x: rect.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: rect.height / 2 - (bounds.y + bounds.height / 2) * zoom });
  };
  const zoomBy = (factor: number) => {
    const rect = root.getBoundingClientRect(); const old = viewport(); const zoom = Math.min(2.5, Math.max(0.15, old.zoom * factor));
    props.onViewport({ zoom, x: rect.width / 2 - ((rect.width / 2 - old.x) / old.zoom) * zoom, y: rect.height / 2 - ((rect.height / 2 - old.y) / old.zoom) * zoom });
  };
  const connectingType = (): SocketType | undefined => {
    const from = connecting()?.from ?? keyboardConnection()?.from;
    const node = from && props.document.nodes.find((item) => item.id === from.nodeId);
    return node ? props.registry.get(node.type, node.typeVersion)?.outputs.find((socket) => socket.id === from!.socketId)?.type : undefined;
  };

  onMount(() => {
    resizeObserver = new ResizeObserver(([entry]) => setCanvasSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }));
    resizeObserver.observe(root);
    const rect = root.getBoundingClientRect();
    setCanvasSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
  });
  createEffect(() => {
    const id = props.revealNodeId; if (!id || !root) return;
    const node = props.document.nodes.find((item) => item.id === id); if (!node) return;
    const rect = root.getBoundingClientRect(); const view = viewport(); const bounds = graphNodeBounds(node, props.registry, collapsedNodeIds().has(node.id));
    props.onViewport({ ...view, x: rect.width / 2 - (bounds.x + bounds.width / 2) * view.zoom, y: rect.height / 2 - (bounds.y + bounds.height / 2) * view.zoom });
    focusNode(id);
  });
  createEffect(() => {
    const nodes = props.document.nodes;
    if (focusedNodeId() && nodes.some((node) => node.id === focusedNodeId())) return;
    setFocusedNodeId(props.selection.find((id) => nodes.some((node) => node.id === id)) ?? nodes[0]?.id);
  });

  const capturePointer = (pointerId: number) => { try { root.setPointerCapture(pointerId); } catch { /* synthetic pointer or detached target */ } };
  const onNodeDown = (nodeId: string, event: PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.graph-socket,.graph-node-collapse')) return;
    event.stopPropagation(); setFocusedNodeId(nodeId); setQuickAdd(); focusKeyboardScope();
    const next = nodePointerSelection(props.selection, nodeId, event.ctrlKey || event.metaKey || event.shiftKey); props.onSelection(next.selection);
    const positions = Object.fromEntries(props.document.nodes.filter((node) => next.dragNodeIds.includes(node.id)).map((node) => [node.id, { ...node.position }]));
    setDrag({ pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, positions, selectionBefore: next.selectionBefore }); capturePointer(event.pointerId);
  };
  const onSocketDown = (nodeId: string, socketId: string, event: PointerEvent) => {
    if (event.button !== 0) return; focusKeyboardScope(); setQuickAdd();
    const node = props.document.nodes.find((item) => item.id === nodeId);
    const position = node ? graphSocketPoint(node, socketId, true, props.registry, node.position, collapsedNodeIds().has(node.id)) : { x: 0, y: 0 };
    setConnecting({ pointerId: event.pointerId, from: { nodeId, socketId }, point: position, pointer: screenToGraph(event.clientX, event.clientY) }); capturePointer(event.pointerId);
  };
  const onInputSocketDown = (nodeId: string, socketId: string, event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    focusKeyboardScope();
    setQuickAdd();
    setDisconnecting({
      pointerId: event.pointerId,
      to: { nodeId, socketId },
      startClient: { x: event.clientX, y: event.clientY },
      pointer: screenToGraph(event.clientX, event.clientY),
      armed: false,
    });
    capturePointer(event.pointerId);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.target !== root && !(event.target as HTMLElement).classList.contains('graph-grid')) return;
    setQuickAdd();
    if (event.button === 0) focusKeyboardScope();
    if (event.button === 1 || event.button === 2 || event.altKey) setPan({ pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, viewport: { ...viewport() } });
    else if (event.button === 0) { const additive = event.ctrlKey || event.metaKey || event.shiftKey; const selection = blankCanvasPointerSelection(props.selection, additive); props.onSelection(selection.selection); setBox({ pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, current: { x: event.clientX, y: event.clientY }, additive, selectionBefore: selection.selectionBefore }); }
    else return;
    capturePointer(event.pointerId);
  };
  const applyPointerMove = (event: PointerSample) => {
    const moving = drag();
    if (moving?.pointerId === event.pointerId) { const dx = (event.clientX - moving.start.x) / viewport().zoom; const dy = (event.clientY - moving.start.y) / viewport().zoom; setTransient(Object.fromEntries(Object.entries(moving.positions).map(([id, point]) => [id, { x: Math.round((point.x + dx) / 8) * 8, y: Math.round((point.y + dy) / 8) * 8 }]))); return; }
    const panning = pan(); if (panning?.pointerId === event.pointerId) { setViewportPreview({ ...panning.viewport, x: panning.viewport.x + event.clientX - panning.start.x, y: panning.viewport.y + event.clientY - panning.start.y }); return; }
    const selecting = box(); if (selecting?.pointerId === event.pointerId) { setBox({ ...selecting, current: { x: event.clientX, y: event.clientY } }); return; }
    const disconnect = disconnecting();
    if (disconnect?.pointerId === event.pointerId) {
      setDisconnecting({
        ...disconnect,
        pointer: screenToGraph(event.clientX, event.clientY),
        armed: disconnect.startClient.x - event.clientX >= INPUT_DISCONNECT_THRESHOLD_PX,
      });
      return;
    }
    const wire = connecting(); if (wire?.pointerId === event.pointerId) setConnecting({ ...wire, pointer: screenToGraph(event.clientX, event.clientY) });
  };
  const onPointerMove = (event: PointerEvent) => {
    pendingPointer = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    if (!pointerFrame) pointerFrame = requestAnimationFrame(() => { pointerFrame = 0; const sample = pendingPointer; pendingPointer = undefined; if (sample) applyPointerMove(sample); });
  };
  const releasePointer = (pointerId: number) => { try { root.releasePointerCapture(pointerId); } catch { /* already released */ } };
  const flushPointer = () => { if (pointerFrame) cancelAnimationFrame(pointerFrame); pointerFrame = 0; const sample = pendingPointer; pendingPointer = undefined; if (sample) applyPointerMove(sample); };
  const onPointerUp = (event: PointerEvent) => {
    flushPointer();
    const moving = drag(); if (moving?.pointerId === event.pointerId) { const positions = transient(); if (Object.keys(positions).length) props.onMoveNodes(positions); setDrag(); setTransient({}); }
    const panning = pan(); if (panning?.pointerId === event.pointerId) { const view = viewportPreview(); if (view) props.onViewport(view); setPan(); setViewportPreview(); }
    const selecting = box(); if (selecting?.pointerId === event.pointerId) { const a = screenToGraph(selecting.start.x, selecting.start.y); const b = screenToGraph(event.clientX, event.clientY); const selectionBounds = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }; const hits = props.document.nodes.filter((node) => graphBoundsIntersect(graphNodeBounds(node, props.registry, collapsedNodeIds().has(node.id)), selectionBounds)).map((node) => node.id); props.onSelection(selecting.additive ? [...new Set([...props.selection, ...hits])] : hits); setBox(); }
    const disconnect = disconnecting();
    if (disconnect?.pointerId === event.pointerId) {
      const shouldDisconnect = disconnect.startClient.x - event.clientX >= INPUT_DISCONNECT_THRESHOLD_PX;
      setDisconnecting();
      if (shouldDisconnect) props.onDisconnect(disconnect.to.nodeId, disconnect.to.socketId);
    }
    const wire = connecting(); if (wire?.pointerId === event.pointerId) { const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-socket-kind="input"]'); if (target?.dataset.nodeId && target.dataset.socketId && !target.classList.contains('incompatible')) props.onConnect(wire.from, { nodeId: target.dataset.nodeId, socketId: target.dataset.socketId }); setConnecting(); }
    releasePointer(event.pointerId);
  };
  const cancelPointer = (event: PointerEvent) => {
    const moving = drag(); if (moving?.pointerId === event.pointerId) { props.onSelection(cancelledPointerSelection(moving.selectionBefore)); setDrag(); setTransient({}); }
    if (pan()?.pointerId === event.pointerId) { setPan(); setViewportPreview(); }
    const selecting = box(); if (selecting?.pointerId === event.pointerId) { props.onSelection(cancelledPointerSelection(selecting.selectionBefore)); setBox(); }
    if (disconnecting()?.pointerId === event.pointerId) setDisconnecting();
    if (connecting()?.pointerId === event.pointerId) setConnecting(); releasePointer(event.pointerId);
  };
  const onWheel = (event: WheelEvent) => { event.preventDefault(); const old = viewport(); const rect = root.getBoundingClientRect(); const anchor = { x: (event.clientX - rect.left - old.x) / old.zoom, y: (event.clientY - rect.top - old.y) / old.zoom }; const zoom = Math.min(2.5, Math.max(0.15, old.zoom * Math.exp(-event.deltaY * 0.001))); props.onViewport({ zoom, x: event.clientX - rect.left - anchor.x * zoom, y: event.clientY - rect.top - anchor.y * zoom }); };

  const onNodeKeyDown = (nodeId: string, event: KeyboardEvent) => {
    if (event.code === 'Space') event.preventDefault();
    const direction = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const)[event.key];
    if (direction) { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) { const selection = props.selection.includes(nodeId) ? props.selection : [nodeId]; props.onSelection(selection); props.onMoveNodes(nudgeNodePositions(props.document, selection, direction, 16)); } else { const next = nextNodeInDirection(props.document.nodes, nodeId, direction); if (next) focusNode(next); } return; }
    if (graphNodeActivationIntent(event.key, event.code) === 'connect') { event.preventDefault(); event.stopPropagation(); props.onSelection([nodeId]); const node = props.document.nodes.find((item) => item.id === nodeId); const output = node && props.registry.get(node.type, node.typeVersion)?.outputs[0]; if (output) startKeyboardConnection({ nodeId, socketId: output.id }); }
  };
  const startKeyboardConnection = (from: GraphSocketRef) => { const state = beginKeyboardConnection(props.document, from, props.registry); if (!state) return; setKeyboardConnection(state); focusKeyboardTarget(state); };
  const onOutputKeyDown = (nodeId: string, socketId: string, event: KeyboardEvent) => { if (event.key !== 'Enter' && event.code !== 'Space') return; event.preventDefault(); event.stopPropagation(); startKeyboardConnection({ nodeId, socketId }); };
  const onInputKeyDown = (nodeId: string, socketId: string, event: KeyboardEvent) => {
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); props.onDisconnect(nodeId, socketId); return; }
    const state = keyboardConnection(); if (!state) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setKeyboardConnection(); focusNode(state.from.nodeId); return; }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); const focused = { nodeId, socketId }; if (state.compatibleInputs.some((item) => item.nodeId === nodeId && item.socketId === socketId)) props.onConnect(state.from, focused); setKeyboardConnection(); focusNode(nodeId); return; }
    if (event.key === 'Tab' || event.key.startsWith('Arrow')) { event.preventDefault(); event.stopPropagation(); const next = moveKeyboardConnection(state, event.shiftKey || event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1); setKeyboardConnection(next); focusKeyboardTarget(next); }
  };
  const onCanvasKeyDown = (event: KeyboardEvent) => {
    if (event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); openQuickAdd(); return; }
    if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); }
    const intent = graphKeyboardIntent(event.key, event.shiftKey);
    if (intent === 'fit') { event.preventDefault(); event.stopPropagation(); fitAll(); }
    else if (intent === 'zoom-in') { event.preventDefault(); event.stopPropagation(); zoomBy(1.15); }
    else if (intent === 'zoom-out') { event.preventDefault(); event.stopPropagation(); zoomBy(1 / 1.15); }
    else if (intent === 'cancel' && keyboardConnection()) { event.preventDefault(); event.stopPropagation(); const from = keyboardConnection()!.from.nodeId; setKeyboardConnection(); focusNode(from); }
    else if (intent === 'cancel' && quickAdd()) { event.preventDefault(); setQuickAdd(); }
  };

  onCleanup(() => { resizeObserver?.disconnect(); setConnecting(); setDisconnecting(); if (pointerFrame) cancelAnimationFrame(pointerFrame); });
  const boxStyle = () => { const value = box(); if (!value || !root) return {}; const rect = root.getBoundingClientRect(); return { left: `${Math.min(value.start.x, value.current.x) - rect.left}px`, top: `${Math.min(value.start.y, value.current.y) - rect.top}px`, width: `${Math.abs(value.current.x - value.start.x)}px`, height: `${Math.abs(value.current.y - value.start.y)}px` }; };
  const gridStyle = () => { const view = viewport(); const size = Math.max(4, 22 * view.zoom); return { 'background-position': `${view.x % size}px ${view.y % size}px`, 'background-size': `${size}px ${size}px` }; };

  return <div class="graph-canvas" style={gridStyle()} ref={root} role="application" aria-label={t('graph.canvasAria')} aria-describedby="graph-canvas-summary" tabindex="0" onKeyDown={onCanvasKeyDown} onContextMenu={(event) => { event.preventDefault(); if (!(event.target as HTMLElement).closest('.graph-node')) openQuickAdd(event.clientX, event.clientY); }} onDblClick={(event) => { if (event.target === root || (event.target as HTMLElement).classList.contains('graph-grid')) openQuickAdd(event.clientX, event.clientY); }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer} onWheel={onWheel}>
    <div class="graph-canvas-tools"><button class="btn mini" onClick={fitAll}>{t('graph.fitAll')}</button><span>{t('graph.canvasStats', { visible: visibleNodes().length, total: props.document.nodes.length, zoom: Math.round(viewport().zoom * 100) })}</span></div>
    <div class="graph-grid" style={{ transform: `translate(${viewport().x}px, ${viewport().y}px) scale(${viewport().zoom})` }}>
      <GraphFrameLayer frames={props.frames ?? []} selectedNodeIds={props.selection} onRemove={props.onRemoveFrame} onRename={props.onRenameFrame} />
      <GraphEdgeLayer document={props.document} registry={props.registry} visibleRect={visibleRect()} collapsedNodeIds={collapsedNodeIds()} transientPositions={transient()} connectingFrom={connecting()?.point} pointer={connecting()?.pointer} disconnectingTo={disconnecting()?.to} disconnectPointer={disconnecting()?.pointer} disconnectArmed={disconnecting()?.armed} />
      <For each={visibleNodes()}>{(node) => <GraphNode node={node} definition={props.registry.get(node.type, node.typeVersion)} selected={props.selection.includes(node.id)} focused={focusedNodeId() === node.id} error={errors().has(node.id)} errorSockets={errors().get(node.id)} connectedInputSocketIds={connectedInputsByNode().get(node.id)} collapsed={collapsedNodeIds().has(node.id)} connectionSourceType={connectingType()} transient={transient()[node.id]} onFocus={(id) => { setFocusedNodeId(id); props.onSelection([id]); }} onNodeKeyDown={onNodeKeyDown} onPointerDown={(event) => onNodeDown(node.id, event)} onToggleCollapsed={props.onToggleCollapsed} onEnterGroup={props.onEnterGroup} onSocketDown={onSocketDown} onInputSocketDown={onInputSocketDown} onOutputKeyDown={onOutputKeyDown} onInputKeyDown={onInputKeyDown} onSocketDisconnect={props.onDisconnect} />}</For>
    </div>
    {box() && <div class="graph-selection-box" style={boxStyle()} />}
    {quickAdd() ? <GraphQuickAdd pass={props.document.pass} registry={props.registry} allowOutput={props.allowOutputNodes} hasOutput={props.document.nodes.some((node) => props.registry.get(node.type, node.typeVersion)?.output)} anchor={quickAdd()!.anchor} screen={quickAdd()!.screen} onAdd={props.onAddNode} onClose={() => { setQuickAdd(); focusKeyboardScope(); }} /> : null}
    <span id="graph-canvas-summary" class="sr-only">{summary()}</span>
    <span class="sr-only" aria-live="polite">{keyboardConnection() ? t('graph.keyboardConnect', { count: keyboardConnection()!.compatibleInputs.length }) : ''}</span>
  </div>;
};
export default GraphCanvas;
