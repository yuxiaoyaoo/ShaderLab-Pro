import { For, Show, createMemo, createSignal, type Component } from 'solid-js';
import { nodeCategoryLabel, t } from '../../i18n';
import type { GraphPassId, GraphPoint } from '../../graph/model';
import { isNodeAllowedInPureGroup, isNodeAvailableInPass, type NodeDefinition, type NodeRegistry } from '../../graph/registry';

interface Props {
  hasOutput: boolean;
  allowOutput?: boolean;
  pass: GraphPassId;
  registry: NodeRegistry;
  open: boolean;
  placement: () => GraphPoint;
  onAdd: (definition: NodeDefinition, position: GraphPoint) => void;
  onToggle: () => void;
}

const GraphPalette: Component<Props> = (props) => {
  const [query, setQuery] = createSignal('');
  const [collapsedCategories, setCollapsedCategories] = createSignal<ReadonlySet<string>>(new Set());
  const availableDefinitions = createMemo(() => props.registry.list().filter((definition) => {
    if (!isNodeAvailableInPass(definition, props.pass)) return false;
    if (props.allowOutput === false && !isNodeAllowedInPureGroup(definition)) return false;
    if (definition.output && props.allowOutput === false) return false;
    if (props.hasOutput && definition.output) return false;
    return true;
  }));
  const groups = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const filtered = availableDefinitions().filter((definition) =>
      `${definition.title} ${definition.type} ${definition.category}`.toLowerCase().includes(needle),
    );
    const map = new Map<string, NodeDefinition[]>();
    for (const definition of filtered) map.set(definition.category, [...(map.get(definition.category) ?? []), definition]);
    return [...map.entries()];
  });
  const categoryOpen = (category: string) => !!query().trim() || !collapsedCategories().has(category);
  const toggleCategory = (category: string) => {
    const next = new Set(collapsedCategories());
    if (next.has(category)) next.delete(category); else next.add(category);
    setCollapsedCategories(next);
  };

  return <aside class="graph-palette" classList={{ collapsed: !props.open }} aria-label={t('graph.palette')}>
    <div class="graph-palette-head">
      <Show when={props.open}>
        <input value={query()} placeholder={t('graph.search')} aria-label={t('graph.searchAria')} onInput={(event) => setQuery(event.currentTarget.value)} />
      </Show>
      <button
        class="graph-palette-toggle"
        aria-label={props.open ? t('graph.collapsePalette') : t('graph.expandPalette')}
        aria-expanded={props.open}
        title={props.open ? t('graph.collapsePalette') : t('graph.expandPalette')}
        onClick={props.onToggle}
      >{props.open ? '‹' : '›'}</button>
    </div>
    <Show when={props.open}>
      <div
        class="graph-palette-count"
        title={t('graph.countSummaryTitle', { available: availableDefinitions().length, total: props.registry.size })}
      >
        {t('graph.countSummary', { available: availableDefinitions().length, total: props.registry.size })}
      </div>
      <div class="graph-palette-list">
        <Show when={groups().length > 0} fallback={<p class="graph-palette-empty">{t('graph.noMatches')}</p>}>
          <For each={groups()}>{([category, definitions]) => <section>
            <button
              class="graph-palette-category"
              aria-expanded={categoryOpen(category)}
              onClick={() => toggleCategory(category)}
            >
              <span class="graph-palette-category-chevron">{categoryOpen(category) ? '▾' : '▸'}</span>
              <span>{nodeCategoryLabel(category)}</span>
              <small>{definitions.length}</small>
            </button>
            <Show when={categoryOpen(category)}>
              <div class="graph-palette-node-list">
                <For each={definitions}>{(definition) => <button onClick={() => props.onAdd(definition, props.placement())}>{definition.title}<small>{definition.type}</small></button>}</For>
              </div>
            </Show>
          </section>}</For>
        </Show>
      </div>
    </Show>
  </aside>;
};
export default GraphPalette;
