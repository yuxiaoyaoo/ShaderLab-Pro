import { For, type Component } from 'solid-js';
import type { GraphGroupLocation } from '../../graph/editor/workspaceState';
import { t } from '../../i18n';

interface Props {
  passLabel: string;
  path: readonly GraphGroupLocation[];
  titleFor: (location: GraphGroupLocation) => string;
  onNavigate: (depth: number) => void;
}

const GraphBreadcrumbs: Component<Props> = (props) => <nav class="graph-breadcrumbs" aria-label={t('graph.workspace.breadcrumbsAria')}>
  <button onClick={() => props.onNavigate(0)}>{props.passLabel}</button>
  <For each={props.path}>{(location, index) => <><span aria-hidden="true">›</span><button classList={{ active: index() === props.path.length - 1 }} onClick={() => props.onNavigate(index() + 1)}>{props.titleFor(location)}</button></>}</For>
</nav>;

export default GraphBreadcrumbs;
