import { For, Show, createSignal, type Component } from 'solid-js';
import type { GraphFrame } from '../../graph/editor/workspaceState';
import { t } from '../../i18n';

interface Props {
  frames: readonly GraphFrame[];
  selectedNodeIds: readonly string[];
  onRemove: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

const GraphFrameLayer: Component<Props> = (props) => {
  const [editingId, setEditingId] = createSignal<string>();
  const [title, setTitle] = createSignal('');
  const beginRename = (frame: GraphFrame) => {
    setEditingId(frame.id);
    setTitle(frame.title);
  };
  const finishRename = (frame: GraphFrame, commit: boolean) => {
    if (editingId() !== frame.id) return;
    const next = title().trim();
    setEditingId();
    if (commit && next && next !== frame.title) props.onRename(frame.id, next);
  };

  return <div class="graph-frame-layer">
    <For each={props.frames}>{(frame) => <section class="graph-frame" classList={{ active: frame.nodeIds.some((id) => props.selectedNodeIds.includes(id)) }} style={{ transform: `translate(${frame.position.x}px, ${frame.position.y}px)`, width: `${frame.size.width}px`, height: `${frame.size.height}px`, '--frame-color': frame.color }}>
      <header>
        <Show when={editingId() === frame.id} fallback={<button title={t('graph.frame.renameTitle')} onDblClick={() => beginRename(frame)}>{frame.title}</button>}>
          <input
            class="graph-frame-title-input"
            value={title()}
            maxlength="96"
            autofocus
            aria-label={t('graph.frame.nameAria')}
            onInput={(event) => setTitle(event.currentTarget.value)}
            onBlur={() => finishRename(frame, true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); finishRename(frame, true); }
              else if (event.key === 'Escape') { event.preventDefault(); finishRename(frame, false); }
            }}
          />
        </Show>
        <button title={t('graph.frame.deleteTitle')} aria-label={t('graph.frame.deleteAria', { title: frame.title })} onClick={() => props.onRemove(frame.id)}>×</button>
      </header>
    </section>}</For>
  </div>;
};

export default GraphFrameLayer;
