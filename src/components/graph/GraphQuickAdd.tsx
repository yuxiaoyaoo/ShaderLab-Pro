import { For, createEffect, createMemo, createSignal, type Component } from 'solid-js';
import type { GraphPassId, GraphPoint } from '../../graph/model';
import { isNodeAllowedInPureGroup, isNodeAvailableInPass, type NodeDefinition, type NodeRegistry } from '../../graph/registry';
import { nodeCategoryLabel, t } from '../../i18n';

interface Props {
  pass: GraphPassId;
  registry: NodeRegistry;
  hasOutput: boolean;
  allowOutput?: boolean;
  anchor: GraphPoint;
  screen: GraphPoint;
  onAdd: (definition: NodeDefinition, position: GraphPoint) => void;
  onClose: () => void;
}

const GraphQuickAdd: Component<Props> = (props) => {
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal('');
  const [active, setActive] = createSignal(0);
  const matches = createMemo(() => {
    const search = query().trim().toLowerCase();
    return props.registry.list().filter((definition) => {
      if (!isNodeAvailableInPass(definition, props.pass)) return false;
      if (props.allowOutput === false && !isNodeAllowedInPureGroup(definition)) return false;
      if (definition.output && props.allowOutput === false) return false;
      if (props.hasOutput && definition.output) return false;
      return !search || `${definition.title} ${definition.type} ${definition.category}`.toLowerCase().includes(search);
    }).slice(0, 18);
  });
  createEffect(() => { query(); setActive(0); });
  queueMicrotask(() => input?.focus());
  const choose = (definition: NodeDefinition) => {
    props.onAdd(definition, props.anchor);
    props.onClose();
  };
  return <div class="graph-quick-add" style={{ left: `${props.screen.x}px`, top: `${props.screen.y}px` }} onPointerDown={(event) => event.stopPropagation()}>
    <input ref={input} value={query()} placeholder={t('graph.quickAdd.searchPlaceholder')} aria-label={t('graph.quickAdd.aria')} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); props.onClose(); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(matches().length - 1, value + 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
      else if (event.key === 'Enter' && matches()[active()]) { event.preventDefault(); choose(matches()[active()]); }
    }} />
    <div class="graph-quick-add-list"><For each={matches()} fallback={<p>{t('graph.quickAdd.noMatches')}</p>}>{(definition, index) => <button classList={{ active: index() === active() }} onMouseEnter={() => setActive(index())} onClick={() => choose(definition)}><span>{definition.title}</span><small>{nodeCategoryLabel(definition.category)} · {definition.type}</small></button>}</For></div>
  </div>;
};

export default GraphQuickAdd;
