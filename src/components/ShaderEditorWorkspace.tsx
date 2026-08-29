import { For, Show, Suspense, lazy, type Component } from 'solid-js';
import type * as monaco from 'monaco-editor';
import type { ExportTicket } from '../export/exportEligibility';
import type { ProductMessageDescriptor } from '../productMessage';
import type { UnifiedDiagnostic } from '../diagnostics/model';
import type { GraphCommand } from '../graph/editor/commands';
import type { GraphGroupLocation, GraphWorkspaceUiDocument } from '../graph/editor/workspaceState';
import type { TextureAsset } from '../graph/assets';
import type { NodeRegistry } from '../graph/registry';
import type { GraphDocument, GraphNode } from '../graph/model';
import { t } from '../i18n';
import type { ProjectSources } from '../project/types';
import type { MappedDiag } from './DiagnosticsPane';
import EditorPane, { type TabDef } from './EditorPane';

const GeneratedCodePane = lazy(() => import('./graph/GeneratedCodePane'));
const GraphEditorPane = lazy(() => import('./graph/GraphEditorPane'));
const GraphWorkspaceShell = lazy(() => import('./graph/GraphWorkspaceShell'));

interface Props {
  sources: () => ProjectSources;
  effectiveSources: () => ProjectSources;
  shadertoyJson: () => string;
  tabs: TabDef[];
  activeTab: string;
  onSourceChange: (id: string, value: string) => void;
  onTabChange: (id: string) => void;
  codeDiagnostics: MappedDiag[];
  onEditorReady?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  onNotify?: (message: string, kind: 'ok' | 'error') => void;
  projectName?: string;
  activeAuthoring: 'code' | 'graph';
  canCreateGraph: boolean;
  graphDocument?: GraphDocument;
  graphRegistry: NodeRegistry;
  graphAssets?: readonly TextureAsset[];
  graphSelection: string[];
  graphDiagnostics: UnifiedDiagnostic[];
  graphStatus: string;
  graphStale: boolean;
  graphFallbackIssue?: string;
  graphWorkspace: GraphWorkspaceUiDocument;
  graphEditingGroup?: GraphGroupLocation;
  graphBreadcrumbPath?: readonly GraphGroupLocation[];
  graphGroupTitle?: (location: GraphGroupLocation) => string;
  generatedSource: string;
  generatedSourceAccepted: boolean;
  revealNodeId?: string;
  onCreateGraph: () => void;
  onDetachGraph: () => void;
  onDetachFallback: () => void;
  onExportGeneratedFragment: () => void;
  onExportGraphJson: () => void;
  canDetach: boolean;
  canExport: boolean;
  exportBlockedReason?: ProductMessageDescriptor;
  captureExportTicket?: () => ExportTicket | undefined;
  canExportShadertoy?: boolean;
  shadertoyExportBlockedReason?: ProductMessageDescriptor;
  captureShadertoyExportTicket?: () => ExportTicket | undefined;
  validateExportTicket?: (ticket: ExportTicket) => ProductMessageDescriptor | undefined;
  onGraphWorkspaceChange: (workspace: GraphWorkspaceUiDocument) => void;
  onGraphCommand: (command: GraphCommand) => void;
  onGraphUndo: () => void;
  onGraphRedo: () => void;
  onGraphSelection: (ids: string[]) => void;
  onCreateNodeGroup?: () => void;
  onEnterNodeGroup?: (node: GraphNode) => void;
  onNavigateGroupBreadcrumb?: (depth: number) => void;
  onOpenGraphResources?: () => void;
}

const ShaderEditorWorkspace: Component<Props> = (props) => {
  const graphActive = () => props.canCreateGraph && props.activeAuthoring === 'graph' && !!props.graphDocument;
  const fallbackActive = () => props.canCreateGraph && props.activeAuthoring === 'graph' && !props.graphDocument;

  const copyGenerated = async () => {
    try {
      await navigator.clipboard.writeText(props.generatedSource);
      props.onNotify?.(
        fallbackActive()
          ? t('graph.workspace.copy.recovery')
          : props.graphStale
            ? props.generatedSourceAccepted
              ? t('graph.workspace.copy.acceptedStale')
              : t('graph.workspace.copy.unaccepted')
            : t('graph.workspace.copy.success'),
        'ok',
      );
    } catch {
      props.onNotify?.(t('graph.workspace.copy.failed'), 'error');
    }
  };

  const passTabs = () => <For each={props.tabs}>{(tab) => <button classList={{ active: props.activeTab === tab.id }} onClick={() => props.onTabChange(tab.id)}>{tab.label}</button>}</For>;
  const generatedPane = () => <GeneratedCodePane source={props.generatedSource} stale={props.graphStale} onCopy={() => void copyGenerated()} canExportFragment={props.canExport && props.generatedSourceAccepted} exportBlockedReason={!props.canExport ? props.exportBlockedReason : undefined} onExportFragment={props.onExportGeneratedFragment} onExportGraph={props.onExportGraphJson} />;

  return <div class="shader-editor-workspace">
    <Suspense fallback={<div class="feature-loading" role="status">{t('common.loading')}</div>}>
      <Show when={graphActive()} fallback={
      <Show when={fallbackActive()} fallback={<>
        <div class="authoring-bar"><span>{props.canCreateGraph ? t('graph.workspace.authoring', { tab: props.activeTab }) : t('graph.workspace.codePass')}</span><Show when={props.canCreateGraph && props.activeAuthoring === 'code'}><button class="btn mini primary" title={t('graph.workspace.createGraphTitle')} onClick={props.onCreateGraph}>{t('graph.workspace.createGraph')}</button><small>{t('graph.workspace.createGraphHint')}</small></Show></div>
        <EditorPane sources={props.sources} effectiveSources={props.effectiveSources} shadertoyJson={props.shadertoyJson} onSourceChange={props.onSourceChange} diagnostics={props.codeDiagnostics} onEditorReady={props.onEditorReady} tabs={props.tabs} activeTab={props.activeTab} onTabChange={props.onTabChange} onNotify={props.onNotify} projectName={props.projectName} canExport={props.canExport} exportBlockedReason={props.exportBlockedReason} captureExportTicket={props.captureExportTicket} canExportShadertoy={props.canExportShadertoy} shadertoyExportBlockedReason={props.shadertoyExportBlockedReason} captureShadertoyExportTicket={props.captureShadertoyExportTicket} validateExportTicket={props.validateExportTicket} />
      </>}>
        <div class="graph-workspace"><div class="graph-pass-tabs">{passTabs()}<strong>{t('graph.workspace.recovery')}</strong><button class="btn mini" onClick={props.onDetachFallback}>{t('graph.workspace.recoveryToCode')}</button></div><div class="graph-stale-banner">{props.graphFallbackIssue || t('graph.workspace.recoveryFallback')}</div><GeneratedCodePane source={props.generatedSource} stale={false} onCopy={() => void copyGenerated()} onExportGraph={props.onExportGraphJson} /></div>
      </Show>
    }>
      <div class="graph-workspace">
        <div class="graph-pass-tabs">{passTabs()}<div class="authoring-switch"><strong>{t('graph.workspace.standalone')}</strong></div><button class="btn mini" onClick={props.onExportGraphJson}>{t('graph.workspace.backupGraph')}</button><button class="btn mini" disabled={!props.canDetach} title={props.canDetach ? t('graph.workspace.detachReadyTitle') : t('graph.workspace.detachBlockedTitle')} onClick={props.onDetachGraph}>{t('graph.workspace.detach')}</button></div>
        <GraphWorkspaceShell state={props.graphWorkspace} onChange={props.onGraphWorkspaceChange} generatedDrawer={generatedPane()}>
          <GraphEditorPane document={props.graphDocument!} registry={props.graphRegistry} assets={props.graphAssets} selection={props.graphSelection} diagnostics={props.graphDiagnostics} status={props.graphStatus} stale={props.graphStale} revealNodeId={props.revealNodeId} workspace={props.graphWorkspace} editingGroup={props.graphEditingGroup} breadcrumbPath={props.graphBreadcrumbPath} titleForGroup={props.graphGroupTitle} onNavigateBreadcrumb={props.onNavigateGroupBreadcrumb} onEnterGroup={props.onEnterNodeGroup} onCreateGroup={props.onCreateNodeGroup} onWorkspaceChange={props.onGraphWorkspaceChange} onOpenResources={props.onOpenGraphResources} onCommand={props.onGraphCommand} onUndo={props.onGraphUndo} onRedo={props.onGraphRedo} onSelection={props.onGraphSelection} onNotify={props.onNotify} />
        </GraphWorkspaceShell>
      </div>
      </Show>
    </Suspense>
  </div>;
};

export default ShaderEditorWorkspace;
