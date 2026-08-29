import { For, Show, type Component } from 'solid-js';
import { t } from '../../i18n';
import { graphNodeLayout, graphSocketOffset } from '../../graph/editor/geometry';
import type { GraphNode as GraphNodeModel, GraphPoint, GraphValueType } from '../../graph/model';
import type { NodeDefinition, SocketDefinition, SocketType } from '../../graph/registry';

interface Props {
  node: GraphNodeModel;
  definition?: NodeDefinition;
  selected: boolean;
  focused: boolean;
  error: boolean;
  collapsed?: boolean;
  connectionSourceType?: SocketType;
  errorSockets?: ReadonlySet<string>;
  connectedInputSocketIds?: ReadonlySet<string>;
  transient?: GraphPoint;
  onFocus: (nodeId: string) => void;
  onNodeKeyDown: (nodeId: string, event: KeyboardEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onToggleCollapsed: (nodeId: string) => void;
  onEnterGroup?: (node: GraphNodeModel) => void;
  onSocketDown: (nodeId: string, socketId: string, event: PointerEvent) => void;
  onInputSocketDown: (nodeId: string, socketId: string, event: PointerEvent) => void;
  onOutputKeyDown: (nodeId: string, socketId: string, event: KeyboardEvent) => void;
  onInputKeyDown: (nodeId: string, socketId: string, event: KeyboardEvent) => void;
  onSocketDisconnect: (nodeId: string, socketId: string) => void;
}

const TYPE_COLORS: Record<GraphValueType, string> = {
  bool: '#d978a5', int: '#64c6a2', float: '#a8d36f', vec2: '#66b8e8', vec3: '#6f8fe8', vec4: '#9d7de0', color3: '#e6c95e', color4: '#ef9f62', sdf3: '#ef6f79',
};
const CATEGORY_COLORS: Record<string, string> = {
  Output: '#e56f6f', Input: '#568dba', Math: '#6f7fc7', Vector: '#5f9d91', Color: '#a874b8', Layout: '#798494', 'Node Groups': '#d08b4f', 'Custom Functions': '#bf765d', Texture: '#9b7d55', Sound: '#7c76c8',
};

function socketType(socket: SocketDefinition): GraphValueType | undefined {
  if (socket.defaultType) return socket.defaultType;
  return ['numeric', 'vector', 'any-value'].includes(socket.type) ? undefined : socket.type as GraphValueType;
}

function compatible(from: SocketType | undefined, to: SocketDefinition): boolean | undefined {
  if (!from) return undefined;
  if (from === 'any-value' || from === 'numeric' || from === 'vector') return true;
  if (to.type === 'any-value') return true;
  if (to.type === 'numeric') return !['bool', 'int', 'sdf3'].includes(from);
  if (to.type === 'vector') return ['vec2', 'vec3', 'vec4', 'color3', 'color4'].includes(from);
  if (from === to.type) return true;
  if (from === 'float' && ['vec2', 'vec3', 'vec4', 'color3', 'color4'].includes(to.type)) return true;
  return (from === 'vec3' && to.type === 'color3') || (from === 'color3' && to.type === 'vec3') || (from === 'vec4' && to.type === 'color4') || (from === 'color4' && to.type === 'vec4');
}

const GraphNode: Component<Props> = (props) => {
  const label = () => t('graph.nodeLabel', {
    title: props.definition?.title ?? props.node.type,
    inputs: props.definition?.inputs.length ?? 0,
    outputs: props.definition?.outputs.length ?? 0,
    selected: props.selected ? t('graph.nodeSelected') : '',
    error: props.error ? t('graph.nodeError') : '',
  });
  const isGroup = () => props.node.type.startsWith('library.group.');
  const categoryColor = () => CATEGORY_COLORS[props.definition?.category ?? ''] ?? '#637084';
  const layout = () => graphNodeLayout(props.node, props.definition, !!props.collapsed);
  const nodeStyle = () => ({
    transform: `translate(${props.transient?.x ?? props.node.position.x}px, ${props.transient?.y ?? props.node.position.y}px)`,
    '--node-category-color': categoryColor(),
    '--node-width': `${layout().width}px`,
    '--node-height': `${layout().height}px`,
    '--node-header-height': `${layout().headerHeight}px`,
    '--node-socket-row-height': `${layout().socketRowHeight}px`,
    '--node-socket-padding-y': `${layout().socketPaddingY}px`,
  });

  return <article
    class="graph-node"
    classList={{ selected: props.selected, focused: props.focused, error: props.error, output: !!props.definition?.output, collapsed: layout().kind === 'collapsed', reroute: layout().kind === 'reroute', group: isGroup() }}
    style={nodeStyle()}
    data-node-id={props.node.id}
    role="group"
    aria-label={label()}
    tabindex={props.focused ? 0 : -1}
    onFocus={() => props.onFocus(props.node.id)}
    onKeyDown={(event) => { if (event.target === event.currentTarget) props.onNodeKeyDown(props.node.id, event); }}
    onPointerDown={props.onPointerDown}
    onDblClick={(event) => { if (isGroup() && !(event.target as HTMLElement).closest('.graph-socket')) props.onEnterGroup?.(props.node); }}
  >
    <Show when={layout().kind !== 'reroute'}>
      <header><button class="graph-node-collapse" aria-label={props.collapsed ? t('graph.expandNode') : t('graph.collapseNode')} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onToggleCollapsed(props.node.id); }}>{props.collapsed ? '▸' : '▾'}</button><span>{props.definition?.title ?? props.node.type}<small>{props.node.type}</small></span></header>
    </Show>

    <Show when={!layout().compactSockets}>
      <div class="graph-node-sockets">
        <div><For each={props.definition?.inputs ?? []}>{(socket) => {
          const accepts = () => compatible(props.connectionSourceType, socket);
          const color = () => TYPE_COLORS[socketType(socket) ?? 'float'];
          const connected = () => props.connectedInputSocketIds?.has(socket.id) === true;
          return <div class="graph-socket-row input" classList={{ error: props.errorSockets?.has(socket.id), connected: connected(), compatible: accepts() === true, incompatible: accepts() === false }} data-node-id={props.node.id} data-socket-id={socket.id} data-socket-kind="input" title={connected() ? t('graph.inputDisconnectHint') : t('graph.input', { title: socket.title })} onDblClick={(event) => { event.stopPropagation(); if (connected()) props.onSocketDisconnect(props.node.id, socket.id); }}>
            <button class="graph-socket" style={{ '--socket-color': color() }} aria-label={t('graph.inputAria', { title: socket.title, disconnect: connected() ? t('graph.inputDisconnectAria') : '' })} onPointerDown={(event) => { if (!connected()) return; event.stopPropagation(); props.onInputSocketDown(props.node.id, socket.id, event); }} onKeyDown={(event) => props.onInputKeyDown(props.node.id, socket.id, event)} />
            <span>{socket.title}</span>
          </div>;
        }}</For></div>
        <div><For each={props.definition?.outputs ?? []}>{(socket) => <div class="graph-socket-row output" data-node-id={props.node.id} data-socket-id={socket.id} data-socket-kind="output">
          <span>{socket.title}</span>
          <button class="graph-socket" style={{ '--socket-color': TYPE_COLORS[socketType(socket) ?? 'float'] }} aria-label={t('graph.outputAria', { title: socket.title })} onPointerDown={(event) => { event.stopPropagation(); props.onSocketDown(props.node.id, socket.id, event); }} onKeyDown={(event) => props.onOutputKeyDown(props.node.id, socket.id, event)} />
        </div>}</For></div>
      </div>
    </Show>

    <Show when={layout().compactSockets}>
      <div class="graph-node-compact-sockets">
        <For each={props.definition?.inputs ?? []}>{(socket, index) => {
          const accepts = () => compatible(props.connectionSourceType, socket);
          const color = () => TYPE_COLORS[socketType(socket) ?? 'float'];
          const connected = () => props.connectedInputSocketIds?.has(socket.id) === true;
          return <div class="graph-compact-socket input" classList={{ error: props.errorSockets?.has(socket.id), connected: connected(), compatible: accepts() === true, incompatible: accepts() === false }} style={{ '--socket-y': `${graphSocketOffset(layout(), index(), false).y}px` }} data-node-id={props.node.id} data-socket-id={socket.id} data-socket-kind="input" title={connected() ? t('graph.inputDisconnectHint') : t('graph.input', { title: socket.title })} onDblClick={(event) => { event.stopPropagation(); if (connected()) props.onSocketDisconnect(props.node.id, socket.id); }}>
            <button class="graph-socket" style={{ '--socket-color': color() }} aria-label={t('graph.inputAria', { title: socket.title, disconnect: connected() ? t('graph.inputDisconnectAria') : '' })} onPointerDown={(event) => { if (!connected()) return; event.stopPropagation(); props.onInputSocketDown(props.node.id, socket.id, event); }} onKeyDown={(event) => props.onInputKeyDown(props.node.id, socket.id, event)} />
          </div>;
        }}</For>
        <For each={props.definition?.outputs ?? []}>{(socket, index) => <div class="graph-compact-socket output" style={{ '--socket-y': `${graphSocketOffset(layout(), index(), true).y}px` }} data-node-id={props.node.id} data-socket-id={socket.id} data-socket-kind="output" title={t('graph.output', { title: socket.title })}>
          <button class="graph-socket" style={{ '--socket-color': TYPE_COLORS[socketType(socket) ?? 'float'] }} aria-label={t('graph.outputAria', { title: socket.title })} onPointerDown={(event) => { event.stopPropagation(); props.onSocketDown(props.node.id, socket.id, event); }} onKeyDown={(event) => props.onOutputKeyDown(props.node.id, socket.id, event)} />
        </div>}</For>
      </div>
    </Show>

    <Show when={props.error}><span class="graph-node-error" aria-hidden="true">!</span></Show>
  </article>;
};
export default GraphNode;
