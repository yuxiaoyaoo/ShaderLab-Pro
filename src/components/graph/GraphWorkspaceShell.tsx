import type { Component, JSX } from 'solid-js';
import { t, type TranslationKey } from '../../i18n';
import type { GraphPreviewDock, GraphWorkspaceUiDocument } from '../../graph/editor/workspaceState';

interface Props {
  state: GraphWorkspaceUiDocument;
  onChange: (state: GraphWorkspaceUiDocument) => void;
  children: JSX.Element;
  generatedDrawer?: JSX.Element;
}

const docks: { id: GraphPreviewDock; titleKey: TranslationKey; iconKey?: TranslationKey; icon?: string }[] = [
  { id: 'top', titleKey: 'graph.workspace.dock.top', iconKey: 'graph.workspace.dock.topShort' },
  { id: 'right', titleKey: 'graph.workspace.dock.right', iconKey: 'graph.workspace.dock.rightShort' },
  { id: 'bottom', titleKey: 'graph.workspace.dock.bottom', iconKey: 'graph.workspace.dock.bottomShort' },
  { id: 'floating', titleKey: 'graph.workspace.dock.floating', iconKey: 'graph.workspace.dock.floatingShort' },
  { id: 'hidden', titleKey: 'graph.workspace.dock.hidden', icon: '×' },
];

const GraphWorkspaceShell: Component<Props> = (props) => {
  const patch = (value: Partial<GraphWorkspaceUiDocument>) => props.onChange({ ...props.state, ...value });
  return <div class="graph-workspace-shell" classList={{ fullscreen: props.state.mode === 'fullscreen', 'drawer-open': props.state.generatedDrawer.open }}>
    <div class="graph-workspace-controls">
      <strong>{t('graph.workspace.title')}</strong>
      <button class="btn mini" classList={{ active: props.state.paletteOpen }} aria-expanded={props.state.paletteOpen} title={props.state.paletteOpen ? t('graph.workspace.palette.collapseTitle') : t('graph.workspace.palette.expandTitle')} onClick={() => patch({ paletteOpen: !props.state.paletteOpen })}>{t('graph.workspace.nodes')}</button>
      <button class="btn mini" classList={{ active: props.state.inspectorOpen }} aria-expanded={props.state.inspectorOpen} onClick={() => patch({ inspectorOpen: !props.state.inspectorOpen })}>{t('graph.inspector.title')}</button>
      <span class="graph-workspace-control-spacer" />
      {docks.map((dock) => <button class="btn mini graph-dock-button" classList={{ active: props.state.previewDock === dock.id }} title={t(dock.titleKey)} aria-label={t(dock.titleKey)} onClick={() => patch({ previewDock: dock.id })}>{dock.iconKey ? t(dock.iconKey) : dock.icon}</button>)}
      <button class="btn mini" classList={{ active: props.state.generatedDrawer.open }} onClick={() => patch({ generatedDrawer: { ...props.state.generatedDrawer, open: !props.state.generatedDrawer.open } })}>{t('graph.generated.title')}</button>
      <button class="btn mini" classList={{ active: props.state.mode === 'fullscreen' }} onClick={() => patch({ mode: props.state.mode === 'fullscreen' ? 'split' : 'fullscreen' })}>{props.state.mode === 'fullscreen' ? t('graph.workspace.fullscreen.exit') : t('graph.workspace.fullscreen.enter')}</button>
    </div>
    <div class="graph-workspace-shell-body">{props.children}</div>
    {props.state.generatedDrawer.open ? <aside class="graph-generated-drawer" style={{ height: `${props.state.generatedDrawer.height}px` }}>{props.generatedDrawer}</aside> : null}
  </div>;
};

export default GraphWorkspaceShell;
