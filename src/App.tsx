import {
  Suspense,
  batch,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  type Component,
} from 'solid-js';
import type * as monaco from 'monaco-editor';
import ShaderEditorWorkspace from './components/ShaderEditorWorkspace';
import DiagnosticsPane, { type MappedDiag } from './components/DiagnosticsPane';
import PreviewPane from './components/PreviewPane';
import UniformPanel from './components/UniformPanel';
import AppDecisionDialog from './components/AppDecisionDialog';
import ProductMessageView from './components/ProductMessageView';
import { joinLocalized, localizedDetail, locale, t, toggleLocale } from './i18n';
import { ProductError, type ProductMessageDescriptor } from './productMessage';
import { formatProductMessage } from './productMessageFormatter';
import {
  DEFAULT_PREVIEW_RESOLUTION,
  PREVIEW_RESOLUTION_PRESETS,
  persistPreviewResolution,
  previewResolutionKey,
  readPreviewResolution,
  type PreviewResolution,
} from './previewResolution';
import { theme, toggleTheme } from './theme';
import { PROJECT_TEMPLATES, getBuiltinTemplateDisplay, getTemplateCanonicalName, type ProjectTemplate } from './templates';
import { inspectGraphCompilation, parseProjectGraph, type GraphProjectIssue } from './project/graphIO';
import { initAutoUpdater } from './updater/updater';
import { DEFAULT_SHADER } from './shadertoy/defaultShader';
import { GLSL_SNIPPETS } from './editor/snippets';
import {
  collectAnalysis,
  computeDefinition,
  computeHover,
  computeSuggestions,
} from './editor/glslIntellisense';
import {
  parseUniforms,
  toPersistedUniforms,
  valuesFromPersisted,
  type UniformDecl,
  type UniformType,
  type UniformValue,
} from './shadertoy/uniforms';
import type {
  CaptureSize,
  RenderPassId,
  RuntimeApi,
  RuntimeStats,
  RuntimeTextureAsset,
} from './shadertoy/runtime';
import {
  BUFFER_IDS,
  BUFFER_LETTER,
  createProject,
  joinPath,
  sourcesWithDefaults,
  type BufferId,
  type ShaderlabProject,
  type SrcPassId,
} from './project/types';
import { hasTauri, pickFile, pickFolder, readBinaryFile, readTextFile, writeTextFile } from './project/bridge';
import {
  parseShadertoyJson,
  shadertoyFileName,
  toShadertoyJson,
} from './shadertoy/json';
import {
  clearScratchAutosave,
  openProjectFrom,
  readLatestAutosave,
  readSession,
  saveProjectTo,
  writeAutosave,
  writeSession,
} from './project/projectIO';
import { adoptTemplate, listUserTemplates, type UserTemplateViewDto } from './agent/agentClient';
import { buildRuntimeSetup } from './shadertoy/setupBuilder';
import { buildUniformContract, reconcileUniformValues } from './shadertoy/uniformContract';
import { exportEligibility, validateExportTicket, type ExportEligibilityInput, type ExportRequirements, type ExportTicket } from './export/exportEligibility';
import { fragmentExportArtifact, graphJsonExportArtifact } from './project/exportArtifacts';
import { codeApplyBoundary, shouldDetachGraph } from './state/codeApplyBoundary';
import { createProjectStoreState } from './state/projectStore';
import { isCurrentRuntimeSetupRevision, nextRuntimeSetupRevision, selectGeneratedCodeSource } from './state/graphRuntimeCoordinator';
import {
  fromRuntimeDiagnostics,
  fromRuntimeDiagnosticsWithGraphSourceMaps,
  type UnifiedDiagnostic,
} from './diagnostics/model';
import { compileGraph, type CompileGraphOptions, type GraphArtifact } from './graph/compiler/index';
import { deterministicHash, stableStringify } from './graph/compiler/hash';
import { createDefaultGraph, createDefaultRaymarchGraph } from './graph/editor/defaultGraph';
import { createAssetManifest, normalizeAssetManifest, resolveTextureEnvironment, type AssetManifest, type TextureAsset } from './graph/assets';
import { createImportedTextureAsset, decodeTextureManifest } from './graph/assetRuntime';
import { computeGraphLibraryRevision, createGraphLibrary, createProjectNodeRegistry, createStarterNodeGroup, normalizeGraphLibrary, type CustomFunctionDefinition, type GraphLibraryDocument, type GraphNodeGroupDefinition, type NodeGroupDefinition } from './graph/library';
import { buildNodeGroupFromSelection } from './graph/editor/groupBuilder';
import { createGraphWorkspaceUi, graphGroupSemanticKey, graphGroupViewportKey, normalizeGraphWorkspaceUi, type GraphGroupLocation, type GraphWorkspaceUiDocument } from './graph/editor/workspaceState';
import { createGraphHistory, executeGraphCommand, redoGraphCommand, undoGraphCommand, type GraphHistory } from './graph/editor/history';
import type { GraphCommand } from './graph/editor/commands';
import { CURRENT_GRAPH_VERSION, GRAPH_FORMAT, type GraphDocument, type GraphPassId, type VisualGraphPassId } from './graph/model';
import {
  convertPassGraphTargetToCode,
  convertPassGraphTargetToGraph,
  createPassGraphDocument,
  migratePassGraphFromLegacy,
  parsePassGraph,
  passGraphFromLegacy,
  passGraphReferenceIssues,
  projectWithResolvedPassGraph,
  resolvePassGraph,
  shadertoyPassGraphIssue,
  type PassGraphDocument,
} from './project/passGraph';
import {
  SAFE_GRAPH_RECOVERY_SHADER,
  classifyPersistedGraph,
  clearAcceptedRuntimeRecoveryFlags,
  persistedGraphRecoveryDecision,
  planPassGraphIdentityRecovery,
  type GraphRecoveryReason,
  type GraphRecoveryReasonMap,
} from './state/graphRecovery';
import {
  acceptedGeneratedSources,
  acceptGraphCohort,
  graphCohortReady,
  createGraphEditorState,
  detachAcceptedGraph,
  graphCanExport,
  graphCompileResolved,
  graphCompileStarted,
  graphDiagnostics,
  graphIsStale,
  graphLayoutChanged,
  graphLibrarySemanticChanged,
  graphSemanticChanged,
  selectGraphPersistenceArtifact,
  type GraphEditorState,
  type GraphLibrarySemanticPatches,
} from './state/graphEditorStore';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

const ProjectPassGraphPanel = lazy(() => import('./components/ProjectPassGraphPanel'));
const ExportDialog = lazy(() => import('./components/ExportDialog'));
const TemplateDialog = lazy(() => import('./components/TemplateDialog'));
const ChatPanel = lazy(() => import('./components/ChatPanel'));
const AgentSettingsDialog = lazy(() => import('./components/AgentSettingsDialog'));
const GraphResourcesDialog = lazy(() => import('./components/GraphResourcesDialog'));

const FeatureLoading: Component<{ modal?: boolean }> = (props) => (
  <div classList={{ 'feature-loading': true, 'modal-feature-loading': !!props.modal }} role="status">
    {t('common.loading')}
  </div>
);


type TabId = SrcPassId;
type CompileDomains = Readonly<{ visual: boolean; sound: boolean }>;
const BOTH_DOMAINS: CompileDomains = { visual: true, sound: true };
const VISUAL_DOMAIN: CompileDomains = { visual: true, sound: false };
const SOUND_DOMAIN: CompileDomains = { visual: false, sound: true };
const domainsForPass = (pass: SrcPassId | GraphPassId): CompileDomains => pass === 'sound'
  ? SOUND_DOMAIN
  : pass === 'common'
    ? BOTH_DOMAINS
    : VISUAL_DOMAIN;

// 无边框窗口的自定义标题栏控制按钮（仅 Tauri 桌面端渲染，浏览器端隐藏）
function WindowControls() {
  const [maximized, setMaximized] = createSignal(false);
  onMount(() => {
    if (!hasTauri()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
    // 窗口尺寸变化（含最大化/还原）时同步按钮状态
    win
      .onResized(() => {
        void win
          .isMaximized()
          .then(setMaximized)
          .catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    onCleanup(() => unlisten?.());
  });
  return (
    <Show when={hasTauri()}>
      <div class="win-controls">
        <button class="win-btn" title={t('window.minimize')} aria-label={t('window.minimize')} onClick={() => void getCurrentWindow().minimize()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="6" y1="12" x2="18" y2="12" />
          </svg>
        </button>
        <button
          class="win-btn"
          title={maximized() ? t('window.restore') : t('window.maximize')}
          aria-label={maximized() ? t('window.restore') : t('window.maximize')}
          onClick={() => void getCurrentWindow().toggleMaximize()}
        >
          <Show
            when={maximized()}
            fallback={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
              </svg>
            }
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="4.5" y="8.5" width="11" height="11" rx="1.5" />
              <polyline points="8.5 8.5 8.5 4.5 19.5 4.5 19.5 15.5 15.5 15.5" />
            </svg>
          </Show>
        </button>
        <button class="win-btn close" title={t('window.close')} aria-label={t('window.close')} onClick={() => void getCurrentWindow().close()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="7" y1="7" x2="17" y2="17" />
            <line x1="17" y1="7" x2="7" y2="17" />
          </svg>
        </button>
      </div>
    </Show>
  );
}

// 顶栏拖动/双击最大化：手动调用窗口 API。data-tauri-drag-region 属性只对被点中的元素生效，
// 顶栏大部分面积被子元素覆盖会导致拖不动，这里整栏接管并排除可交互控件。
const TOPBAR_INTERACTIVE = [
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'a[href]',
  '[role="button"]',
  '[contenteditable="true"]',
  '[data-no-drag]',
  '.menu-root',
  '.menu-pop',
].join(', ');
const TOPBAR_DRAG_THRESHOLD_PX = 4;

function topbarMouseDown(e: MouseEvent) {
  if (!hasTauri() || e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest(TOPBAR_INTERACTIVE)) return;
  e.preventDefault();
  const win = getCurrentWindow();
  if (e.detail === 2) {
    void win.toggleMaximize();
    return;
  }

  const start = { x: e.screenX, y: e.screenY };
  let handled = false;
  const cleanup = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', cleanup);
    window.removeEventListener('blur', cleanup);
  };
  const move = (event: MouseEvent) => {
    if (handled) return;
    if ((event.buttons & 1) === 0) {
      cleanup();
      return;
    }
    if (Math.hypot(event.screenX - start.x, event.screenY - start.y) < TOPBAR_DRAG_THRESHOLD_PX) return;
    handled = true;
    cleanup();
    void (async () => {
      if (await win.isMaximized()) {
        await win.toggleMaximize();
        // 跨显示器/混合 DPI 时，等待 native 状态与 WebView 尺寸同步后再把拖动交给系统。
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (!(await win.isMaximized())) break;
        }
      }
      await win.startDragging();
    })().catch((error) => console.error('[topbar] 窗口操作失败：', error));
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', cleanup);
  window.addEventListener('blur', cleanup);
}

const AUTOSAVE_INTERVAL_MS = 30_000;

const DEFAULT_BUFFER_SHADER = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    fragColor = vec4(0.5 * uv + 0.25 * sin(iTime), 0.0, 1.0);
}
`;

const DEFAULT_SOUND_SHADER = `vec2 mainSound(int samp, float time) {
    float f1 = 220.0;
    float n = 0.3 * sin(6.2831853 * f1 * time);
    n += 0.15 * sin(6.2831853 * f1 * 1.5 * time);
    n *= min(1.0, time * 20.0);
    return vec2(n);
}
`;

const isBufferId = (v: string): v is BufferId =>
  (BUFFER_IDS as string[]).includes(v);
const GRAPH_PASS_IDS: VisualGraphPassId[] = ['image', ...BUFFER_IDS];
const ALL_GRAPH_PASS_IDS: GraphPassId[] = [...GRAPH_PASS_IDS, 'sound'];
const isGraphPassId = (value: string): value is GraphPassId => ALL_GRAPH_PASS_IDS.includes(value as GraphPassId);
const graphFileFor = (pass: GraphPassId) => pass === 'image' ? 'graphs/image.shadergraph.json' : pass === 'sound' ? 'graphs/sound.shadergraph.json' : `graphs/buffer_${pass.slice(-1).toLowerCase()}.shadergraph.json`;

interface AppDialogRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  input?: { label: string; initialValue: string; placeholder?: string; maxLength?: number };
  resolve: (accepted: boolean, value: string) => void;
}

const App: Component = () => {
  const [sources, setSources] = createSignal(
    sourcesWithDefaults({ image: DEFAULT_SHADER }),
  );
  const [activeTab, setActiveTab] = createSignal<TabId>('image');
  const [previewTarget, setPreviewTarget] = createSignal<RenderPassId>('image');
  const [visualDiagnostics, setVisualDiagnostics] = createSignal<UnifiedDiagnostic[]>([]);
  const [soundDiagnostics, setSoundDiagnostics] = createSignal<UnifiedDiagnostic[]>([]);
  const diagnostics = () => [...visualDiagnostics(), ...soundDiagnostics()];
  const setDiagnostics = (items: UnifiedDiagnostic[]) => {
    setVisualDiagnostics(items.filter((item) => item.origin.pass !== 'sound'));
    setSoundDiagnostics(items.filter((item) => item.origin.pass === 'sound'));
  };
  const [projectGraphIssues, setProjectGraphIssues] = createSignal<GraphProjectIssue[]>([]);
  const [graphEditors, setGraphEditors] = createSignal<Partial<Record<GraphPassId, GraphEditorState>>>({});
  const [graphRecoveryDocuments, setGraphRecoveryDocuments] = createSignal<Partial<Record<GraphPassId, GraphDocument>>>({});
  const [graphRecoveryReasonMap, setGraphRecoveryReasonMap] = createSignal<GraphRecoveryReasonMap>({});
  const [graphRecoveryDiagnosticMap, setGraphRecoveryDiagnosticMap] = createSignal<Partial<Record<GraphPassId, UnifiedDiagnostic[]>>>({});
  const [loadedGraphPendingRuntimeRecovery, setLoadedGraphPendingRuntimeRecovery] = createSignal<Partial<Record<GraphPassId, boolean>>>({});
  const [graphCodeBackups, setGraphCodeBackups] = createSignal<Partial<Record<GraphPassId, string>>>({});
  const [graphRevealNodeIds, setGraphRevealNodeIds] = createSignal<Partial<Record<GraphPassId, string>>>({});
  const [passGraph, setPassGraph] = createSignal<PassGraphDocument>(createPassGraphDocument());
  const [assetManifest, setAssetManifest] = createSignal<AssetManifest>(createAssetManifest());
  const [assetPayloads, setAssetPayloads] = createSignal<Record<string, string>>({});
  const [runtimeTextureAssets, setRuntimeTextureAssets] = createSignal<RuntimeTextureAsset[]>([]);
  const [graphLibrary, setGraphLibrary] = createSignal<GraphLibraryDocument>(createGraphLibrary());
  const [graphWorkspace, setGraphWorkspace] = createSignal<GraphWorkspaceUiDocument>(createGraphWorkspaceUi());
  const [groupSelections, setGroupSelections] = createSignal<Record<string, string[]>>({});
  const [groupHistories, setGroupHistories] = createSignal<Record<string, GraphHistory>>({});
  const [graphResourcesOpen, setGraphResourcesOpen] = createSignal(false);
  const [passGraphOpen, setPassGraphOpen] = createSignal(false);
  const [playing, setPlaying] = createSignal(true);
  const [speed, setSpeed] = createSignal(1);
  const [scrubbing, setScrubbing] = createSignal(false);
  const [scrubValue, setScrubValue] = createSignal(0);
  const [stats, setStats] = createSignal<RuntimeStats>({
    fps: 0,
    time: 0,
    frame: 0,
    width: 0,
    height: 0,
    scale: 1,
  });
  const initialPreviewResolution = readPreviewResolution();
  const [previewResolution, setPreviewResolution] = createSignal<PreviewResolution>(initialPreviewResolution);
  const [previewResolutionOpen, setPreviewResolutionOpen] = createSignal(false);
  const [customPreviewWidth, setCustomPreviewWidth] = createSignal(String(initialPreviewResolution.mode === 'fixed' ? initialPreviewResolution.width : 1920));
  const [customPreviewHeight, setCustomPreviewHeight] = createSignal(String(initialPreviewResolution.mode === 'fixed' ? initialPreviewResolution.height : 1080));
  const savedEditorRatio = Number(localStorage.getItem('shaderlab-editor-ratio'));
  const [editorRatio, setEditorRatio] = createSignal(
    Number.isFinite(savedEditorRatio) && savedEditorRatio >= 0.15 && savedEditorRatio <= 0.85
      ? savedEditorRatio
      : 0.5,
  );
  const [compileState, setCompileState] = createSignal<'pending' | 'compiling' | 'ready'>('pending');
  const [soundCompileState, setSoundCompileState] = createSignal<'pending' | 'compiling' | 'ready'>('pending');
  const [successfulRuntimeSetupRevision, setSuccessfulRuntimeSetupRevision] = createSignal<number>();
  const [successfulSoundRuntimeSetupRevision, setSuccessfulSoundRuntimeSetupRevision] = createSignal<number>();
  const [visualSetupRevision, setVisualSetupRevision] = createSignal(0);
  const [soundSetupRevision, setSoundSetupRevision] = createSignal(0);

  const [projectDir, setProjectDir] = createSignal<string | null>(null);
  const [projectName, setProjectName] = createSignal(t('app.project.unnamed'));
  const [dirty, setDirty] = createSignal(false);
  const [meta, setMeta] = createSignal<ShaderlabProject>(createProject(t('app.project.unnamed')));
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [passMenuOpen, setPassMenuOpen] = createSignal(false);
  const [uniformMenuOpen, setUniformMenuOpen] = createSignal(false);
  const [uniformInspectorOpen, setUniformInspectorOpen] = createSignal(false);
  const [templateOpen, setTemplateOpen] = createSignal(false);
  const [diagOpen, setDiagOpen] = createSignal(true);
  const [speedOpen, setSpeedOpen] = createSignal(false);
  /** M6c：自定义模板池（后端 user_templates 目录镜像，user-templates-changed 事件驱动刷新） */
  const [userTemplates, setUserTemplates] = createSignal<UserTemplateViewDto[]>([]);
  const [uniformValues, setUniformValues] = createSignal<Record<string, UniformValue>>({});
  const [exportOpen, setExportOpen] = createSignal(false);
  /** 非破坏性预览状态始终保留进入候选流程前的原始代码和脏状态。 */
  const [previewState, setPreviewState] = createSignal<{
    name: string;
    backup: string;
    dirty: boolean;
  } | null>(null);
  const [aiUndo, setAiUndo] = createSignal<{
    code: string;
    dirty: boolean;
    previousAppliedCode: string | null;
  } | null>(null);
  const [lastAppliedAiCode, setLastAppliedAiCode] = createSignal<string | null>(null);
  const [compactPane, setCompactPane] = createSignal<'editor' | 'preview'>('editor');
  const selectCompactPaneByKeyboard = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'editor' : 'preview';
    setCompactPane(next);
    requestAnimationFrame(() => document.getElementById(`compact-pane-tab-${next}`)?.focus());
  };
  const [chatOpen, setChatOpen] = createSignal(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = createSignal(false);
  const [toast, setToast] = createSignal<{ message: string | ProductMessageDescriptor; kind: 'ok' | 'error' } | null>(null);
  const [recover, setRecover] = createSignal<{ savedAt: number; name: string } | null>(null);
  const [appDialog, setAppDialog] = createSignal<AppDialogRequest | null>(null);
  const requestConfirmation = (options: Omit<AppDialogRequest, 'resolve' | 'input'>) => new Promise<boolean>((resolve) => {
    if (appDialog()) return resolve(false);
    setAppDialog({ ...options, resolve: (accepted) => resolve(accepted) });
  });
  const requestTextInput = (options: Omit<AppDialogRequest, 'resolve'> & { input: NonNullable<AppDialogRequest['input']> }) => new Promise<string | undefined>((resolve) => {
    if (appDialog()) return resolve(undefined);
    setAppDialog({ ...options, resolve: (accepted, value) => resolve(accepted ? value : undefined) });
  });
  const resolveAppDialog = (accepted: boolean, value: string) => {
    const request = appDialog();
    if (!request) return;
    setAppDialog(null);
    request.resolve(accepted, value);
  };

  let api: RuntimeApi | null = null;
  let editorRef: monaco.editor.IStandaloneCodeEditor | null = null;
  let workspaceRef: HTMLDivElement | undefined;
  let menuRootRef: HTMLDivElement | undefined;
  let passRootRef: HTMLDivElement | undefined;
  let uniformRootRef: HTMLDivElement | undefined;
  let speedRootRef: HTMLDivElement | undefined;
  let resolutionRootRef: HTMLDivElement | undefined;
  let dividerDragging = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimeSetupRevision = 0;
  let pendingCompileDomains: CompileDomains = { visual: false, sound: false };
  let previousUniformTypes: ReadonlyMap<string, UniformType> | undefined;
  let graphDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let unlistenUserTpl: (() => void) | undefined;
  let autosaveInfo: { path?: string; savedAt?: number } = {};
  let projectIdentity = 0;
  const advanceProjectIdentity = () => {
    projectIdentity += 1;
    autosaveInfo = {};
  };
  const bootSession = readSession();

  const tabs = createMemo<{ id: TabId; label: string }[]>(() => {
    const m = meta();
    const list: { id: TabId; label: string }[] = [
      { id: 'image', label: 'Image' },
      { id: 'common', label: 'Common' },
    ];
    for (const b of BUFFER_IDS) {
      if (m.passes[b]?.enabled) {
        list.push({ id: b, label: `Buffer ${BUFFER_LETTER[b]}` });
      }
    }
    list.push({ id: 'sound', label: 'Sound' });
    return list;
  });

  const enabledBuffers = createMemo<BufferId[]>(() =>
    BUFFER_IDS.filter((b) => !!meta().passes[b]?.enabled),
  );
  const runtimePassEnabled = (pass: GraphPassId) => pass === 'image' || !!meta().passes[pass].enabled;

  const activeGraphPass = () => isGraphPassId(activeTab()) ? activeTab() as GraphPassId : undefined;
  const passAuthoring = (pass: GraphPassId) => meta().passes[pass].authoring?.kind === 'graph' ? 'graph' as const : 'code' as const;
  const imageAuthoring = () => passAuthoring('image');
  const graphEditor = (pass: GraphPassId = activeGraphPass() ?? 'image') => graphEditors()[pass];
  const graphRecoveryDocument = (pass: GraphPassId = activeGraphPass() ?? 'image') => graphRecoveryDocuments()[pass];
  const graphRecoveryDiagnostics = (pass?: GraphPassId) => pass
    ? graphRecoveryDiagnosticMap()[pass] ?? []
    : ALL_GRAPH_PASS_IDS.flatMap((id) => graphRecoveryDiagnosticMap()[id] ?? []);
  const graphRevealNodeId = (pass: GraphPassId = activeGraphPass() ?? 'image') => graphRevealNodeIds()[pass];
  const activeGraphEditor = () => activeGraphPass() ? graphEditor(activeGraphPass()!) : undefined;
  const activeAuthoring = () => activeGraphPass() ? passAuthoring(activeGraphPass()!) : 'code' as const;
  const activeGroupPath = () => graphWorkspace().editPath;
  const nodeGroupAt = (location: GraphGroupLocation): GraphNodeGroupDefinition | undefined => {
    const group = graphLibrary().groups.find((item) => item.id === location.groupId && item.version === location.version);
    return group?.kind === 'graph' ? group : undefined;
  };
  const activeEditingGroup = () => activeGroupPath().length ? nodeGroupAt(activeGroupPath().at(-1)!) : undefined;
  const activeGroupKey = () => {
    const pass = activeGraphPass(); const group = activeEditingGroup();
    return pass && group ? graphGroupViewportKey(pass, group.id, group.version) : undefined;
  };
  const activeGroupHistoryKey = () => {
    const group = activeEditingGroup();
    return group ? graphGroupSemanticKey(group.id, group.version) : undefined;
  };
  const activeGroupDocument = (): GraphDocument | undefined => {
    const pass = activeGraphPass(); const group = activeEditingGroup(); const key = activeGroupKey();
    if (!pass || !group || !key) return undefined;
    return {
      format: GRAPH_FORMAT,
      version: CURRENT_GRAPH_VERSION,
      pass,
      nodes: group.graph.nodes,
      edges: group.graph.edges,
      parameters: [],
      ui: { viewport: graphWorkspace().groupViewports[key] ?? { x: 0, y: 0, zoom: 1 } },
    };
  };
  const displayedGraphDocument = () => activeGroupDocument() ?? activeGraphEditor()?.document;
  const displayedGraphSelection = () => activeGroupKey() ? groupSelections()[activeGroupKey()!] ?? [] : activeGraphEditor()?.selection ?? [];
  const groupTitle = (location: GraphGroupLocation) => graphLibrary().groups.find((group) => group.id === location.groupId && group.version === location.version)?.title ?? location.groupId;
  const updateGraphWorkspace = (workspace: GraphWorkspaceUiDocument) => {
    try { setGraphWorkspace(normalizeGraphWorkspaceUi(workspace)); setDirty(true); }
    catch { notify({ code: 'graph.workspace-invalid' }, 'error'); }
  };
  const activeCompileStatus = () => activeGraphPass() && activeAuthoring() === 'graph'
    ? activeGraphEditor()?.status ?? 'stale'
    : activeGraphPass() === 'sound' ? soundCompileState() : compileState();
  const setGraphEditorFor = (pass: GraphPassId, value: GraphEditorState | undefined | ((state: GraphEditorState | undefined) => GraphEditorState | undefined)) => {
    setGraphEditors((states) => {
      const previous = states[pass];
      const next = typeof value === 'function' ? value(previous) : value;
      const updated = { ...states };
      if (next) updated[pass] = next; else delete updated[pass];
      return updated;
    });
  };
  const allGraphDocuments = createMemo<Partial<Record<GraphPassId, GraphDocument>>>(() => {
    const documents: Partial<Record<GraphPassId, GraphDocument>> = { ...graphRecoveryDocuments() };
    for (const pass of ALL_GRAPH_PASS_IDS) if (graphEditors()[pass]) documents[pass] = graphEditors()[pass]!.document;
    return documents;
  });
  const passGraphResolution = createMemo(() => resolvePassGraph(passGraph(), meta(), allGraphDocuments()));
  const graphNodeRegistry = createMemo(() => createProjectNodeRegistry(graphLibrary()));
  const graphLibraryRevision = createMemo(() => computeGraphLibraryRevision(graphLibrary()));
  const texturePlan = createMemo(() => {
    const environments: Partial<Record<GraphPassId, ReturnType<typeof resolveTextureEnvironment>>> = {};
    const issues: UnifiedDiagnostic[] = [];
    const resolution = passGraphResolution().resolved;
    for (const pass of ALL_GRAPH_PASS_IDS) {
      const document = allGraphDocuments()[pass];
      if (!document) continue;
      try {
        const occupied = pass === 'sound' ? [] : (resolution?.edges.filter((edge) => edge.target === pass).map((edge) => edge.slot) ?? []);
        environments[pass] = resolveTextureEnvironment(document, assetManifest(), occupied);
      } catch (error) {
        if (runtimePassEnabled(pass)) issues.push({
          message: 'Graph 纹理资产绑定无效',
          severity: 'error',
          stage: 'graph-validate',
          code: 'asset.binding-invalid',
          rawDetail: error instanceof Error ? error.message : String(error),
          origin: { kind: 'graph', pass },
        });
      }
    }
    return { environments, issues };
  });
  const compileOptionsFor = (pass: GraphPassId): CompileGraphOptions => {
    const textures = texturePlan().environments[pass];
    const resolution = passGraphResolution().resolved;
    return {
      registry: graphNodeRegistry(),
      libraryRevision: graphLibraryRevision(),
      ...(pass !== 'sound' ? { channelEnvironment: resolution?.channelEnvironment[pass], channelEnvironmentRevision: resolution?.revision } : {}),
      textureEnvironment: textures?.bindings,
      textureEnvironmentRevision: textures?.revision,
    };
  };
  const runtimeGraphTextureChannels = createMemo(() => Object.fromEntries(ALL_GRAPH_PASS_IDS.map((pass) => [pass, (texturePlan().environments[pass]?.assets ?? []).map((asset) => ({ index: asset.slot, type: 'texture' as const, src: asset.assetId, filter: asset.filter, wrap: asset.wrap }))])) as Partial<Record<GraphPassId, Array<{ index: number; type: 'texture'; src: string; filter: 'linear' | 'nearest'; wrap: 'repeat' | 'clamp' }>>>);
  const graphFallbackActive = (pass: GraphPassId = activeGraphPass() ?? 'image') => passAuthoring(pass) === 'graph' && !graphEditor(pass);
  const graphGeneratedSources = createMemo(() => acceptedGeneratedSources(graphEditors()));
  const projectState = createMemo(() => createProjectStoreState(meta(), sources(), graphGeneratedSources()));
  const effectiveSources = () => projectState().effectiveSources;
  const effectiveProjectMeta = () => passGraphResolution().resolved
    ? projectWithResolvedPassGraph(meta(), passGraphResolution().resolved!)
    : meta();
  const generatedCodeSelection = createMemo(() => {
    const pass = activeGraphPass() ?? 'image';
    const selected = selectGeneratedCodeSource(graphEditor(pass));
    return graphFallbackActive(pass) ? { source: sources()[pass] ?? '', accepted: true } : selected;
  });

  const parsedUniforms = createMemo(() =>
    parseUniforms(effectiveSources(), (pid) => {
      if (pid === 'image' || pid === 'common') return true;
      return !!meta().passes[pid]?.enabled;
    }).decls,
  );

  const acceptedGraphUniforms = createMemo(() =>
    ALL_GRAPH_PASS_IDS.filter(runtimePassEnabled).flatMap((pass) => graphEditors()[pass]?.runtimeAcceptedArtifact?.uniforms ?? []),
  );
  const uniformContract = createMemo(() => buildUniformContract(
    parsedUniforms(),
    acceptedGraphUniforms(),
    uniformValues(),
  ));
  const visualUniformContract = createMemo(() => buildUniformContract(
    parsedUniforms().filter((decl) => decl.pass !== 'sound'),
    acceptedGraphUniforms().filter((uniform) => uniform.pass !== 'sound'),
    uniformValues(),
  ));
  const soundUniformContract = createMemo(() => buildUniformContract(
    parsedUniforms().filter((decl) => decl.pass === 'common' || decl.pass === 'sound'),
    acceptedGraphUniforms().filter((uniform) => uniform.pass === 'sound'),
    uniformValues(),
  ));
  const uniformDecls = createMemo<UniformDecl[]>(() => uniformContract().declarations);

  const uniformGroups = createMemo<{ pass: SrcPassId; items: UniformDecl[] }[]>(() => {
    const groups: Partial<Record<SrcPassId, UniformDecl[]>> = {};
    for (const declaration of uniformDecls()) (groups[declaration.pass] ??= []).push(declaration);
    return (['common', 'image', ...BUFFER_IDS, 'sound'] as SrcPassId[])
      .filter((pass) => groups[pass]?.length)
      .map((pass) => ({ pass, items: groups[pass]! }));
  });

  createEffect(() => {
    const declarations = uniformDecls();
    const next = reconcileUniformValues(declarations, uniformValues(), previousUniformTypes);
    previousUniformTypes = new Map(declarations.map((decl) => [decl.name, decl.type]));
    if (JSON.stringify(next) !== JSON.stringify(uniformValues())) setUniformValues(next);
  });

  const runtimeSetup = createMemo(() =>
    buildRuntimeSetup(meta(), effectiveSources(), parsedUniforms(), uniformValues(), acceptedGraphUniforms(), passGraphResolution().resolved, runtimeGraphTextureChannels(), runtimeTextureAssets()),
  );

  const projectIssueDiagnostics = createMemo<UnifiedDiagnostic[]>(() => projectGraphIssues().map((issue) => ({
    message: issue.message,
    severity: issue.severity,
    stage: issue.stage ?? 'graph-schema',
    code: issue.code,
    ...(issue.params !== undefined ? { params: issue.params } : {}),
    ...(issue.rawDetail !== undefined ? { rawDetail: issue.rawDetail } : {}),
    origin: issue.origin ?? { kind: 'graph', pass: issue.pass },
    ...(issue.relatedOrigins ? { relatedOrigins: issue.relatedOrigins } : {}),
  })));

  const unifiedDiagnostics = createMemo<UnifiedDiagnostic[]>(() => [
    ...projectIssueDiagnostics(),
    ...passGraphResolution().diagnostics,
    ...texturePlan().issues,
    ...graphRecoveryDiagnostics(),
    ...uniformContract().diagnostics,
    ...diagnostics(),
    ...ALL_GRAPH_PASS_IDS.flatMap((pass) => passAuthoring(pass) === 'graph' && graphEditor(pass) ? graphDiagnostics(graphEditor(pass)!) : []),
  ]);
  const passGraphIdentityIssue = () => projectGraphIssues().find((issue) => issue.severity === 'error' && (
    issue.code === 'pass-graph.invalid' || issue.code.startsWith('pass-graph.reference-')
  ));
  const currentUniformConflict = () => uniformContract().diagnostics.find((item) => item.code === 'uniform.type-conflict')
    ?? ALL_GRAPH_PASS_IDS.flatMap((pass) => graphEditor(pass) ? graphDiagnostics(graphEditor(pass)!) : []).find((item) => item.code === 'uniform.type-conflict');
  const currentUniformConflictMessage = () => {
    const conflict = currentUniformConflict();
    return conflict ? formatProductMessage(conflict) : t('app.error.uniformContractInvalid');
  };

  const mappedDiags = createMemo<MappedDiag[]>(() =>
    unifiedDiagnostics().flatMap((diagnostic) => {
      if (diagnostic.origin.kind !== 'code') return [];
      return [{
        line: diagnostic.origin.line,
        column: diagnostic.origin.column,
        message: diagnostic.message,
        code: diagnostic.code ?? 'diagnostic.unstructured',
        ...(diagnostic.params !== undefined ? { params: diagnostic.params } : {}),
        ...(diagnostic.rawDetail !== undefined ? { rawDetail: diagnostic.rawDetail } : {}),
        fallback: diagnostic.message,
        tab: diagnostic.origin.pass,
        stage: diagnostic.stage,
        severity: diagnostic.severity,
      }];
    }),
  );

  const activeDiagnosticRelevant = (item: UnifiedDiagnostic) => {
    const activeDomain = activeGraphPass() === 'sound' ? 'sound' : 'visual';
    const pass = item.origin.pass;
    if (pass === 'common') return true;
    if (pass === 'sound') return activeDomain === 'sound' && meta().passes.sound.enabled;
    return activeDomain === 'visual' && (pass === 'image' || meta().passes[pass].enabled);
  };
  const errCount = () => unifiedDiagnostics().filter((item) => item.severity === 'error' && activeDiagnosticRelevant(item)).length;
  const enabledGraphPasses = () => ALL_GRAPH_PASS_IDS.filter((pass) => meta().passes[pass].enabled && passAuthoring(pass) === 'graph');
  const VISUAL_EXPORT: ExportRequirements = { visual: true, sound: false };
  const SOUND_EXPORT: ExportRequirements = { visual: false, sound: true };
  const currentExportInput = (requirements: ExportRequirements = VISUAL_EXPORT): ExportEligibilityInput => {
    const graphPasses = enabledGraphPasses().filter((pass) => pass === 'sound' ? requirements.sound : requirements.visual);
    const graphArtifacts = graphPasses.flatMap((pass) => {
      const state = graphEditor(pass);
      const artifact = state?.runtimeAcceptedArtifact;
      return state && artifact ? [{ pass, generation: state.generation, revision: artifact.revision, sourceHash: artifact.sourceHash }] : [];
    });
    const graphMode = graphPasses.length > 0;
    const laneStates = [
      ...(requirements.visual ? [graphPasses.some((pass) => pass !== 'sound')
        ? graphPasses.filter((pass) => pass !== 'sound').every((pass) => { const state = graphEditor(pass); return !!state && !graphIsStale(state, graphLibraryRevision()); }) ? 'ready' as const : 'stale' as const
        : compileState()] : []),
      ...(requirements.sound ? [graphPasses.includes('sound')
        ? (() => { const state = graphEditor('sound'); return state && !graphIsStale(state, graphLibraryRevision()) ? 'ready' as const : 'stale' as const; })()
        : soundCompileState()] : []),
    ];
    const relevantDiagnostic = (item: UnifiedDiagnostic) => {
      const pass = item.origin.pass;
      if (pass === 'common') return requirements.visual || requirements.sound;
      if (pass === 'sound') return requirements.sound && meta().passes.sound.enabled;
      return requirements.visual && (pass === 'image' || meta().passes[pass].enabled);
    };
    const sourceIdentity = {
      ...(requirements.visual ? {
        common: effectiveSources().common,
        image: effectiveSources().image,
        buffers: Object.fromEntries(BUFFER_IDS.filter((pass) => meta().passes[pass].enabled).map((pass) => [pass, effectiveSources()[pass]])),
        passGraph: passGraphResolution().resolved?.revision,
      } : {}),
      ...(requirements.sound ? { soundCommon: effectiveSources().common, sound: meta().passes.sound.enabled ? effectiveSources().sound : '' } : {}),
      assets: assetManifest().assets.map((asset) => ({ id: asset.id, contentHash: asset.contentHash, colorSpace: asset.colorSpace })),
    };
    return {
      authoring: graphMode ? 'graph' : 'code',
      requirements,
      runtimeSetupRevision: requirements.visual ? visualSetupRevision() : soundSetupRevision(),
      visualRuntimeSetupRevision: visualSetupRevision(),
      soundRuntimeSetupRevision: soundSetupRevision(),
      successfulRuntimeSetupRevision: successfulRuntimeSetupRevision(),
      successfulVisualRuntimeSetupRevision: successfulRuntimeSetupRevision(),
      successfulSoundRuntimeSetupRevision: successfulSoundRuntimeSetupRevision(),
      compileStatus: laneStates.every((state) => state === 'ready') ? 'ready' : laneStates.includes('compiling') ? 'compiling' : laneStates.includes('pending') ? 'pending' : 'stale',
      hasCompileError: unifiedDiagnostics().some((item) => item.severity === 'error' && item.code !== 'uniform.type-conflict' && relevantDiagnostic(item)),
      hasUniformConflict: (requirements.visual && visualUniformContract().hasErrors) || (requirements.sound && soundUniformContract().hasErrors),
      graphArtifacts,
      ...(requirements.visual ? { passGraphRevision: passGraphResolution().resolved?.revision } : {}),
      effectiveSourcesHash: deterministicHash(stableStringify(sourceIdentity)),
      graphAccepted: (!requirements.visual || passGraphResolution().ok)
        && (!graphMode || graphCohortReady(graphEditors(), graphPasses, graphLibraryRevision())),
    };
  };
  const currentExportEligibility = (requirements: ExportRequirements = VISUAL_EXPORT) => exportEligibility(currentExportInput(requirements));
  const canExportCurrent = () => currentExportEligibility(activeGraphPass() === 'sound' ? SOUND_EXPORT : VISUAL_EXPORT).eligible;
  const exportBlockedReason = () => currentExportEligibility(activeGraphPass() === 'sound' ? SOUND_EXPORT : VISUAL_EXPORT).reason;
  const canOpenMediaExport = () => currentExportEligibility(VISUAL_EXPORT).eligible || currentExportEligibility(SOUND_EXPORT).eligible;
  const mediaExportBlockedMessage = () => {
    const visualReason = currentExportEligibility(VISUAL_EXPORT).reason;
    const soundReason = currentExportEligibility(SOUND_EXPORT).reason;
    return t('app.error.mediaExportUnavailable', {
      visualReason: visualReason ? formatProductMessage(visualReason) : t('app.status.unavailable'),
      soundReason: soundReason ? formatProductMessage(soundReason) : t('app.status.unavailable'),
    });
  };
  const openVisualExport = () => {
    if (!canOpenMediaExport()) return notify(mediaExportBlockedMessage(), 'error');
    setExportOpen(true);
  };
  const captureExportTicket = (requirements: ExportRequirements) => currentExportEligibility(requirements);
  const validateCaptureTicket = (ticket: ExportTicket) => validateExportTicket(ticket, currentExportInput(ticket.requirements));
  const shadertoyExportRequirements = (): ExportRequirements => ({ visual: true, sound: meta().passes.sound.enabled });
  const shadertoyRepresentationIssue = (): ProductMessageDescriptor | undefined => {
    const resolved = passGraphResolution().resolved;
    if (!resolved) return { code: 'export.shadertoy-pass-graph-invalid', fallback: t('app.error.passGraphInvalid') };
    const timingIssue = shadertoyPassGraphIssue(resolved);
    if (timingIssue) return timingIssue;
    const graphTexturePass = ALL_GRAPH_PASS_IDS.find((pass) => runtimePassEnabled(pass)
      && (texturePlan().environments[pass]?.assets.length ?? 0) > 0);
    if (graphTexturePass) return {
      code: 'export.shadertoy-graph-texture-unsupported',
      params: { pass: graphTexturePass },
      fallback: t('app.error.shadertoyGraphTextureUnsupported', { pass: graphTexturePass }),
    };
    const codeTexturePass = ALL_GRAPH_PASS_IDS.find((pass) => runtimePassEnabled(pass)
      && passAuthoring(pass) === 'code'
      && (meta().passes[pass].channels ?? []).some((channel) => channel.type === 'texture'));
    return codeTexturePass
      ? {
          code: 'export.shadertoy-code-texture-unsupported',
          params: { pass: codeTexturePass },
          fallback: t('app.error.shadertoyCodeTextureUnsupported', { pass: codeTexturePass }),
        }
      : undefined;
  };
  const shadertoyExportEligibility = () => currentExportEligibility(shadertoyExportRequirements());

  const notify = (message: string | ProductMessageDescriptor, kind: 'ok' | 'error' = 'ok') => {
    clearTimeout(toastTimer);
    setToast({ message, kind });
    toastTimer = setTimeout(() => setToast(null), 4000);
  };

  const importTextureAsset = async () => {
    try {
      const path = await pickFile(t('app.picker.importTexture'), ['png', 'jpg', 'jpeg', 'webp']);
      if (!path) return;
      const payload = await readBinaryFile(path);
      const imported = await createImportedTextureAsset(path, payload, assetManifest().assets);
      try {
        const nextManifest = normalizeAssetManifest({ ...assetManifest(), assets: [...assetManifest().assets, imported.asset] });
        setAssetManifest(nextManifest);
        setAssetPayloads((items) => ({ ...items, [imported.asset.id]: payload }));
        setRuntimeTextureAssets((items) => [...items, imported.runtime]);
      } catch (error) {
        if (imported.runtime.source && 'close' in imported.runtime.source) (imported.runtime.source as ImageBitmap).close();
        throw error;
      }
      setDirty(true);
      scheduleGraphCompile();
      notify(t('app.toast.textureImported', { name: imported.asset.name }), 'ok');
    } catch (error) { notify(t('app.error.textureImportFailed', { detail: formatProductMessage(error) }), 'error'); }
  };
  const setTextureColorSpace = (id: string, colorSpace: 'srgb' | 'linear') => {
    setAssetManifest((manifest) => normalizeAssetManifest({
      ...manifest,
      assets: manifest.assets.map((asset) => asset.id === id ? { ...asset, colorSpace } : asset),
    }));
    setDirty(true);
    scheduleGraphCompile();
  };
  const removeTextureAsset = (id: string) => {
    if (allGraphDocuments() && Object.values(allGraphDocuments()).some((document) => document?.nodes.some((node) => node.type === 'input.texture2d' && node.values.assetId === id))) {
      return notify(t('app.error.textureInUse', { id }), 'error');
    }
    setAssetManifest((manifest) => ({ ...manifest, assets: manifest.assets.filter((asset) => asset.id !== id) }));
    setAssetPayloads((items) => { const next = { ...items }; delete next[id]; return next; });
    setRuntimeTextureAssets((items) => { for (const item of items.filter((asset) => asset.id === id)) if (item.source && 'close' in item.source) (item.source as ImageBitmap).close(); return items.filter((asset) => asset.id !== id); });
    setDirty(true);
    scheduleCompile();
  };
  const applyGraphLibrarySemanticChange = (
    library: GraphLibraryDocument,
    patches: GraphLibrarySemanticPatches = {},
    sideEffect?: () => void,
  ) => {
    batch(() => {
      setGraphLibrary(library);
      setGraphEditors((states) => graphLibrarySemanticChanged(states, patches));
      sideEffect?.();
      setDirty(true);
    });
    scheduleGraphCompile(BOTH_DOMAINS);
  };
  const addStarterGroup = () => {
    let index = graphLibrary().groups.length + 1;
    let group = createStarterNodeGroup(index === 1 ? 'wave_mix' : `wave_mix_${index}`);
    while (graphLibrary().groups.some((item) => item.id === group.id && item.version === group.version)) group = createStarterNodeGroup(`wave_mix_${++index}`);
    try { applyGraphLibrarySemanticChange(normalizeGraphLibrary({ ...graphLibrary(), groups: [...graphLibrary().groups, group] })); }
    catch { notify({ code: 'graph.library-update-failed' }, 'error'); }
  };
  const addCustomFunction = (definition: CustomFunctionDefinition): ProductMessageDescriptor | null => {
    try {
      applyGraphLibrarySemanticChange(normalizeGraphLibrary({
        ...graphLibrary(),
        functions: [...graphLibrary().functions, definition],
      }));
      return null;
    } catch {
      return { code: 'graph.custom-function-invalid' };
    }
  };
  const removeLibraryEntry = (kind: 'groups' | 'functions', id: string, version: number) => {
    try {
      applyGraphLibrarySemanticChange(normalizeGraphLibrary({ ...graphLibrary(), [kind]: graphLibrary()[kind].filter((item) => item.id !== id || item.version !== version) }));
    } catch { notify({ code: 'graph.library-update-failed' }, 'error'); }
  };
  const useRaymarchTemplate = async () => {
    const pass = activeGraphPass();
    if (!pass || pass === 'sound') return notify(t('app.error.raymarchVisualOnly'), 'error');
    if (!await requestConfirmation({
      title: t('app.dialog.raymarchTitle'),
      message: t('app.dialog.raymarchMessage'),
      confirmLabel: t('app.dialog.raymarchConfirm'),
      danger: true,
    })) return;
    setGraphEditorFor(pass, createGraphEditorState(createDefaultRaymarchGraph(pass)));
    setDirty(true); scheduleGraphCompile(VISUAL_DOMAIN); setGraphResourcesOpen(false);
  };

  const resetGraphState = () => {
    clearTimeout(graphDebounceTimer);
    setGraphEditors({});
    setGraphRecoveryDocuments({});
    setGraphRecoveryReasonMap({});
    setGraphRecoveryDiagnosticMap({});
    setLoadedGraphPendingRuntimeRecovery({});
    setGraphRevealNodeIds({});
    setGraphWorkspace(createGraphWorkspaceUi());
    setGroupSelections({});
    setGroupHistories({});
  };

  const runtimeSetupForGraphArtifacts = (
    artifacts: Partial<Record<GraphPassId, NonNullable<GraphEditorState['lastSuccessfulArtifact']>>>,
  ) => {
    const mergedArtifacts: Partial<Record<GraphPassId, NonNullable<GraphEditorState['lastSuccessfulArtifact']>>> = {};
    for (const pass of ALL_GRAPH_PASS_IDS) {
      if (!runtimePassEnabled(pass)) continue;
      const accepted = graphEditor(pass)?.runtimeAcceptedArtifact;
      if (accepted) mergedArtifacts[pass] = accepted;
      if (artifacts[pass]) mergedArtifacts[pass] = artifacts[pass];
    }
    const generated: Partial<Record<GraphPassId, string>> = {};
    const generatedUniforms = [] as NonNullable<GraphEditorState['lastSuccessfulArtifact']>['uniforms'][number][];
    for (const pass of ALL_GRAPH_PASS_IDS) {
      const artifact = mergedArtifacts[pass];
      if (!artifact) continue;
      generated[pass] = artifact.source;
      generatedUniforms.push(...artifact.uniforms);
    }
    const candidateSources = createProjectStoreState(meta(), sources(), generated).effectiveSources;
    const parsed = parseUniforms(candidateSources, (pass) => pass === 'image' || pass === 'common' || !!meta().passes[pass]?.enabled).decls;
    const visualContract = buildUniformContract(
      parsed.filter((decl) => decl.pass !== 'sound'),
      generatedUniforms.filter((uniform) => uniform.pass !== 'sound'),
      uniformValues(),
    );
    const soundContract = buildUniformContract(
      parsed.filter((decl) => decl.pass === 'common' || decl.pass === 'sound'),
      generatedUniforms.filter((uniform) => uniform.pass === 'sound'),
      uniformValues(),
    );
    return {
      visualContract,
      soundContract,
      setup: buildRuntimeSetup(meta(), candidateSources, parsed, uniformValues(), generatedUniforms, passGraphResolution().resolved, runtimeGraphTextureChannels(), runtimeTextureAssets()),
    };
  };

  const safeGraphRecoverySetup = () => {
    const current = meta();
    const recoveryMeta: ShaderlabProject = {
      ...current,
      passes: {
        ...current.passes,
        image: { ...current.passes.image, channels: [] },
        bufferA: { ...current.passes.bufferA, enabled: false },
        bufferB: { ...current.passes.bufferB, enabled: false },
        bufferC: { ...current.passes.bufferC, enabled: false },
        bufferD: { ...current.passes.bufferD, enabled: false },
        sound: { ...current.passes.sound, enabled: false },
      },
    };
    return buildRuntimeSetup(recoveryMeta, sourcesWithDefaults({ image: SAFE_GRAPH_RECOVERY_SHADER, common: '' }), [], {}, [], resolvePassGraph(createPassGraphDocument(), recoveryMeta).resolved);
  };

  const clearGraphRecoveryFor = (pass: GraphPassId) => {
    setGraphRecoveryDocuments((items) => { const next = { ...items }; delete next[pass]; return next; });
    setGraphRecoveryReasonMap((items) => { const next = { ...items }; delete next[pass]; return next; });
    setGraphRecoveryDiagnosticMap((items) => { const next = { ...items }; delete next[pass]; return next; });
    setLoadedGraphPendingRuntimeRecovery((items) => { const next = { ...items }; delete next[pass]; return next; });
    setGraphRevealNodeIds((items) => { const next = { ...items }; delete next[pass]; return next; });
  };

  const activateReadOnlyGraphRecovery = (
    pass: GraphPassId,
    document: GraphDocument,
    reason: GraphRecoveryReason,
    recoveryDiagnostics: UnifiedDiagnostic[] = [],
  ) => {
    clearTimeout(graphDebounceTimer);
    setGraphEditorFor(pass, undefined);
    setGraphRecoveryDocuments((items) => ({ ...items, [pass]: document }));
    setGraphRecoveryReasonMap((items) => ({ ...items, [pass]: reason }));
    setGraphRecoveryDiagnosticMap((items) => ({ ...items, [pass]: recoveryDiagnostics }));
    setLoadedGraphPendingRuntimeRecovery((items) => { const next = { ...items }; delete next[pass]; return next; });
    setGraphRevealNodeIds((items) => { const next = { ...items }; delete next[pass]; return next; });
  };

  const mergeCompileDomains = (left: CompileDomains, right: CompileDomains): CompileDomains => ({
    visual: left.visual || right.visual,
    sound: left.sound || right.sound,
  });
  const consumePendingCompileDomains = (): CompileDomains => {
    const pending = pendingCompileDomains;
    pendingCompileDomains = { visual: false, sound: false };
    return pending;
  };
  const reserveRuntimeSetupRevision = (domains: CompileDomains = BOTH_DOMAINS) => {
    runtimeSetupRevision = nextRuntimeSetupRevision(runtimeSetupRevision);
    pendingCompileDomains = mergeCompileDomains(pendingCompileDomains, domains);
    if (domains.visual) {
      setVisualSetupRevision((revision) => nextRuntimeSetupRevision(revision));
      setCompileState('pending');
    }
    if (domains.sound) {
      setSoundSetupRevision((revision) => nextRuntimeSetupRevision(revision));
      setSoundCompileState('pending');
    }
    return runtimeSetupRevision;
  };

  const compileGraphCohort = (requestRevision?: number, requestedDomains?: CompileDomains) => {
    let revision = requestRevision;
    let requested = requestedDomains;
    if (revision === undefined || requested === undefined) {
      clearTimeout(debounceTimer);
      clearTimeout(graphDebounceTimer);
      revision = reserveRuntimeSetupRevision(BOTH_DOMAINS);
      requested = consumePendingCompileDomains();
    }
    if (revision !== runtimeSetupRevision) return;
    if (requested.visual) setCompileState('compiling');
    if (requested.sound) setSoundCompileState('compiling');
    const resolution = passGraphResolution();
    const identityIssue = passGraphIdentityIssue();
    const graphPasses = enabledGraphPasses().filter((pass) => pass === 'sound' ? requested!.sound : requested!.visual);
    const visualGraphPasses = graphPasses.filter((pass): pass is VisualGraphPassId => pass !== 'sound');
    const soundGraphPasses = graphPasses.filter((pass): pass is 'sound' => pass === 'sound');
    let working = { ...graphEditors() };
    const candidates: Parameters<typeof acceptGraphCohort>[1] = {};
    for (const pass of graphPasses) {
      const state = working[pass];
      if (!state) continue;
      const generation = state.generation;
      const started = graphCompileStarted(state, generation);
      const result = compileGraph(state.document, compileOptionsFor(pass));
      working[pass] = graphCompileResolved(started, generation, result);
      if (result.ok && result.artifact) candidates[pass] = { generation, artifact: result.artifact };
    }
    setGraphEditors(working);

    const visualGraphComplete = visualGraphPasses.every((pass) => !!candidates[pass]);
    const soundGraphComplete = soundGraphPasses.every((pass) => !!candidates[pass]);
    const visualTopologyReady = !identityIssue && resolution.ok && !!resolution.resolved;
    if (!api) {
      const runtimeUnavailable = Object.fromEntries(graphPasses.map((pass) => [pass, [{ message: t('app.graph.runtimeUnavailable'), severity: 'error' as const, stage: 'runtime' as const, origin: { kind: 'graph' as const, pass } }]]));
      setGraphEditors(acceptGraphCohort(working, candidates, false, runtimeUnavailable));
      if (requested.visual) setCompileState('pending');
      if (requested.sound) setSoundCompileState('pending');
      return;
    }

    const artifacts = Object.fromEntries(Object.entries(candidates).map(([pass, candidate]) => [pass, candidate!.artifact]));
    const candidateSetup = runtimeSetupForGraphArtifacts(artifacts);
    const requestVisual = requested.visual && visualTopologyReady && visualGraphComplete && !candidateSetup.visualContract.hasErrors;
    const requestSound = requested.sound && soundGraphComplete && !candidateSetup.soundContract.hasErrors;
    const runtimeResult = api.compile(candidateSetup.setup, { visual: requestVisual, sound: requestSound });
    if (revision !== runtimeSetupRevision) return;

    const sourceMaps = Object.fromEntries(Object.entries(candidates).map(([pass, candidate]) => [pass, candidate!.artifact.sourceMap]));
    const identities = Object.fromEntries(Object.entries(candidates).map(([pass, candidate]) => [pass, { sourceHash: candidate!.artifact.sourceHash, revision: candidate!.artifact.revision }]));
    const mapped = fromRuntimeDiagnosticsWithGraphSourceMaps(runtimeResult.diagnostics, sourceMaps, identities);
    const domainDiagnostics = [
      ...candidateSetup.visualContract.diagnostics,
      ...candidateSetup.soundContract.diagnostics,
      ...mapped,
    ];
    if (requested.visual) setVisualDiagnostics(domainDiagnostics.filter((item) => item.origin.pass !== 'sound' && item.origin.kind === 'code'));
    if (requested.sound) setSoundDiagnostics(domainDiagnostics.filter((item) => (item.origin.pass === 'sound' || item.origin.pass === 'common') && item.origin.kind === 'code'));
    const byPass: Partial<Record<GraphPassId, UnifiedDiagnostic[]>> = {};
    for (const pass of graphPasses) byPass[pass] = domainDiagnostics.filter((item) => item.origin.kind === 'graph' && item.origin.pass === pass);

    const visualCandidates = Object.fromEntries(visualGraphPasses.filter((pass) => !!candidates[pass]).map((pass) => [pass, candidates[pass]]));
    const soundCandidates = Object.fromEntries(soundGraphPasses.filter((pass) => !!candidates[pass]).map((pass) => [pass, candidates[pass]]));
    const visualAccepted = requestVisual && runtimeResult.visualOk === true;
    const soundAccepted = requestSound && runtimeResult.soundOk === true;
    let acceptedStates = acceptGraphCohort(working, visualCandidates, visualAccepted, byPass);
    acceptedStates = acceptGraphCohort(acceptedStates, soundCandidates, soundAccepted, byPass);
    setGraphEditors(acceptedStates);
    if (visualAccepted) setSuccessfulRuntimeSetupRevision(visualSetupRevision());
    if (soundAccepted) setSuccessfulSoundRuntimeSetupRevision(soundSetupRevision());

    const acceptedPasses = [...(visualAccepted ? visualGraphPasses : []), ...(soundAccepted ? soundGraphPasses : [])];
    if (acceptedPasses.length) {
      setLoadedGraphPendingRuntimeRecovery((items) => clearAcceptedRuntimeRecoveryFlags(items, acceptedPasses));
      setMeta((project) => {
        const passes = { ...project.passes };
        for (const pass of acceptedPasses) {
          const artifact = candidates[pass]!.artifact;
          passes[pass] = { ...passes[pass], authoring: { kind: 'graph', graphFile: graphFileFor(pass), graphFormatVersion: 1, generatedHash: artifact.sourceHash } };
        }
        return { ...project, passes };
      });
    }
    for (const pass of graphPasses) {
      const passAccepted = pass === 'sound' ? soundAccepted : visualAccepted;
      if (passAccepted || !loadedGraphPendingRuntimeRecovery()[pass] || working[pass]?.runtimeAcceptedArtifact) continue;
      activateReadOnlyGraphRecovery(pass, working[pass]!.document, 'runtime-rejected', [
        ...(byPass[pass] ?? []),
        { message: t('app.graph.persistedRuntimeRejected', { pass }), severity: 'error', stage: 'runtime', code: 'graph.runtime-rejected-recovery', params: { pass }, origin: { kind: 'graph', pass } },
      ]);
    }
    if (requested.visual) setCompileState('ready');
    if (requested.sound) setSoundCompileState('ready');
  };

  const scheduleGraphCompile = (domains: CompileDomains = BOTH_DOMAINS) => {
    clearTimeout(debounceTimer);
    clearTimeout(graphDebounceTimer);
    const requestRevision = reserveRuntimeSetupRevision(domains);
    graphDebounceTimer = setTimeout(() => {
      if (requestRevision !== runtimeSetupRevision) return;
      compileGraphCohort(requestRevision, consumePendingCompileDomains());
    }, 300);
  };

  const updateGraphGroupDocument = (location: GraphGroupLocation, document: GraphDocument): GraphLibraryDocument => normalizeGraphLibrary({
    ...graphLibrary(),
    groups: graphLibrary().groups.map((group) => group.id === location.groupId && group.version === location.version && group.kind === 'graph'
      ? { ...group, graph: { ...group.graph, nodes: document.nodes, edges: document.edges } }
      : group),
  });

  const sameGroupHistoryDocument = (left: GraphDocument, right: GraphDocument) => stableStringify({ nodes: left.nodes, edges: left.edges }) === stableStringify({ nodes: right.nodes, edges: right.edges });

  const applyGroupCommand = (command: GraphCommand) => {
    const pass = activeGraphPass();
    const location = activeGroupPath().at(-1);
    const document = activeGroupDocument();
    const viewportKey = activeGroupKey();
    const historyKey = activeGroupHistoryKey();
    if (!pass || !location || !document || !viewportKey || !historyKey) return;
    if (command.type === 'set-viewport') {
      updateGraphWorkspace({ ...graphWorkspace(), groupViewports: { ...graphWorkspace().groupViewports, [viewportKey]: command.viewport } });
      return;
    }
    const history = groupHistories()[historyKey] ?? createGraphHistory();
    const applied = executeGraphCommand(document, history, command, { registry: graphNodeRegistry(), insideGroup: true });
    if (!applied.changed) return;
    try {
      const library = updateGraphGroupDocument(location, applied.document);
      const updateHistory = () => setGroupHistories((items) => ({ ...items, [historyKey]: applied.history }));
      if (applied.impact === 'semantic') applyGraphLibrarySemanticChange(library, {}, updateHistory);
      else batch(() => { setGraphLibrary(library); updateHistory(); setDirty(true); });
    } catch { notify({ code: 'graph.group-change-rejected' }, 'error'); }
  };

  const applyGraphCommand = (command: GraphCommand) => {
    if (activeEditingGroup()) return applyGroupCommand(command);
    const pass = activeGraphPass();
    if (!pass) return;
    const current = graphEditor(pass);
    if (!current) return;
    const applied = executeGraphCommand(current.document, current.history, command, { registry: graphNodeRegistry() });
    if (!applied.changed) return;
    setGraphEditorFor(pass, applied.impact === 'semantic'
      ? graphSemanticChanged(current, applied.document, applied.history)
      : graphLayoutChanged(current, applied.document, applied.history));
    setDirty(true);
    if (applied.impact === 'semantic') scheduleGraphCompile(domainsForPass(pass));
  };

  const undoGroup = () => {
    const location = activeGroupPath().at(-1);
    const document = activeGroupDocument();
    const historyKey = activeGroupHistoryKey();
    if (!location || !document || !historyKey) return;
    const history = groupHistories()[historyKey] ?? createGraphHistory();
    const entry = history.undo.at(-1);
    if (entry && !sameGroupHistoryDocument(document, entry.after)) {
      setGroupHistories((items) => ({ ...items, [historyKey]: createGraphHistory(history.limit) }));
      return notify(t('app.error.groupUndoHistoryInvalid'), 'error');
    }
    const result = undoGraphCommand(document, history);
    if (!result.changed) return;
    try {
      const library = updateGraphGroupDocument(location, result.document);
      const updateHistory = () => setGroupHistories((items) => ({ ...items, [historyKey]: result.history }));
      if (result.impact === 'semantic') applyGraphLibrarySemanticChange(library, {}, updateHistory);
      else batch(() => { setGraphLibrary(library); updateHistory(); setDirty(true); });
    } catch { notify({ code: 'graph.group-undo-rejected' }, 'error'); }
  };

  const redoGroup = () => {
    const location = activeGroupPath().at(-1);
    const document = activeGroupDocument();
    const historyKey = activeGroupHistoryKey();
    if (!location || !document || !historyKey) return;
    const history = groupHistories()[historyKey] ?? createGraphHistory();
    const entry = history.redo.at(-1);
    if (entry && !sameGroupHistoryDocument(document, entry.before)) {
      setGroupHistories((items) => ({ ...items, [historyKey]: createGraphHistory(history.limit) }));
      return notify(t('app.error.groupRedoHistoryInvalid'), 'error');
    }
    const result = redoGraphCommand(document, history);
    if (!result.changed) return;
    try {
      const library = updateGraphGroupDocument(location, result.document);
      const updateHistory = () => setGroupHistories((items) => ({ ...items, [historyKey]: result.history }));
      if (result.impact === 'semantic') applyGraphLibrarySemanticChange(library, {}, updateHistory);
      else batch(() => { setGraphLibrary(library); updateHistory(); setDirty(true); });
    } catch { notify({ code: 'graph.group-redo-rejected' }, 'error'); }
  };

  const groupDefinitionMatches = (left: NodeGroupDefinition, right: NodeGroupDefinition) => stableStringify(left) === stableStringify(right);
  const graphReferencesGroup = (document: GraphDocument, group: Pick<NodeGroupDefinition, 'id' | 'version'>) => document.nodes.some((node) => node.type === `library.group.${group.id}` && node.typeVersion === group.version);

  const undoGraph = () => {
    if (activeEditingGroup()) return undoGroup();
    const pass = activeGraphPass();
    if (!pass) return;
    const current = graphEditor(pass);
    if (!current) return;
    const entry = current.history.undo.at(-1);
    const undoLibraryGroup = entry?.command.type === 'replace-document' ? entry.command.libraryGroup : undefined;
    if (undoLibraryGroup) {
      const present = graphLibrary().groups.find((group) => group.id === undoLibraryGroup.id && group.version === undoLibraryGroup.version);
      if (!present || !groupDefinitionMatches(present, undoLibraryGroup)) return notify(t('app.error.groupDefinitionChanged'), 'error');
    }
    const result = undoGraphCommand(current.document, current.history);
    if (!result.changed) return;
    let library = graphLibrary();
    if (undoLibraryGroup) {
      const parentReference = (Object.entries(graphEditors()) as Array<[GraphPassId, GraphEditorState]>).some(([candidatePass, state]) => graphReferencesGroup(candidatePass === pass ? result.document : state.document, undoLibraryGroup));
      const groupReference = library.groups.some((group) => group.kind === 'graph' && (group.id !== undoLibraryGroup.id || group.version !== undoLibraryGroup.version) && graphReferencesGroup({ ...result.document, nodes: group.graph.nodes, edges: group.graph.edges }, undoLibraryGroup));
      if (parentReference || groupReference) return notify(t('app.error.groupStillReferenced'), 'error');
      try { library = normalizeGraphLibrary({ ...library, groups: library.groups.filter((group) => group.id !== undoLibraryGroup.id || group.version !== undoLibraryGroup.version) }); }
      catch { return notify({ code: 'graph.group-atomic-undo-failed' }, 'error'); }
      applyGraphLibrarySemanticChange(library, { [pass]: { document: result.document, history: result.history } });
      return;
    }
    setGraphEditorFor(pass, result.impact === 'semantic' ? graphSemanticChanged(current, result.document, result.history) : graphLayoutChanged(current, result.document, result.history));
    setDirty(true);
    if (result.impact === 'semantic') scheduleGraphCompile(domainsForPass(pass));
  };

  const redoGraph = () => {
    if (activeEditingGroup()) return redoGroup();
    const pass = activeGraphPass();
    if (!pass) return;
    const current = graphEditor(pass);
    if (!current) return;
    const entry = current.history.redo.at(-1);
    const redoLibraryGroup = entry?.command.type === 'replace-document' ? entry.command.libraryGroup : undefined;
    const existing = redoLibraryGroup && graphLibrary().groups.find((group) => group.id === redoLibraryGroup.id && group.version === redoLibraryGroup.version);
    if (existing && redoLibraryGroup && !groupDefinitionMatches(existing, redoLibraryGroup)) return notify(t('app.error.groupVersionConflict'), 'error');
    const result = redoGraphCommand(current.document, current.history);
    if (!result.changed) return;
    if (redoLibraryGroup && !existing) {
      let library: GraphLibraryDocument;
      try { library = normalizeGraphLibrary({ ...graphLibrary(), groups: [...graphLibrary().groups, redoLibraryGroup] }); }
      catch { return notify({ code: 'graph.group-atomic-redo-failed' }, 'error'); }
      applyGraphLibrarySemanticChange(library, { [pass]: { document: result.document, history: result.history } });
      return;
    }
    setGraphEditorFor(pass, result.impact === 'semantic' ? graphSemanticChanged(current, result.document, result.history) : graphLayoutChanged(current, result.document, result.history));
    setDirty(true);
    if (result.impact === 'semantic') scheduleGraphCompile(domainsForPass(pass));
  };

  const createNodeGroupFromSelection = async () => {
    const pass = activeGraphPass(); const current = pass && graphEditor(pass);
    if (!pass || !current || activeEditingGroup()) return;
    const title = (await requestTextInput({
      title: t('app.dialog.groupTitle'),
      message: t('app.dialog.groupMessage', { count: current.selection.length }),
      confirmLabel: t('app.dialog.groupTitle'),
      input: { label: t('app.dialog.groupName'), initialValue: t('app.graph.defaultGroupName'), placeholder: t('app.dialog.groupPlaceholder'), maxLength: 96 },
    }))?.trim();
    if (!title) return;
    let index = graphLibrary().groups.length + 1;
    let id = `node_group_${index}`;
    while (graphLibrary().groups.some((group) => group.id === id && group.version === 1)) id = `node_group_${++index}`;
    try {
      const result = buildNodeGroupFromSelection(current.document, current.selection, graphNodeRegistry(), {
        id, title, instanceNodeId: `group-instance-${Date.now().toString(36)}`,
        edgeId: (purpose) => `group-edge-${purpose}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      });
      const library = normalizeGraphLibrary({ ...graphLibrary(), groups: [...graphLibrary().groups, result.group] });
      const command: GraphCommand = { type: 'replace-document', document: result.document, libraryGroup: result.group };
      const applied = executeGraphCommand(current.document, current.history, command, { registry: graphNodeRegistry() });
      if (!applied.changed) return;
      applyGraphLibrarySemanticChange(library, { [pass]: { document: applied.document, history: applied.history } });
      notify(t('app.toast.groupCreated', { title }), 'ok');
    } catch { notify({ code: 'graph.group-create-failed' }, 'error'); }
  };

  const enterNodeGroup = (node: { type: string; typeVersion: number }) => {
    const match = /^library\.group\.([A-Za-z][A-Za-z0-9_]*)$/.exec(node.type);
    if (!match) return;
    const location = { groupId: match[1], version: node.typeVersion };
    if (!nodeGroupAt(location)) return notify(t('app.error.legacyExpressionGroup'), 'error');
    updateGraphWorkspace({ ...graphWorkspace(), editPath: [...graphWorkspace().editPath, location] });
  };

  const navigateGroupBreadcrumb = (depth: number) => updateGraphWorkspace({ ...graphWorkspace(), editPath: graphWorkspace().editPath.slice(0, depth) });

  const createPassGraphEditor = async () => {
    const pass = activeGraphPass();
    if (!pass || !api) return notify(t('app.error.runtimeNotReady'), 'error');
    const sound = pass === 'sound';
    if (!await requestConfirmation({
      title: sound ? t('app.dialog.createSoundGraphTitle') : t('app.dialog.createGraphTitle'),
      message: sound ? t('app.dialog.createSoundGraphMessage') : t('app.dialog.createGraphMessage'),
      confirmLabel: t('app.dialog.createGraphConfirm'),
    })) return;
    const document = createDefaultGraph(pass);
    const transition = sound ? undefined : convertPassGraphTargetToGraph(passGraph(), pass, document);
    batch(() => {
      setGraphCodeBackups((items) => ({ ...items, [pass]: sources()[pass] ?? '' }));
      setGraphEditorFor(pass, createGraphEditorState(transition?.graphDocument ?? document));
      if (transition) setPassGraph(transition.passGraph);
      setMeta((project) => ({ ...project, passes: { ...project.passes, [pass]: { ...project.passes[pass], enabled: true, authoring: { kind: 'graph', graphFile: graphFileFor(pass), graphFormatVersion: 1 } } } }));
      setProjectGraphIssues((items) => items.filter((issue) => issue.pass !== pass));
      setDirty(true);
    });
    clearTimeout(debounceTimer);
    clearTimeout(graphDebounceTimer);
    const requestRevision = reserveRuntimeSetupRevision(domainsForPass(pass));
    setTimeout(() => {
      if (requestRevision !== runtimeSetupRevision) return;
      compileGraphCohort(requestRevision, consumePendingCompileDomains());
    }, 0);
    notify(sound
      ? t('app.toast.soundGraphCreated')
      : t('app.toast.graphCreated', { pass }), 'ok');
  };

  const detachPassGraph = async () => {
    const pass = activeGraphPass();
    if (!pass) return false;
    const state = graphEditor(pass);
    if (!state) return false;
    const detached = detachAcceptedGraph(state, graphLibraryRevision());
    if (!detached) { notify(t('app.error.graphNotRuntimeAccepted'), 'error'); return false; }
    const accepted = await requestConfirmation({
      title: t('app.dialog.toCodeTitle'),
      message: pass === 'sound'
        ? t('app.dialog.toCodeSoundMessage')
        : t('app.dialog.toCodeMessage', { pass }),
      confirmLabel: t('app.dialog.toCodeConfirm'),
      danger: true,
    });
    if (!shouldDetachGraph(accepted, true)) return false;
    let nextPassGraph: PassGraphDocument;
    try {
      nextPassGraph = pass === 'sound' ? passGraph() : convertPassGraphTargetToCode(passGraph(), pass, passGraphResolution().resolved);
    } catch (error) {
      notify(t('app.error.graphConversionFailed', { detail: formatProductMessage(error) }), 'error');
      return false;
    }
    batch(() => {
      updateSource(pass, detached.source);
      setPassGraph(nextPassGraph);
      setMeta((project) => ({ ...project, passes: { ...project.passes, [pass]: { ...project.passes[pass], authoring: { kind: 'code' } } } }));
      setGraphEditorFor(pass, undefined);
      clearGraphRecoveryFor(pass);
      setProjectGraphIssues([]);
      setDirty(true);
    });
    scheduleCompile(domainsForPass(pass));
    notify(graphCodeBackups()[pass] !== undefined
      ? t('app.toast.graphConvertedToCodeWithBackup')
      : t('app.toast.graphConvertedToCode'), 'ok');
    return true;
  };

  const detachGraphFallback = async () => {
    const pass = activeGraphPass();
    if (!pass || !graphFallbackActive(pass)) return;
    if (!await requestConfirmation({
      title: t('app.dialog.recoveryToCodeTitle'),
      message: t('app.dialog.recoveryToCodeMessage'),
      confirmLabel: t('app.dialog.toCodeConfirm'),
      danger: true,
    })) return;
    let nextPassGraph: PassGraphDocument;
    try {
      nextPassGraph = pass === 'sound' ? passGraph() : convertPassGraphTargetToCode(passGraph(), pass, passGraphResolution().resolved);
    } catch (error) {
      notify(t('app.error.passGraphRepairRequired', { detail: formatProductMessage(error) }), 'error');
      return;
    }
    batch(() => {
      setPassGraph(nextPassGraph);
      setMeta((project) => ({ ...project, passes: { ...project.passes, [pass]: { ...project.passes[pass], authoring: { kind: 'code' } } } }));
      clearGraphRecoveryFor(pass);
      setProjectGraphIssues([]);
      setDirty(true);
    });
    scheduleCompile(domainsForPass(pass));
    notify(t('app.toast.graphFallbackConverted'), 'ok');
  };

  const scheduleCompile = (domains: CompileDomains = BOTH_DOMAINS) => {
    clearTimeout(debounceTimer);
    clearTimeout(graphDebounceTimer);
    const requestRevision = reserveRuntimeSetupRevision(domains);
    debounceTimer = setTimeout(() => {
      if (!isCurrentRuntimeSetupRevision(requestRevision, runtimeSetupRevision)) return;
      const requested = consumePendingCompileDomains();
      if (!api) {
        if (requested.visual) setCompileState('pending');
        if (requested.sound) setSoundCompileState('pending');
        return;
      }
      const graphPasses = enabledGraphPasses().filter((pass) => pass === 'sound' ? requested.sound : requested.visual);
      const fallbackPasses = graphPasses.filter((pass) => !graphEditor(pass));
      if (graphPasses.length && fallbackPasses.length === 0) {
        compileGraphCohort(requestRevision, requested);
        return;
      }

      if (requested.visual) setCompileState('compiling');
      if (requested.sound) setSoundCompileState('compiling');
      const identityIssue = passGraphIdentityIssue();
      const resolution = passGraphResolution();
      const visualTopologyReady = !identityIssue && resolution.ok && !!resolution.resolved;
      const requestVisual = requested.visual && visualTopologyReady && !visualUniformContract().hasErrors;
      const requestSound = requested.sound && !soundUniformContract().hasErrors;
      const result = api.compile(runtimeSetup(), { visual: requestVisual, sound: requestSound });
      if (!isCurrentRuntimeSetupRevision(requestRevision, runtimeSetupRevision)) return;

      const runtimeDiagnostics = fromRuntimeDiagnostics(result.diagnostics);
      const visualFallbackPasses = fallbackPasses.filter((pass) => pass !== 'sound');
      const soundFallbackPasses = fallbackPasses.filter((pass) => pass === 'sound');
      const visualAccepted = requestVisual && result.visualOk === true;
      const soundAccepted = requestSound && result.soundOk === true;
      if (visualAccepted) setSuccessfulRuntimeSetupRevision(visualSetupRevision());
      if (soundAccepted) setSuccessfulSoundRuntimeSetupRevision(soundSetupRevision());

      if (requested.visual) {
        const visualItems: UnifiedDiagnostic[] = [
          ...visualUniformContract().diagnostics,
          ...runtimeDiagnostics.filter((item) => item.origin.pass !== 'sound'),
        ];
        if (!visualTopologyReady) {
          const safeResult = api.compile(safeGraphRecoverySetup(), { visual: true, sound: false });
          visualItems.push(
            ...(identityIssue ? [{ message: t('app.graph.identityRecoveryPlaceholder', { detail: identityIssue.message }), severity: 'error' as const, stage: 'runtime' as const, code: identityIssue.code, origin: { kind: 'graph' as const, pass: 'image' as const } }] : []),
            ...fromRuntimeDiagnostics(safeResult.diagnostics),
          );
        } else if (!visualAccepted && visualFallbackPasses.length) {
          const safeResult = api.compile(safeGraphRecoverySetup(), { visual: true, sound: false });
          visualItems.push(
            ...visualFallbackPasses.map((pass) => ({
              message: t('app.graph.visualFallbackRejected', { pass }),
              severity: 'error' as const, stage: 'runtime' as const, code: 'graph.recovery-fallback-rejected',
              params: { pass },
              origin: { kind: 'graph' as const, pass },
            })),
            ...fromRuntimeDiagnostics(safeResult.diagnostics),
          );
        }
        setVisualDiagnostics(visualItems);
        setCompileState('ready');
      }
      if (requested.sound) {
        const soundItems: UnifiedDiagnostic[] = [
          ...soundUniformContract().diagnostics,
          ...runtimeDiagnostics.filter((item) => item.origin.pass === 'sound' || item.origin.pass === 'common'),
        ];
        if (!soundAccepted && soundFallbackPasses.length) {
          soundItems.push(...soundFallbackPasses.map((pass) => ({
            message: t('app.graph.soundFallbackRejected', { pass }),
            severity: 'error' as const, stage: 'runtime' as const, code: 'graph.recovery-fallback-rejected',
            params: { pass },
            origin: { kind: 'graph' as const, pass },
          })));
        }
        setSoundDiagnostics(soundItems);
        setSoundCompileState('ready');
      }
    }, 400);
  };

  const updateSource = (id: SrcPassId, v: string) => {
    setSources((s) => ({ ...s, [id]: v }));
  };

  const preserveDirtyAiUndo = () => {
    setAiUndo((previous) => previous ? { ...previous, dirty: true } : null);
  };

  const handleEditorChange = (id: string, v: string) => {
    const pass = id as SrcPassId;
    updateSource(pass, v);
    if (pass === 'sound' && v.trim() && !meta().passes.sound.enabled) {
      setMeta((current) => ({
        ...current,
        passes: {
          ...current.passes,
          sound: { ...current.passes.sound, enabled: true },
        },
      }));
    }
    setAiUndo(null);
    setLastAppliedAiCode(null);
    setDirty(true);
    scheduleCompile(domainsForPass(pass));
  };

  const applyAiCode = (fragment: string): boolean => {
    const boundary = codeApplyBoundary(imageAuthoring());
    if (!boundary.allowed) {
      notify(t('chat.graphBlocked'), 'error');
      return false;
    }
    if (!fragment.trim()) return false;
    const preview = previewState();
    const original = preview?.backup ?? sources().image ?? '';
    const originalDirty = preview?.dirty ?? dirty();
    setAiUndo({
      code: original,
      dirty: originalDirty,
      previousAppliedCode: lastAppliedAiCode(),
    });
    setLastAppliedAiCode(fragment);
    setPreviewState(null);
    updateSource('image', fragment);
    setDirty(true);
    scheduleCompile(VISUAL_DOMAIN);
    setActiveTab('image');
    notify(t('app.toast.aiCodeApplied'), 'ok');
    return true;
  };

  const undoAiCode = () => {
    const previous = aiUndo();
    if (!previous) return;
    updateSource('image', previous.code);
    setAiUndo(null);
    setLastAppliedAiCode(previous.previousAppliedCode);
    setActiveTab('image');
    setDirty(previous.dirty);
    scheduleCompile(VISUAL_DOMAIN);
    notify(t('app.toast.aiCodeUndone'), 'ok');
  };

  /** 非破坏性预览：连续切换候选时仍保留最初的用户代码。 */
  const startPreview = (name: string, code: string): boolean => {
    const boundary = codeApplyBoundary(imageAuthoring());
    if (!boundary.allowed) {
      notify(t('chat.graphBlocked'), 'error');
      return false;
    }
    if (!code.trim()) return false;
    const currentPreview = previewState();
    setPreviewState({
      name,
      backup: currentPreview?.backup ?? sources().image ?? '',
      dirty: currentPreview?.dirty ?? dirty(),
    });
    updateSource('image', code);
    setActiveTab('image');
    scheduleCompile(VISUAL_DOMAIN);
    return true;
  };

  /** 退出预览并无条件恢复原代码；空字符串同样是有效的项目状态。 */
  const stopPreview = () => {
    const cur = previewState();
    if (!cur) return;
    setPreviewState(null);
    updateSource('image', cur.backup);
    setActiveTab('image');
    setDirty(cur.dirty);
    scheduleCompile(VISUAL_DOMAIN);
  };

  /** M6c：拉取自定义模板池（失败静默保留上次快照） */
  const refreshUserTemplates = async () => {
    try {
      setUserTemplates(await listUserTemplates());
    } catch {
      /* 后端尚未就绪时保持现状 */
    }
  };

  /** M6c：应用自定义模板——先执行 Code authoring 边界，再推进后端阶段机。 */
  const applyUserTemplateCode = async (template: UserTemplateViewDto): Promise<boolean> => {
    const boundary = codeApplyBoundary(imageAuthoring());
    if (!boundary.allowed) {
      notify(t('chat.graphBlocked'), 'error');
      return false;
    }
    let code = template.code;
    try {
      const dto = await adoptTemplate(template.name);
      if (dto.has_code && dto.code_fragment?.trim()) code = dto.code_fragment;
    } catch {
      /* 直落兜底 */
    }
    // Await 期间 authoring 可能变化；提交前由 applyAiCode 再次 fail-closed。
    return applyAiCode(code);
  };

  const applySources = (s: Parameters<typeof sourcesWithDefaults>[0]) => {
    advanceProjectIdentity();
    previousUniformTypes = undefined;
    resetGraphState();
    setProjectGraphIssues([]);
    setGraphCodeBackups({});
    setPreviewState(null);
    setAiUndo(null);
    setLastAppliedAiCode(null);
    setSources(sourcesWithDefaults(s));
  };

  const setPassEnabled = (b: BufferId, en: boolean) => {
    preserveDirtyAiUndo();
    setMeta((m) => ({
      ...m,
      passes: { ...m.passes, [b]: { ...m.passes[b], enabled: en } },
    }));
    if (en && !sources()[b]) updateSource(b, DEFAULT_BUFFER_SHADER);
    if (!en && previewTarget() === b) applyPreviewTarget('image');
    setDirty(true);
    scheduleCompile(VISUAL_DOMAIN);
  };

  const updatePassGraph = (document: PassGraphDocument) => {
    const editorDocuments: Partial<Record<GraphPassId, GraphDocument>> = {};
    for (const pass of GRAPH_PASS_IDS) {
      const state = graphEditors()[pass];
      if (state) editorDocuments[pass] = state.document;
    }
    const plan = planPassGraphIdentityRecovery(
      document,
      meta(),
      editorDocuments,
      graphRecoveryDocuments(),
      graphRecoveryReasonMap(),
    );

    clearTimeout(graphDebounceTimer);
    if (plan.kind === 'blocked') {
      batch(() => {
        setPassGraph(document);
        setDirty(true);
      });
      scheduleCompile(VISUAL_DOMAIN);
      return;
    }

    const promotedPasses = Object.keys(plan.documents) as GraphPassId[];
    batch(() => {
      setPassGraph(document);
      setProjectGraphIssues((items) => items.filter((issue) => !issue.code.startsWith('pass-graph.')));
      setCompileState('pending');
      setGraphEditors((states) => {
        const next = { ...states };
        for (const pass of promotedPasses) {
          if (!next[pass]) next[pass] = createGraphEditorState(plan.documents[pass]!);
        }
        for (const pass of Object.keys(next) as GraphPassId[]) {
          next[pass] = { ...next[pass]!, status: 'pending' };
        }
        return next;
      });
      setGraphRecoveryDocuments((items) => {
        const next = { ...items };
        for (const pass of promotedPasses) delete next[pass];
        return next;
      });
      setGraphRecoveryReasonMap((items) => {
        const next = { ...items };
        for (const pass of promotedPasses) delete next[pass];
        return next;
      });
      setGraphRecoveryDiagnosticMap((items) => {
        const next = { ...items };
        for (const pass of promotedPasses) delete next[pass];
        return next;
      });
      setLoadedGraphPendingRuntimeRecovery((items) => {
        const next = { ...items };
        for (const pass of promotedPasses) next[pass] = true;
        return next;
      });
      setGraphRevealNodeIds((items) => {
        const next = { ...items };
        for (const pass of promotedPasses) delete next[pass];
        return next;
      });
      setDirty(true);
    });

    const graphPasses = enabledGraphPasses();
    const allEnabledGraphsEditable = graphPasses.length > 0
      && graphPasses.every((pass) => !!editorDocuments[pass] || !!plan.documents[pass]);
    if (allEnabledGraphsEditable) scheduleGraphCompile(VISUAL_DOMAIN);
    else scheduleCompile(VISUAL_DOMAIN);
  };

  const setPassFeedback = (buffer: BufferId, feedback: boolean) => {
    preserveDirtyAiUndo();
    const existing = passGraph().edges.find((edge) => edge.source === buffer && edge.target === buffer && edge.timing === 'previous');
    if (!feedback) {
      if (existing) updatePassGraph({ ...passGraph(), edges: passGraph().edges.filter((edge) => edge.id !== existing.id) });
      return;
    }
    if (existing) return;
    const config = meta().passes[buffer];
    const endpoint = config.authoring?.kind === 'graph'
      ? allGraphDocuments()[buffer]?.nodes.find((node) => node.type === 'input.channel-sample')?.id
      : undefined;
    if (config.authoring?.kind === 'graph' && !endpoint) return notify(t('app.error.graphFeedbackNeedsSample'), 'error');
    const used = new Set((passGraphResolution().resolved?.edges ?? []).filter((edge) => edge.target === buffer).map((edge) => edge.slot));
    const slot = ([0, 1, 2, 3] as const).find((candidate) => !used.has(candidate));
    if (slot === undefined) return notify(t('app.error.passChannelsFull'), 'error');
    updatePassGraph({ ...passGraph(), edges: [...passGraph().edges, {
      id: `feedback-${buffer}-${Date.now().toString(36)}`, source: buffer, target: buffer,
      endpoint: endpoint ? { kind: 'graph-channel', nodeId: endpoint } : { kind: 'code-slot', slot },
      slot: { mode: 'manual', index: slot }, filter: 'linear', wrap: 'repeat', timing: 'previous',
    }] });
  };

  const setPassChannel = (pass: 'image' | BufferId, chIndex: number, src: string) => {
    preserveDirtyAiUndo();
    if (passAuthoring(pass) === 'graph') return notify(t('app.error.graphPassUsePassGraph'), 'error');
    const edges = passGraph().edges.filter((edge) => !(edge.target === pass && edge.endpoint.kind === 'code-slot' && edge.endpoint.slot === chIndex));
    if (src && isBufferId(src)) edges.push({
      id: `code-${pass}-${chIndex}-${Date.now().toString(36)}`, source: src, target: pass,
      endpoint: { kind: 'code-slot', slot: chIndex as 0 | 1 | 2 | 3 }, slot: { mode: 'manual', index: chIndex as 0 | 1 | 2 | 3 },
      filter: 'linear', wrap: 'repeat', timing: pass === 'image' ? 'current' : 'previous',
    });
    updatePassGraph({ ...passGraph(), edges });
  };

  const getPassChannel = (pass: 'image' | BufferId, chIndex: number): string =>
    passGraphResolution().resolved?.edges.find((edge) => edge.target === pass && edge.slot === chIndex)?.source ?? '';

  const applyPreviewTarget = (t: RenderPassId) => {
    setPreviewTarget(t);
    api?.setPreviewTarget(t);
  };

  const setUniformValue = (name: string, v: UniformValue) => {
    preserveDirtyAiUndo();
    setUniformValues((prev) => ({ ...prev, [name]: v }));
    api?.setUniform(name, v);
    setDirty(true);
    const declarations = uniformDecls().filter((decl) => decl.name === name);
    scheduleCompile({
      visual: declarations.some((decl) => decl.pass !== 'sound'),
      sound: declarations.some((decl) => decl.pass === 'common' || decl.pass === 'sound'),
    });
  };

  const confirmUnsaved = async () =>
    !dirty() || await requestConfirmation({
      title: t('app.dialog.unsavedTitle'),
      message: t('app.dialog.unsavedMessage'),
      confirmLabel: t('app.dialog.discardContinue'),
      danger: true,
    });

  const newProject = async () => {
    if (!await confirmUnsaved()) return;
    applySources({ image: DEFAULT_SHADER });
    for (const texture of runtimeTextureAssets()) if (texture.source && 'close' in texture.source) (texture.source as ImageBitmap).close();
    setAssetManifest(createAssetManifest());
    setAssetPayloads({});
    setRuntimeTextureAssets([]);
    setGraphLibrary(createGraphLibrary());
    setMeta(createProject(t('app.project.unnamed')));
    setPassGraph(createPassGraphDocument());
    setProjectGraphIssues([]);
    setProjectName(t('app.project.unnamed'));
    setProjectDir(null);
    setUniformValues({});
    setPreviewTarget('image');
    api?.setPreviewTarget('image');
    setDiagnostics([]);
    setActiveTab('image');
    setDirty(true);
    scheduleCompile();
    notify(t('app.toast.projectCreated'), 'ok');
  };

  const activateGraph = (document: GraphDocument, recoverOnFirstRuntimeReject = false) => {
    const pass = document.pass;
    clearGraphRecoveryFor(pass);
    if (recoverOnFirstRuntimeReject) {
      setLoadedGraphPendingRuntimeRecovery((items) => ({ ...items, [pass]: true }));
    }
    setGraphEditorFor(pass, createGraphEditorState(document));
  };

  const activatePersistedGraph = (
    document: GraphDocument,
    options: CompileGraphOptions,
    identityValid = true,
    preservedRecovery?: { reason: GraphRecoveryReason; diagnostics: UnifiedDiagnostic[] },
  ): boolean => {
    const classification = classifyPersistedGraph(document, options);
    if (classification.kind === 'readonly-recovery') {
      activateReadOnlyGraphRecovery(document.pass, document, 'compiler-invalid', classification.diagnostics);
      return false;
    }
    if (preservedRecovery?.reason === 'runtime-rejected') {
      activateReadOnlyGraphRecovery(document.pass, document, preservedRecovery.reason, preservedRecovery.diagnostics);
      return false;
    }
    const decision = persistedGraphRecoveryDecision(classification, identityValid);
    if (decision.kind === 'readonly-recovery') {
      activateReadOnlyGraphRecovery(document.pass, document, decision.reason, decision.diagnostics);
      return false;
    }
    activateGraph(document, true);
    return true;
  };

  const applyTemplate = async (template: ProjectTemplate) => {
    const graphCompilation = template.graph ? compileGraph(template.graph.document) : undefined;
    if (graphCompilation && (!graphCompilation.ok || !graphCompilation.artifact)) {
      notify(t('app.error.graphTemplateCompileFailed'), 'error');
      return;
    }
    if (!await confirmUnsaved()) return;
    setTemplateOpen(false);
    closeMenu();
    const display = getBuiltinTemplateDisplay(template);
    const canonicalName = getTemplateCanonicalName(template);
    const m = createProject(canonicalName);
    for (const b of template.buffers) {
      m.passes[b.id] = {
        ...m.passes[b.id],
        enabled: true,
        feedback: b.feedback,
      };
    }
    if (template.sound) m.passes.sound = { ...m.passes.sound, enabled: true };
    if (template.graph && graphCompilation?.artifact) {
      m.passes.image = {
        ...m.passes.image,
        authoring: {
          kind: 'graph',
          graphFile: 'graphs/image.shadergraph.json',
          graphFormatVersion: template.graph.document.version,
          generatedHash: graphCompilation.artifact.sourceHash,
        },
      };
    }
    applySources(template.sources);
    for (const texture of runtimeTextureAssets()) if (texture.source && 'close' in texture.source) (texture.source as ImageBitmap).close();
    setAssetManifest(createAssetManifest());
    setAssetPayloads({});
    setRuntimeTextureAssets([]);
    setGraphLibrary(createGraphLibrary());
    setMeta(m);
    setPassGraph(passGraphFromLegacy(m));
    setProjectGraphIssues([]);
    setProjectName(canonicalName);
    setProjectDir(null);
    setUniformValues({});
    setPreviewTarget('image');
    api?.setPreviewTarget('image');
    setDiagnostics([]);
    setActiveTab('image');
    setDirty(true);
    if (template.graph) {
      activateGraph(template.graph.document);
      setTimeout(() => compileGraphCohort(), 0);
    } else scheduleCompile();
    notify(t('app.toast.projectCreatedFromTemplate', { name: display.name }), 'ok');
  };

  const openProject = async () => {
    if (!await confirmUnsaved()) return;
    let dir: string | null;
    try {
      dir = await pickFolder(t('app.picker.openProject'));
    } catch (e) {
      notify(t('app.error.projectOpenFailed', { detail: formatProductMessage(e) }), 'error');
      return;
    }
    if (!dir) return;
    try {
      const opened = await openProjectFrom(dir);
      const decodedTextures = await decodeTextureManifest(opened.assetManifest, opened.assetPayloads);
      for (const texture of runtimeTextureAssets()) if (texture.source && 'close' in texture.source) (texture.source as ImageBitmap).close();
      setAssetManifest(opened.assetManifest);
      setAssetPayloads(opened.assetPayloads);
      setRuntimeTextureAssets(decodedTextures);
      setGraphLibrary(opened.graphLibrary);
      applySources(opened.sources);
      setGraphWorkspace(opened.graphWorkspace);
      setGroupSelections({});
      setGroupHistories({});
      setMeta(opened.meta);
      setPassGraph(opened.passGraph);
      setProjectGraphIssues(opened.graphIssues);
      setUniformValues(valuesFromPersisted(opened.meta.uniforms));
      setProjectName(opened.meta.name || t('app.project.unnamed'));
      setProjectDir(opened.dir);
      setPreviewTarget('image');
      api?.setPreviewTarget('image');
      setDiagnostics([]);
      setActiveTab('image');
      setDirty(opened.needsResave);
      const graphPasses = ALL_GRAPH_PASS_IDS.filter((pass) => opened.meta.passes[pass].authoring?.kind === 'graph');
      let editableGraphCount = 0;
      for (const pass of graphPasses) {
        const document = opened.graphDocuments[pass];
        const options = compileOptionsFor(pass);
        if (document && activatePersistedGraph(document, options, pass === 'sound' || (opened.passGraphIdentityValid && !!opened.resolvedPassGraph))) editableGraphCount++;
      }
      if (editableGraphCount === graphPasses.length && graphPasses.length) setTimeout(() => compileGraphCohort(), 0);
      else scheduleCompile();
      const fallback = editableGraphCount !== graphPasses.length || !opened.passGraphIdentityValid;
      notify(
        fallback
          ? t('app.toast.projectOpenedWithFallback', { name: opened.meta.name })
          : opened.needsResave
            ? t('app.toast.projectOpenedNeedsResave', { name: opened.meta.name })
            : t('app.toast.projectOpened', { name: opened.meta.name }),
        fallback ? 'error' : 'ok',
      );
    } catch (e) {
      notify(t('app.error.projectOpenFailed', { detail: formatProductMessage(e) }), 'error');
    }
  };

  const currentGraphSaveOptions = () => {
    const uniformConflict = currentUniformConflict();
    if (uniformConflict) throw new ProductError({
      code: uniformConflict.code ?? 'uniform.type-conflict',
      ...(uniformConflict.params ? { params: uniformConflict.params } : {}),
      ...(uniformConflict.rawDetail !== undefined ? { rawDetail: uniformConflict.rawDetail } : {}),
      fallback: uniformConflict.message,
    });
    const blockingIdentity = passGraphIdentityIssue();
    if (blockingIdentity) throw new ProductError({
      code: blockingIdentity.code,
      ...(blockingIdentity.params ? { params: blockingIdentity.params } : {}),
      ...(blockingIdentity.rawDetail !== undefined ? { rawDetail: blockingIdentity.rawDetail } : {}),
      fallback: blockingIdentity.message,
    });
    const resolution = passGraphResolution();
    if (!resolution.ok || !resolution.resolved) {
      const diagnostic = resolution.diagnostics[0];
      throw new ProductError({
        code: diagnostic?.code ?? 'project.pass-graph-invalid',
        ...(diagnostic?.params ? { params: diagnostic.params } : {}),
        ...(diagnostic?.rawDetail !== undefined ? { rawDetail: diagnostic.rawDetail } : {}),
        fallback: diagnostic?.message ?? '项目 Pass Graph 无效',
      }, { cause: resolution.diagnostics });
    }
    const graphDocuments: Partial<Record<GraphPassId, GraphDocument>> = {};
    const artifacts: Partial<Record<GraphPassId, GraphArtifact>> = {};
    const graphCompileOptions: Partial<Record<GraphPassId, CompileGraphOptions>> = {};
    for (const pass of ALL_GRAPH_PASS_IDS.filter((id) => passAuthoring(id) === 'graph')) {
      const state = graphEditor(pass);
      if (!state) {
        throw new ProductError({
          code: 'graph.document-missing',
          params: { pass },
          fallback: graphFallbackActive(pass)
            ? t('app.error.graphReadonlyRecovery', { pass })
            : t('app.error.graphEditorMissing', { pass }),
        });
      }
      const runtimeAcceptanceRequired = meta().passes[pass].enabled;
      const options = compileOptionsFor(pass);
      const selection = selectGraphPersistenceArtifact(state, runtimeAcceptanceRequired, options);
      if (!selection.ok) {
        const diagnostic = selection.diagnostics[0];
        throw new ProductError({
          code: diagnostic?.code ?? (runtimeAcceptanceRequired ? 'graph.artifact-missing' : 'graph.compile-failed'),
          ...(diagnostic?.params ? { params: diagnostic.params } : { params: { pass } }),
          ...(diagnostic?.rawDetail !== undefined ? { rawDetail: diagnostic.rawDetail } : {}),
          fallback: diagnostic?.message ?? (runtimeAcceptanceRequired
            ? t('app.error.graphNotAcceptedForSave', { pass, detail: '' })
            : t('app.error.disabledGraphCompileFailed', { pass, detail: '' })),
        }, { cause: selection.diagnostics });
      }
      graphDocuments[pass] = state.document;
      artifacts[pass] = selection.artifact;
      graphCompileOptions[pass] = options;
    }
    return {
      graphDocuments,
      graphArtifacts: artifacts,
      graphCompileOptions,
      passGraph: passGraph(),
      assetManifest: assetManifest(),
      assetPayloads: assetPayloads(),
      graphLibrary: graphLibrary(),
      graphWorkspace: graphWorkspace(),
    };
  };

  const saveProjectAs = async () => {
    if (currentUniformConflict()) {
      notify(t('app.error.projectSaveFailed', { detail: currentUniformConflictMessage() }), 'error');
      return;
    }
    let dir: string | null;
    try {
      dir = await pickFolder(t('app.picker.saveProject'), projectName());
    } catch (e) {
      notify(t('app.error.projectSaveFailed', { detail: formatProductMessage(e) }), 'error');
      return;
    }
    if (!dir) return;
    try {
      const m = meta();
      const full: ShaderlabProject = {
        ...m,
        name: projectName(),
        created: m.created || new Date().toISOString(),
        uniforms: toPersistedUniforms(uniformDecls(), uniformValues()),
      };
      const saved = await saveProjectTo(dir, full, effectiveSources(), currentGraphSaveOptions());
      setMeta(saved);
      setProjectGraphIssues([]);
      advanceProjectIdentity();
      setProjectDir(dir);
      setDirty(false);
      notify(t('app.toast.projectSavedTo', { path: dir }), 'ok');
    } catch (e) {
      notify(t('app.error.projectSaveFailed', { detail: formatProductMessage(e) }), 'error');
    }
  };

  const saveProject = async () => {
    if (currentUniformConflict()) {
      notify(t('app.error.projectSaveFailed', { detail: currentUniformConflictMessage() }), 'error');
      return;
    }
    if (!projectDir()) {
      await saveProjectAs();
      return;
    }
    try {
      const m = meta();
      const full: ShaderlabProject = {
        ...m,
        name: projectName(),
        uniforms: toPersistedUniforms(uniformDecls(), uniformValues()),
      };
      const saved = await saveProjectTo(projectDir()!, full, effectiveSources(), currentGraphSaveOptions());
      setMeta(saved);
      setProjectGraphIssues([]);
      setDirty(false);
      notify(t('app.toast.projectSaved'), 'ok');
    } catch (e) {
      notify(t('app.error.projectSaveFailed', { detail: formatProductMessage(e) }), 'error');
    }
  };

  const importShadertoy = async () => {
    if (!await confirmUnsaved()) return;
    let file: string | null;
    try {
      file = await pickFile(t('app.picker.importShadertoyJson'), ['json']);
    } catch (e) {
      notify(t('app.error.shadertoyImportFailed', { detail: formatProductMessage(e) }), 'error');
      return;
    }
    if (!file) return;
    try {
      const text = await readTextFile(file);
      const imp = parseShadertoyJson(text);
      applySources(imp.sources);
      for (const texture of runtimeTextureAssets()) if (texture.source && 'close' in texture.source) (texture.source as ImageBitmap).close();
      setAssetManifest(createAssetManifest());
      setAssetPayloads({});
      setRuntimeTextureAssets([]);
      setGraphLibrary(createGraphLibrary());
      const m = createProject(imp.name || t('app.project.shadertoyImportName'));
      m.description = imp.description;
      for (const bid of BUFFER_IDS) {
        const cfg = imp.buffers[bid];
        if (cfg) {
          m.passes[bid] = {
            ...m.passes[bid],
            enabled: cfg.enabled,
            feedback: cfg.feedback,
            channels: cfg.channels,
          };
        }
      }
      const imgCfg = imp.buffers.image;
      if (imgCfg) m.passes.image = { ...m.passes.image, channels: imgCfg.channels };
      if (imp.sound) m.passes.sound = { ...m.passes.sound, enabled: true };
      setMeta(m);
      setPassGraph(passGraphFromLegacy(m));
      setProjectGraphIssues([]);
      setProjectName(m.name);
      setProjectDir(null);
      setUniformValues({});
      setPreviewTarget('image');
      api?.setPreviewTarget('image');
      setDiagnostics([]);
      setActiveTab('image');
      setDirty(true);
      scheduleCompile();
      const warnings = imp.warnings.map((warning) => formatProductMessage(warning));
      notify(warnings.length
        ? t('app.toast.shadertoyImportedWithSkipped', {
          name: m.name,
          skipped: joinLocalized(warnings),
        })
        : t('app.toast.shadertoyImported', { name: m.name }), 'ok');
    } catch (e) {
      notify(t('app.error.shadertoyImportFailed', { detail: formatProductMessage(e) }), 'error');
    }
  };

  const exportShadertoyJson = async () => {
    const requirements = shadertoyExportRequirements();
    const eligibility = shadertoyExportEligibility();
    if (!eligibility.eligible || !eligibility.ticket) {
      notify(eligibility.reason ? formatProductMessage(eligibility.reason) : t('app.error.contentNotExportable'), 'error');
      return;
    }
    const representationIssue = shadertoyRepresentationIssue();
    if (representationIssue) return notify(t('app.error.shadertoyExportFailed', { detail: formatProductMessage(representationIssue) }), 'error');
    let dir: string | null;
    try {
      dir = await pickFolder(t('app.picker.exportShadertoyJson'));
    } catch (e) {
      notify(t('app.error.exportFailed', { detail: formatProductMessage(e) }), 'error');
      return;
    }
    if (!dir) return;
    try {
      const full: ShaderlabProject = { ...effectiveProjectMeta(), name: projectName() };
      const text = toShadertoyJson(full, effectiveSources());
      const name = shadertoyFileName(projectName());
      const guard = validateExportTicket(eligibility.ticket, currentExportInput(requirements));
      if (!guard.eligible) return notify(guard.reason ? formatProductMessage(guard.reason) : t('app.error.exportContentChanged'), 'error');
      const path = joinPath(dir, name);
      await writeTextFile(path, text);
      notify(t('app.toast.shadertoyExported', { path }), 'ok');
    } catch (e) {
      notify(t('app.error.exportFailed', { detail: formatProductMessage(e) }), 'error');
    }
  };

  const exportGraphGeneratedFragment = async () => {
    const pass = activeGraphPass();
    if (!pass) return notify(t('app.error.passDoesNotSupportGraph'), 'error');
    const requirements = pass === 'sound' ? SOUND_EXPORT : VISUAL_EXPORT;
    const eligibility = currentExportEligibility(requirements);
    if (!eligibility.eligible || !eligibility.ticket) return notify(eligibility.reason ? formatProductMessage(eligibility.reason) : t('app.error.generatedCodeNotExportable'), 'error');
    const source = generatedCodeSelection().source;
    if (!generatedCodeSelection().accepted || !source.trim()) return notify(t('app.error.onlyRuntimeAcceptedCode'), 'error');
    try {
      const dir = await pickFolder(t('app.picker.exportGraphGlsl'));
      if (!dir) return;
      const artifact = fragmentExportArtifact(projectName(), pass, source);
      const guard = validateExportTicket(eligibility.ticket, currentExportInput(requirements));
      if (!guard.eligible) return notify(guard.reason ? formatProductMessage(guard.reason) : t('app.error.exportContentChanged'), 'error');
      await writeTextFile(joinPath(dir, artifact.fileName), artifact.contents);
      notify(t('app.toast.fileExported', { fileName: artifact.fileName }), 'ok');
    } catch (error) {
      notify(t('app.error.exportFailed', { detail: formatProductMessage(error) }), 'error');
    }
  };

  const exportGraphJson = async () => {
    const document = graphEditor()?.document ?? graphRecoveryDocument();
    if (!document) return notify(t('app.error.noGraphSource'), 'error');
    try {
      const artifact = graphJsonExportArtifact(projectName(), document);
      const dir = await pickFolder(t('app.picker.exportGraphJson'));
      if (!dir) return;
      await writeTextFile(joinPath(dir, artifact.fileName), artifact.contents);
      notify(graphEditor() && !graphIsStale(graphEditor()!, graphLibraryRevision())
        ? t('app.toast.graphJsonExported', { fileName: artifact.fileName })
        : t('app.toast.graphJsonBackupExported', { fileName: artifact.fileName }), 'ok');
    } catch (error) {
      notify(t('app.error.graphJsonExportFailed', { detail: formatProductMessage(error) }), 'error');
    }
  };

  function persistSession(cleanExit: boolean) {
    writeSession({
      cleanExit,
      projectDir: projectDir(),
      projectName: projectName(),
      autosavePath: autosaveInfo.path,
      autosaveAt: autosaveInfo.savedAt,
    });
  }

  const runAutosave = async () => {
    if (!dirty() || currentUniformConflict()) return;
    const requestIdentity = projectIdentity;
    const requestProjectDir = projectDir();
    const requestProjectName = projectName();
    try {
      const uniforms = toPersistedUniforms(uniformDecls(), uniformValues());
      const snapshotMeta: ShaderlabProject = {
        ...meta(),
        name: requestProjectName,
        uniforms,
      };
      const r = await writeAutosave(
        requestProjectDir,
        snapshotMeta,
        effectiveSources(),
        uniforms,
        allGraphDocuments(),
        passGraph(),
        {
          reasons: graphRecoveryReasonMap(),
          diagnostics: graphRecoveryDiagnosticMap(),
        },
        { assetManifest: assetManifest(), assetPayloads: assetPayloads(), graphLibrary: graphLibrary(), graphWorkspace: graphWorkspace() },
      );
      if (requestIdentity !== projectIdentity
        || requestProjectDir !== projectDir()
        || requestProjectName !== projectName()) return;
      autosaveInfo = { path: r.path || undefined, savedAt: r.savedAt };
      persistSession(false);
    } catch {
      return;
    }
  };

  createEffect(() => {
    projectDir();
    projectName();
    persistSession(false);
  });

  createEffect(() => {
    document.title = `${dirty() ? '*' : ''}${projectName()} - ShaderLab Pro`;
  });

  createEffect(() => {
    const ids = tabs().map((t) => t.id);
    if (!ids.includes(activeTab())) setActiveTab('image');
  });

  const doRecover = async () => {
    const recoverDir = bootSession?.projectDir ?? projectDir();
    const snap = await readLatestAutosave(recoverDir);
    setRecover(null);
    if (!snap) {
      notify(t('app.autosave.none'), 'error');
      return;
    }
    let recoveredMeta = snap.meta;
    if (snap.legacy) {
      let baseMeta = meta();
      if (recoverDir) {
        try {
          baseMeta = (await openProjectFrom(recoverDir)).meta;
        } catch {
          // Source-only legacy snapshots still recover against the in-memory project metadata.
        }
      }
      recoveredMeta = {
        ...baseMeta,
        name: snap.name || baseMeta.name,
        uniforms: snap.uniforms,
      };
    }
    const recoveredAssets = snap.assetManifest ? normalizeAssetManifest(snap.assetManifest) : createAssetManifest();
    const recoveredLibrary = snap.graphLibrary ? normalizeGraphLibrary(snap.graphLibrary) : createGraphLibrary();
    const recoveredPayloads = snap.assetPayloads ?? {};
    const recoveredRuntimeTextures = await decodeTextureManifest(recoveredAssets, recoveredPayloads);
    for (const texture of runtimeTextureAssets()) if (texture.source && 'close' in texture.source) (texture.source as ImageBitmap).close();
    setAssetManifest(recoveredAssets);
    setAssetPayloads(recoveredPayloads);
    setRuntimeTextureAssets(recoveredRuntimeTextures);
    setGraphLibrary(recoveredLibrary);
    applySources(snap.sources);
    setGraphWorkspace(snap.graphWorkspace ? normalizeGraphWorkspaceUi(snap.graphWorkspace) : createGraphWorkspaceUi());
    setGroupSelections({});
    setGroupHistories({});
    const recoveryIssues: GraphProjectIssue[] = [];
    let recoveredDocuments: Partial<Record<GraphPassId, GraphDocument>> = {};
    for (const pass of ALL_GRAPH_PASS_IDS) {
      if (recoveredMeta.passes[pass].authoring?.kind !== 'graph') continue;
      const raw = snap.graphDocuments?.[pass];
      if (!raw) {
        recoveryIssues.push({ pass, severity: 'error', code: 'graph.missing', message: t('app.autosave.graphMissing', { pass }) });
        continue;
      }
      const parsed = parseProjectGraph(JSON.stringify(raw), pass);
      recoveryIssues.push(...parsed.issues);
      if (parsed.document) recoveredDocuments[pass] = parsed.document;
    }
    let recoveredPassGraph: PassGraphDocument;
    try {
      if (snap.passGraph) recoveredPassGraph = parsePassGraph(snap.passGraph);
      else if (!recoveredMeta.passGraph) {
        const migration = migratePassGraphFromLegacy(recoveredMeta, recoveredDocuments);
        recoveredPassGraph = migration.passGraph;
        recoveredDocuments = migration.graphDocuments;
      } else throw new ProductError({ code: 'project.autosave-pass-graph-snapshot-missing' });
    } catch (error) {
      recoveredPassGraph = createPassGraphDocument();
      const descriptor = error instanceof ProductError ? error.descriptor : undefined;
      recoveryIssues.push({
        pass: 'image',
        severity: 'error',
        code: descriptor?.code ?? 'pass-graph.invalid',
        stage: 'graph-schema',
        message: descriptor?.fallback ?? t('app.autosave.passGraphRecoveryFailed', { detail: '' }),
        ...(descriptor?.params ? { params: descriptor.params } : {}),
        ...(descriptor?.rawDetail !== undefined
          ? { rawDetail: descriptor.rawDetail }
          : !descriptor
            ? { rawDetail: error instanceof Error ? error.message : String(error) }
            : {}),
      });
    }
    const recoveredResolution = resolvePassGraph(recoveredPassGraph, recoveredMeta, recoveredDocuments);
    const recoveryIdentityIssues = recoveredMeta.passGraph
      ? passGraphReferenceIssues(recoveredMeta.passGraph, recoveredPassGraph, recoveredResolution.resolved)
      : [];
    recoveryIssues.push(...recoveryIdentityIssues.map((item) => ({
      pass: 'image' as const,
      severity: 'error' as const,
      code: item.code,
      stage: 'graph-schema' as const,
      message: item.message,
      ...(item.params ? { params: item.params } : {}),
      ...(item.rawDetail !== undefined ? { rawDetail: item.rawDetail } : {}),
    })));
    recoveryIssues.push(...recoveredResolution.diagnostics.map((item) => ({
      pass: item.origin.pass as GraphPassId,
      severity: 'error' as const,
      code: item.code ?? 'pass-graph.invalid',
      message: item.message,
      stage: item.stage,
      ...(item.params ? { params: item.params } : {}),
      ...(item.rawDetail !== undefined ? { rawDetail: item.rawDetail } : {}),
      origin: item.origin,
      ...(item.relatedOrigins ? { relatedOrigins: item.relatedOrigins } : {}),
    })));
    setMeta(recoveredMeta);
    setPassGraph(recoveredPassGraph);
    let editableCount = 0;
    for (const pass of ALL_GRAPH_PASS_IDS) {
      const document = recoveredDocuments[pass];
      if (!document) continue;
      const options = compileOptionsFor(pass);
      const compilationIssues = inspectGraphCompilation(pass, document, options);
      recoveryIssues.push(...compilationIssues);
      const identityValid = recoveredResolution.ok
        && !!recoveredResolution.resolved
        && recoveryIdentityIssues.length === 0;
      const preservedRecovery = snap.graphRecovery?.reasons?.[pass] === 'runtime-rejected'
        ? {
          reason: 'runtime-rejected' as const,
          diagnostics: snap.graphRecovery.diagnostics?.[pass] ?? [],
        }
        : undefined;
      if (activatePersistedGraph(document, options, identityValid, preservedRecovery)) editableCount++;
    }
    setProjectGraphIssues(recoveryIssues);
    const expectedGraphs = ALL_GRAPH_PASS_IDS.filter((pass) => recoveredMeta.passes[pass].authoring?.kind === 'graph').length;
    if (editableCount === expectedGraphs && expectedGraphs > 0) setTimeout(() => compileGraphCohort(), 0);
    else scheduleCompile();
    setProjectName(recoveredMeta.name || snap.name || t('app.project.unnamed'));
    setProjectDir(recoverDir);
    setUniformValues(valuesFromPersisted(snap.uniforms));
    setDiagnostics([]);
    setDirty(true);
    notify(
      editableCount !== expectedGraphs || recoveryIdentityIssues.length > 0
        ? t('app.autosave.partialRecovery')
        : t('app.autosave.restoredUnsaved'),
      editableCount !== expectedGraphs || recoveryIdentityIssues.length > 0 ? 'error' : 'ok',
    );
  };

  const discardRecover = () => {
    if (!projectDir()) clearScratchAutosave();
    setRecover(null);
  };

  const jumpTo = (diagnostic: UnifiedDiagnostic) => {
    const origin = diagnostic.origin;
    setActiveTab(origin.pass);
    if (origin.kind === 'graph') {
      if (isGraphPassId(origin.pass) && graphEditor(origin.pass) && origin.nodeId) {
        setGraphEditorFor(origin.pass, (state) => state ? { ...state, selection: [origin.nodeId!] } : state);
        setGraphRevealNodeIds((items) => ({ ...items, [origin.pass]: undefined }));
        setTimeout(() => setGraphRevealNodeIds((items) => ({ ...items, [origin.pass]: origin.nodeId })), 0);
      }
      return;
    }
    setTimeout(() => {
      if (!editorRef) return;
      const max = editorRef.getModel()?.getLineCount() ?? origin.line;
      const ln = Math.max(1, Math.min(origin.line, max));
      editorRef.revealLineInCenter(ln);
      editorRef.setPosition({ lineNumber: ln, column: Math.max(1, origin.column) });
      editorRef.focus();
    }, 30);
  };

  const togglePlay = () => setPlaying((p) => !p);
  const renameProject = (value: string) => {
    preserveDirtyAiUndo();
    setProjectName(value);
    setDirty(true);
  };
  const finishProjectRename = () => {
    if (!projectName().trim()) setProjectName(t('app.project.unnamed'));
  };
  const applySpeed = (v: number) => {
    setSpeed(v);
    api?.setSpeed(v);
  };
  const seek = (t: number) => api?.seek(t);
  const timelineMax = () =>
    Math.max(30, Math.ceil((scrubbing() ? scrubValue() : stats().time) / 30) * 30);

  const updateEditorRatio = (ratio: number) => {
    const next = Math.min(0.85, Math.max(0.15, ratio));
    setEditorRatio(next);
    localStorage.setItem('shaderlab-editor-ratio', String(next));
  };

  const onDividerDown = (e: PointerEvent) => {
    dividerDragging = true;
    document.body.classList.add('resizing');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDividerMove = (e: PointerEvent) => {
    if (!dividerDragging || !workspaceRef) return;
    const rect = workspaceRef.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    updateEditorRatio(ratio);
  };
  const onDividerUp = () => {
    dividerDragging = false;
    document.body.classList.remove('resizing');
  };
  const onDividerKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Home') {
      e.preventDefault();
      updateEditorRatio(0.15);
    } else if (e.key === 'End') {
      e.preventDefault();
      updateEditorRatio(0.85);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const direction = e.key === 'ArrowLeft' ? -1 : 1;
      updateEditorRatio(editorRatio() + direction * (e.shiftKey ? 0.1 : 0.025));
    }
  };

  // Legacy development bridge; the visible UI uses explicit auto/fixed preview sizing.
  const applyResolution = (s: number) => api?.setResolutionScale(s);
  const applyPreviewResolution = (next: PreviewResolution) => {
    try {
      api?.setPreviewResolution(next);
      setPreviewResolution(next);
      persistPreviewResolution(next);
      if (next.mode === 'fixed') {
        setCustomPreviewWidth(String(next.width));
        setCustomPreviewHeight(String(next.height));
      }
      return true;
    } catch (error) {
      notify({ code: 'runtime.preview-resolution-failed' }, 'error');
      return false;
    }
  };
  const applyCustomPreviewResolution = () => {
    const width = Number(customPreviewWidth());
    const height = Number(customPreviewHeight());
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      notify(t('preview.invalidInteger'), 'error');
      return;
    }
    if (applyPreviewResolution({ mode: 'fixed', width, height })) setPreviewResolutionOpen(false);
  };
  const previewResolutionLabel = () => {
    const resolution = previewResolution();
    return resolution.mode === 'auto'
      ? t('preview.auto')
      : `${resolution.width}×${resolution.height}`;
  };

  const closeMenu = () => setMenuOpen(false);
  const closePassMenu = () => setPassMenuOpen(false);
  const closeUniformMenu = () => setUniformMenuOpen(false);
  const closeSpeedMenu = () => setSpeedOpen(false);
  const closeResolutionMenu = () => setPreviewResolutionOpen(false);

  onMount(() => {
    initAutoUpdater();
    void refreshUserTemplates();
    void (async () => {
      if (!hasTauri()) return;
      unlistenUserTpl = await listen('user-templates-changed', () => {
        void refreshUserTemplates();
      });
    })();
    void (async () => {
      if (bootSession && !bootSession.cleanExit && bootSession.autosaveAt) {
        const snap = await readLatestAutosave(bootSession.projectDir);
        if (snap) setRecover({ savedAt: snap.savedAt, name: snap.name });
      }
    })();

    const autosaveTimer = setInterval(() => void runAutosave(), AUTOSAVE_INTERVAL_MS);

    const onOutside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuOpen() && menuRootRef && !menuRootRef.contains(t)) closeMenu();
      if (passMenuOpen() && passRootRef && !passRootRef.contains(t)) closePassMenu();
      if (uniformMenuOpen() && uniformRootRef && !uniformRootRef.contains(t)) closeUniformMenu();
      if (speedOpen() && speedRootRef && !speedRootRef.contains(t)) closeSpeedMenu();
      if (previewResolutionOpen() && resolutionRootRef && !resolutionRootRef.contains(t)) closeResolutionMenu();
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const el = document.activeElement as HTMLElement | null;
      const inMonaco = !!el?.closest('.monaco-editor');
      const inModal = !!el?.closest('[aria-modal="true"]');
      const inTextControl = !!el?.matches('input, textarea, select, [contenteditable="true"]');
      const inButtonLike = !!el?.matches('button, a, [role="button"], [role="menuitem"]');
      const inGraphScope = !!el?.closest('[data-graph-keyboard-scope="true"]');

      // Esc 只关闭当前最上层，避免一次退出多个上下文。
      if (e.key === 'Escape') {
        const dialog = appDialog();
        if (dialog) resolveAppDialog(false, dialog.input?.initialValue ?? '');
        else if (graphResourcesOpen()) setGraphResourcesOpen(false);
        else if (templateOpen()) setTemplateOpen(false);
        else if (exportOpen()) setExportOpen(false);
        else if (agentSettingsOpen()) setAgentSettingsOpen(false);
        else if (previewResolutionOpen()) closeResolutionMenu();
        else if (speedOpen()) closeSpeedMenu();
        else if (uniformMenuOpen()) closeUniformMenu();
        else if (passMenuOpen()) closePassMenu();
        else if (menuOpen()) closeMenu();
        else if (chatOpen()) setChatOpen(false);
        else return;
        e.preventDefault();
        return;
      }

      // 模态框和普通交互控件拥有按键优先权，工作区快捷键不得穿透。
      if (inModal || (inTextControl && !inMonaco) || inButtonLike) return;

      if (mod) {
        if (key === 's') {
          e.preventDefault();
          if (e.shiftKey) void saveProjectAs();
          else void saveProject();
          return;
        }
        if (key === 'o') {
          e.preventDefault();
          void openProject();
          return;
        }
        if (key === 'n') {
          e.preventDefault();
          void newProject();
          return;
        }
        if (key === 'e') {
          e.preventDefault();
          openVisualExport();
          return;
        }
      }
      // Monaco 内保留编辑器自身的空格、R 与 Ctrl+/ 行注释行为。
      if (inMonaco) return;
      if (mod && e.code === 'Slash') {
        e.preventDefault();
        if (!chatOpen()) setChatOpen(true);
        window.setTimeout(() => {
          document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus();
        }, 80);
        return;
      }
      if (inGraphScope) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (key === 'r' && !mod && !e.altKey) {
        api?.reset();
      }
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      persistSession(true);
      if (dirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    window.addEventListener('beforeunload', onBeforeUnload);
    onCleanup(() => {
      clearInterval(autosaveTimer);
      clearTimeout(graphDebounceTimer);
      unlistenUserTpl?.();
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      window.removeEventListener('beforeunload', onBeforeUnload);
      persistSession(true);
    });
  });

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__slp = {
      setSource: (src: string) => {
        updateSource('image', src);
        setDirty(true);
        scheduleCompile(VISUAL_DOMAIN);
      },
      setCommon: (src: string) => {
        updateSource('common', src);
        setDirty(true);
        scheduleCompile(BOTH_DOMAINS);
      },
      setSound: (src: string) => {
        updateSource('sound', src);
        setDirty(true);
        scheduleCompile(SOUND_DOMAIN);
      },
      setBuffer: (id: string, src: string) => {
        if (!isBufferId(id)) return;
        updateSource(id, src);
        setDirty(true);
        scheduleCompile(VISUAL_DOMAIN);
      },
      enableBuffer: (id: string, en: boolean) => {
        if (!isBufferId(id)) return false;
        setPassEnabled(id, en);
        return true;
      },
      setFeedback: (id: string, fb: boolean) => {
        if (!isBufferId(id)) return false;
        setPassFeedback(id, fb);
        return true;
      },
      setPassChannel: (pass: string, ch: number, src: string) => {
        if (pass !== 'image' && !isBufferId(pass)) return false;
        setPassChannel(pass as 'image' | BufferId, ch, src);
        return true;
      },
      previewTarget: (t: string) => {
        if (t !== 'image' && !isBufferId(t)) return false;
        applyPreviewTarget(t as RenderPassId);
        return true;
      },
      probePixel: (t?: string) =>
        api?.probePixel((t === undefined ? undefined : (t as RenderPassId))) ?? null,
      reset: () => api?.reset(),
      isRunning: () => api?.isRunning() ?? false,
      setPlaying,
      seek,
      setSpeed: applySpeed,
      setResolution: applyResolution,
      setPreviewResolution: (resolution: PreviewResolution) => applyPreviewResolution(resolution),
      getPreviewResolution: () => previewResolution(),
      endCapture: () => api?.endCapture(),
      captureAt: (time: number, frameIndex: number, dt: number, size?: CaptureSize) =>
        api?.captureAt(time, frameIndex, dt, size),
      renderAudio: (dur: number, rate?: number) => api?.renderAudio(dur, rate),
      compileSync: () => {
        clearTimeout(debounceTimer);
        if (!api) return -1;
        const r = api.compile(runtimeSetup(), { visual: true, sound: true });
        setDiagnostics(fromRuntimeDiagnostics(r.diagnostics));
        if (r.visualOk === true) setSuccessfulRuntimeSetupRevision(visualSetupRevision());
        if (r.soundOk === true) setSuccessfulSoundRuntimeSetupRevision(soundSetupRevision());
        return r.diagnostics.length;
      },
      debugSetup: () => JSON.parse(JSON.stringify(runtimeSetup())),
      setUniform: (name: string, v: unknown) => {
        if (typeof name !== 'string' || !uniformDecls().some((d) => d.name === name)) return false;
        setUniformValue(name, v as UniformValue);
        return true;
      },
      uniformDefs: () => JSON.parse(JSON.stringify(uniformDecls())),
      uniformValues: () => ({ ...uniformValues() }),
      intel: (word: string, pass: string, kind: 'suggest' | 'hover' | 'definition' | 'analysis') => {
        if (kind === 'analysis') return collectAnalysis();
        if (kind === 'suggest') return computeSuggestions(word, (pass || 'image') as SrcPassId);
        if (kind === 'hover') return computeHover(word, (pass || 'image') as SrcPassId);
        return computeDefinition(word, (pass || 'image') as SrcPassId);
      },
      snippets: () => GLSL_SNIPPETS,
      templates: () => PROJECT_TEMPLATES,
      applyTemplate: (id: string) => {
        const t = PROJECT_TEMPLATES.find((x) => x.id === id);
        if (!t) return false;
        void applyTemplate(t as ProjectTemplate);
        return true;
      },
      editorApi: () => {
        if (!editorRef) return null;
        return {
          value: editorRef.getValue(),
          modelUri: editorRef.getModel()?.uri.toString() ?? null,
          apply: (v: string) => editorRef!.setValue(v),
        };
      },
      stats,
      notify,
      project: {
        state: () => ({
          dir: projectDir(),
          name: projectName(),
          dirty: dirty(),
        }),
        sources: () => ({ ...sources() }),
        passes: () => JSON.parse(JSON.stringify(meta().passes)),
        new: newProject,
        open: openProject,
        save: saveProject,
        saveAs: saveProjectAs,
        autosaveNow: runAutosave,
        recoverState: () => recover(),
        acceptRecover: doRecover,
      },
    };
    const debugApi = (window as unknown as { __slp: Record<string, unknown> }).__slp;
    void import('./updater/updater.dev').then(({ installUpdaterDevApi }) => {
      installUpdaterDevApi(debugApi);
    });
  }

  // M7b：Tab 标签显示名（顶部项目区 + HUD 使用）
  const tabLabel = (id: SrcPassId): string => {
    if (id === 'image') return 'Image';
    if (id === 'common') return 'Common';
    if (id === 'sound') return 'Sound';
    return `Buffer ${BUFFER_LETTER[id as BufferId]}`;
  };

  // M7b：时间轴进度百分比（供 --val 渐变填充）
  const timelinePct = () => {
    const max = timelineMax();
    if (max <= 0) return 0;
    const cur = scrubbing() ? scrubValue() : Math.min(stats().time, max);
    return Math.min(100, Math.max(0, (cur / max) * 100));
  };

  // M7b：预设条迷你滑条 —— 取前 3 个数值型 slider Uniform
  const stripUniforms = createMemo(() =>
    uniformGroups()
      .flatMap((g) => g.items)
      .filter((d) => d.widget === 'slider' && (d.type === 'float' || d.type === 'int'))
      .slice(0, 3),
  );

  return (
    <div class="app">
      {/* M7b：极光背景层（深色主题专属，浅色由 data-theme 隐藏） */}
      <div class="aurora" aria-hidden="true" />
      <aside class="rail" aria-label={t('app.nav.main')}>
        <div class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2">
            <rect x="4" y="4" width="7" height="7" rx="1.6" />
            <rect x="13" y="4" width="7" height="7" rx="1.6" />
            <rect x="4" y="13" width="7" height="7" rx="1.6" />
            <rect x="13" y="13" width="7" height="7" rx="1.6" />
          </svg>
        </div>
        <div class="menu-root rail-slot" ref={menuRootRef}>
          <button
            class="rail-btn"
            classList={{ active: menuOpen() }}
            title={t('app.nav.project')}
            aria-label={t('app.nav.projectMenu')}
            aria-expanded={menuOpen()}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
          </button>
          <Show when={menuOpen()}>
            <div class="menu-pop rail-pop">
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void newProject();
                }}
              >
                <span>{t('app.menu.newProject')}</span>
                <kbd>Ctrl+N</kbd>
              </button>
              <button
                class="menu-item"
                onClick={() => setTemplateOpen(true)}
              >
                <span>{t('app.menu.newFromTemplate')}</span>
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void openProject();
                }}
              >
                <span>{t('app.menu.openProject')}</span>
                <kbd>Ctrl+O</kbd>
              </button>
              <div class="menu-sep" />
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void saveProject();
                }}
              >
                <span>{t('app.menu.save')}</span>
                <kbd>Ctrl+S</kbd>
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void saveProjectAs();
                }}
              >
                <span>{t('app.menu.saveAs')}</span>
                <kbd>Ctrl+Shift+S</kbd>
              </button>
              <div class="menu-sep" />
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void importShadertoy();
                }}
              >
                <span>{t('app.menu.importShadertoy')}</span>
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void exportShadertoyJson();
                }}
              >
                <span>{t('app.menu.exportShadertoy')}</span>
              </button>
              <div class="menu-sep" />
              <div class="menu-info">
                {dirty() ? t('app.menu.dirty') : t('app.menu.clean')}
              </div>
            </div>
          </Show>
        </div>
        <button class="rail-btn" title={t('app.nav.templates')} aria-label={t('app.nav.openTemplates')} onClick={() => setTemplateOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <rect x="3" y="3" width="7.5" height="7.5" rx="1.8" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8" />
          </svg>
        </button>
        <div class="menu-root rail-slot" ref={passRootRef}>
          <button
            class="rail-btn"
            classList={{ active: passMenuOpen() }}
            title={t('app.nav.passStructure')}
            aria-label={t('app.nav.renderPassStructure')}
            aria-expanded={passMenuOpen()}
            onClick={() => setPassMenuOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
              <polygon points="12 2 2 7.5 12 13 22 7.5 12 2" />
              <polyline points="2 12.5 12 18 22 12.5" />
              <polyline points="2 17.5 12 23 22 17.5" />
            </svg>
          </button>
          <Show when={passMenuOpen()}>
            <div class="menu-pop pass-pop rail-pop">
              <button class="btn primary" style={{ width: '100%' }} onClick={() => { setPassGraphOpen(true); closePassMenu(); }}>{t('app.pass.openGraph')}</button>
              <div class="menu-info">{t('app.pass.executionHint')}</div>
              <div class="menu-sep" />
              <div class="pass-sec">Image · iChannel</div>
              <div class="pass-ch-row">
                <For each={[0, 1, 2, 3]}>
                  {(i) => (
                    <label class="pass-ch">
                      <span>ch{i}</span>
                      <select
                        value={getPassChannel('image', i)}
                        onChange={(e) => setPassChannel('image', i, e.currentTarget.value)}
                      >
                        <option value="">—</option>
                        <For each={enabledBuffers()}>
                          {(b) => <option value={b}>{BUFFER_LETTER[b]}</option>}
                        </For>
                      </select>
                    </label>
                  )}
                </For>
              </div>
              <div class="menu-sep" />
              <For each={BUFFER_IDS}>
                {(b) => (
                  <div class="pass-block">
                    <div class="pass-row">
                      <label class="pass-toggle">
                        <input
                          type="checkbox"
                          checked={!!meta().passes[b]?.enabled}
                          onChange={(e) => setPassEnabled(b, e.currentTarget.checked)}
                        />
                        <span>Buffer {BUFFER_LETTER[b]}</span>
                      </label>
                      <Show when={meta().passes[b]?.enabled}>
                        <label class="pass-toggle sub" title={t('app.pass.feedbackHint')}>
                          <input
                            type="checkbox"
                            checked={passGraph().edges.some((edge) => edge.source === b && edge.target === b && edge.timing === 'previous')}
                            onChange={(e) => setPassFeedback(b, e.currentTarget.checked)}
                          />
                          <span>{t('app.pass.feedback')}</span>
                        </label>
                        <button
                          class="btn mini"
                          onClick={() => {
                            setActiveTab(b);
                            closePassMenu();
                          }}
                        >
                          {t('app.pass.edit')}
                        </button>
                      </Show>
                    </div>
                    <Show when={meta().passes[b]?.enabled}>
                      <div class="pass-ch-row sub">
                        <For each={[0, 1, 2, 3]}>
                          {(i) => (
                            <label class="pass-ch">
                              <span>ch{i}</span>
                              <select
                                value={getPassChannel(b, i)}
                                onChange={(e) => setPassChannel(b, i, e.currentTarget.value)}
                              >
                                <option value="">—</option>
                                <option value="bufferA">A</option>
                                <option value="bufferB">B</option>
                                <option value="bufferC">C</option>
                                <option value="bufferD">D</option>
                              </select>
                            </label>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
              <div class="menu-sep" />
              <div class="menu-info">{t('app.pass.codeSlotHint')}</div>
            </div>
          </Show>
        </div>
        <div class="menu-root rail-slot" ref={uniformRootRef}>
          <button
            class="rail-btn"
            classList={{ active: uniformMenuOpen() }}
            title={t('app.nav.uniforms')}
            aria-label={t('app.nav.uniforms')}
            aria-expanded={uniformMenuOpen()}
            onClick={() => {
              setUniformInspectorOpen(false);
              setUniformMenuOpen((o) => !o);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <line x1="4" y1="6" x2="20" y2="6" />
              <circle cx="9.5" cy="6" r="2.3" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <circle cx="15" cy="12" r="2.3" />
              <line x1="4" y1="18" x2="20" y2="18" />
              <circle cx="7.5" cy="18" r="2.3" />
            </svg>
          </button>
          <Show when={uniformMenuOpen()}>
            <div class="menu-pop pass-pop rail-pop">
              <UniformPanel
                groups={uniformGroups()}
                values={uniformValues()}
                onSet={setUniformValue}
              />
            </div>
          </Show>
        </div>
        <button
          class="rail-btn"
          classList={{ active: diagOpen() }}
          title={t('app.nav.diagnostics')}
          aria-label={t('app.nav.toggleDiagnostics')}
          aria-expanded={diagOpen()}
          onClick={() => setDiagOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 12 7.5 12 10.5 5 14.5 19 17 12 21 12" />
          </svg>
        </button>
        <div class="rail-spacer" />
        <button
          class="rail-btn rail-language"
          title={t('language.toggle')}
          aria-label={t('language.toggle')}
          data-locale={locale()}
          onClick={toggleLocale}
        >
          <span>{t('language.short')}</span>
        </button>
        <button
          class="rail-btn"
          title={theme() === 'dark' ? t('app.nav.lightTheme') : t('app.nav.darkTheme')}
          aria-label={theme() === 'dark' ? t('app.nav.lightTheme') : t('app.nav.darkTheme')}
          onClick={toggleTheme}
        >
          <Show
            when={theme() === 'dark'}
            fallback={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
              </svg>
            }
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
          </Show>
        </button>
        {/* AI 服务设置：机器人头造型（AI 惯用符号），与 rail 现有图标（含主题太阳/月牙、AI 助手四角星）均无撞形 */}
        <button class="rail-btn" title={t('app.nav.aiSettings')} aria-label={t('app.nav.openAiSettings')} onClick={() => setAgentSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4.8" y="9.1" width="14.4" height="10.8" rx="3" />
            <path d="M12 9.1V6.9" />
            <circle cx="12" cy="5.1" r="1.4" fill="currentColor" stroke="none" />
            <circle cx="9.3" cy="13.7" r="1.4" fill="currentColor" stroke="none" />
            <circle cx="14.7" cy="13.7" r="1.4" fill="currentColor" stroke="none" />
            <path d="M9.6 17.1h4.8" />
          </svg>
        </button>
        <button
          class="rail-btn rail-ai"
          classList={{ active: chatOpen() }}
          title={t('app.nav.aiAssistant')}
          aria-label={chatOpen() ? t('app.nav.closeAiAssistant') : t('app.nav.openAiAssistant')}
          aria-expanded={chatOpen()}
          onClick={() => setChatOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M11 3l1.7 4.8L17.5 9.5l-4.8 1.7L11 16l-1.7-4.8L4.5 9.5l4.8-1.7L11 3z" />
            <path d="M18.5 13.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5z" />
          </svg>
        </button>
      </aside>

      <main class="main">
        <header class="topbar glass" onMouseDown={topbarMouseDown}>
          <div class="proj">
            <div class="brand-col">
              <div class="proj-row">
                <input
                  class="proj-name-input"
                  value={projectName()}
                  maxlength="80"
                  aria-label={t('app.project.name')}
                  title={t('app.project.editName')}
                  onInput={(e) => renameProject(e.currentTarget.value)}
                  onBlur={finishProjectRename}
                />
                <Show when={dirty()}>
                  <span class="dot-mod" title={t('app.project.unsaved')} aria-label={t('app.project.hasUnsaved')} />
                </Show>
              </div>
              <span class="proj-sub">{t('app.subtitle')}</span>
            </div>
          </div>
          <div
            class="compact-pane-switch"
            role="tablist"
            aria-label={t('app.workspaceView')}
            onKeyDown={selectCompactPaneByKeyboard}
          >
            <button
              id="compact-pane-tab-editor"
              role="tab"
              aria-selected={compactPane() === 'editor'}
              aria-controls="workspace-editor-pane"
              tabindex={compactPane() === 'editor' ? 0 : -1}
              classList={{ active: compactPane() === 'editor' }}
              onClick={() => setCompactPane('editor')}
            >
              {t('app.editor')}
            </button>
            <button
              id="compact-pane-tab-preview"
              role="tab"
              aria-selected={compactPane() === 'preview'}
              aria-controls="workspace-preview-pane"
              tabindex={compactPane() === 'preview' ? 0 : -1}
              classList={{ active: compactPane() === 'preview' }}
              onClick={() => setCompactPane('preview')}
            >
              {t('app.preview')}
            </button>
          </div>
          <div class="transport">
            <button
              class="t-btn t-play"
              onClick={togglePlay}
              title={playing() ? t('app.pause') : t('app.play')}
              aria-label={playing() ? t('app.pausePreview') : t('app.playPreview')}
            >
              <Show
                when={playing()}
                fallback={
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8.5 5.5v13l10.5-6.5z" fill="currentColor" />
                  </svg>
                }
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="7" y="5.5" width="3.4" height="13" rx="1" />
                  <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" />
                </svg>
              </Show>
            </button>
            <button class="t-btn" onClick={() => api?.reset()} title={t('app.reset')} aria-label={t('app.resetTime')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="2 4.5 2 10 7.5 10" />
                <path d="M4 15a8.5 8.5 0 1 0 1.8-9.3L2 10" />
              </svg>
            </button>
            <button class="t-btn" disabled={!canOpenMediaExport()} onClick={openVisualExport} title={canOpenMediaExport() ? t('app.exportMedia') : mediaExportBlockedMessage()} aria-label={t('app.openExport')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <rect x="3" y="4" width="18" height="16" rx="2.5" />
                <line x1="7.5" y1="4" x2="7.5" y2="20" />
                <line x1="16.5" y1="4" x2="16.5" y2="20" />
                <line x1="3" y1="9" x2="7.5" y2="9" />
                <line x1="3" y1="15" x2="7.5" y2="15" />
                <line x1="16.5" y1="9" x2="21" y2="9" />
                <line x1="16.5" y1="15" x2="21" y2="15" />
              </svg>
            </button>
            <input
              type="range"
              class="timeline"
              aria-label={t('app.timeline')}
              aria-valuetext={t('app.seconds', { value: stats().time.toFixed(2) })}
              min="0"
              max={timelineMax()}
              step="0.01"
              style={{ '--val': `${timelinePct()}%` }}
              value={scrubbing() ? scrubValue() : Math.min(stats().time, timelineMax())}
              onPointerDown={(e) => {
                setScrubbing(true);
                setScrubValue(e.currentTarget.valueAsNumber);
              }}
              onInput={(e) => {
                const v = e.currentTarget.valueAsNumber;
                setScrubValue(v);
                seek(v);
              }}
              onPointerUp={() => setScrubbing(false)}
              onPointerCancel={() => setScrubbing(false)}
            />
            <span class="tl-time">
              {t('app.status.timelineTime', {
                current: stats().time.toFixed(2),
                max: timelineMax().toFixed(0),
              })}
            </span>
            <div class="menu-root chip-slot" ref={speedRootRef}>
              <button
                class="chip"
                classList={{ active: speedOpen() }}
                title={t('app.playbackSpeed')}
                aria-label={t('app.playbackSpeedValue', { value: speed().toFixed(1) })}
                aria-expanded={speedOpen()}
                onClick={() => setSpeedOpen((o) => !o)}
              >
                {speed().toFixed(1)}×
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <Show when={speedOpen()}>
                <div class="menu-pop chip-pop">
                  <div class="chip-row">
                    <span class="ctl-label">{t('app.speed')}</span>
                    <input
                      type="range"
                      class="speed-slider"
                      aria-label={t('app.playbackSpeed')}
                      min="0.1"
                      max="4"
                      step="0.1"
                      value={speed()}
                      onInput={(e) => applySpeed(e.currentTarget.valueAsNumber)}
                    />
                    <span class="speed-value">{speed().toFixed(1)}×</span>
                  </div>
                </div>
              </Show>
            </div>
          </div>
          <label class="chip">
            <span class="chip-k">{t('app.view')}</span>
            <select
              class="chip-select"
              value={previewTarget()}
              onChange={(e) => applyPreviewTarget(e.currentTarget.value as RenderPassId)}
              title={t('app.previewTarget')}
            >
              <option value="image">Image</option>
              <For each={enabledBuffers()}>
                {(b) => <option value={b}>Buf {BUFFER_LETTER[b]}</option>}
              </For>
            </select>
          </label>
          <div class="menu-root chip-slot preview-resolution-control" ref={resolutionRootRef}>
            <button
              class="chip preview-resolution-button"
              classList={{ active: previewResolutionOpen() }}
              title={previewResolution().mode === 'auto'
                ? t('preview.autoHint')
                : t('preview.fixedHint', previewResolution() as { width: number; height: number })}
              aria-label={`${t('app.resolution')}: ${previewResolutionLabel()}`}
              aria-expanded={previewResolutionOpen()}
              onClick={() => setPreviewResolutionOpen((open) => !open)}
            >
              <span class="chip-k">{t('app.resolution')}</span>
              <span>{previewResolutionLabel()}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <Show when={previewResolutionOpen()}>
              <div class="menu-pop chip-pop preview-resolution-pop">
                <button
                  class="preview-resolution-option"
                  classList={{ active: previewResolution().mode === 'auto' }}
                  onClick={() => { applyPreviewResolution(DEFAULT_PREVIEW_RESOLUTION); closeResolutionMenu(); }}
                >
                  <strong>{t('preview.auto')}</strong>
                  <small>{t('preview.autoHint')}</small>
                </button>
                <div class="menu-sep" />
                <For each={PREVIEW_RESOLUTION_PRESETS}>{(preset) => {
                  const key = `${preset.width}x${preset.height}`;
                  return <button
                    class="preview-resolution-option preset"
                    classList={{ active: previewResolutionKey(previewResolution()) === key }}
                    onClick={() => {
                      applyPreviewResolution({ mode: 'fixed', width: preset.width, height: preset.height });
                      closeResolutionMenu();
                    }}
                  >
                    <span>{preset.width}×{preset.height}</span>
                    <small>{preset.ratio}</small>
                  </button>;
                }}</For>
                <div class="menu-sep" />
                <strong class="preview-resolution-custom-title">{t('preview.custom')}</strong>
                <div class="resolution-inputs preview-resolution-inputs">
                  <input
                    type="number"
                    class="text-input"
                    min="1"
                    step="1"
                    aria-label={t('preview.width')}
                    value={customPreviewWidth()}
                    onInput={(event) => setCustomPreviewWidth(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') applyCustomPreviewResolution(); }}
                  />
                  <span aria-hidden="true">×</span>
                  <input
                    type="number"
                    class="text-input"
                    min="1"
                    step="1"
                    aria-label={t('preview.height')}
                    value={customPreviewHeight()}
                    onInput={(event) => setCustomPreviewHeight(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') applyCustomPreviewResolution(); }}
                  />
                  <button class="btn mini primary" onClick={applyCustomPreviewResolution}>{t('common.apply')}</button>
                </div>
              </div>
            </Show>
          </div>
          <WindowControls />
        </header>

        <Show when={recover()}>
          <div class="recover-banner glass">
            <span>
              {t('app.recoveryMessage', { time: new Date(recover()!.savedAt).toLocaleTimeString(locale()) })}
            </span>
            <button class="btn primary" onClick={() => void doRecover()}>
              {t('app.recover')}
            </button>
            <button class="btn" onClick={discardRecover}>
              {t('app.discard')}
            </button>
          </div>
        </Show>

        <div class="workspace">
          <div
            class={`workbench pane-${compactPane()} ${activeAuthoring() === 'graph' && displayedGraphDocument() ? `graph-workbench graph-preview-${graphWorkspace().previewDock} graph-mode-${graphWorkspace().mode}` : ''}`}
            ref={workspaceRef}
          >
          <section
            id="workspace-editor-pane"
            class="editor glass graph-editor-host"
            role="tabpanel"
            aria-labelledby="compact-pane-tab-editor"
            style={{ flex: `0 0 ${editorRatio() * 100}%` }}
          >
            <Show when={passGraphOpen()}>
              <Suspense fallback={<FeatureLoading />}>
                <ProjectPassGraphPanel
                  open={true}
                  project={meta()}
                  document={passGraph()}
                  graphDocuments={allGraphDocuments()}
                  diagnostics={passGraphResolution().diagnostics}
                  onClose={() => setPassGraphOpen(false)}
                  onChange={updatePassGraph}
                  onIssue={(message) => notify(message, 'error')}
                />
              </Suspense>
            </Show>
            <ShaderEditorWorkspace
              sources={sources}
              effectiveSources={effectiveSources}
              shadertoyJson={() => {
                const issue = shadertoyRepresentationIssue();
                if (issue) throw new ProductError(issue);
                return toShadertoyJson({ ...effectiveProjectMeta(), name: projectName() }, effectiveSources());
              }}
              onSourceChange={handleEditorChange}
              codeDiagnostics={mappedDiags()}
              onEditorReady={(e) => (editorRef = e)}
              tabs={tabs()}
              activeTab={activeTab()}
              onTabChange={(id) => { setActiveTab(id as TabId); if (graphWorkspace().editPath.length) updateGraphWorkspace({ ...graphWorkspace(), editPath: [] }); }}
              onNotify={notify}
              projectName={projectName()}
              activeAuthoring={activeAuthoring()}
              canCreateGraph={!!activeGraphPass()}
              graphDocument={displayedGraphDocument()}
              graphRegistry={graphNodeRegistry()}
              graphAssets={assetManifest().assets}
              graphSelection={displayedGraphSelection()}
              graphDiagnostics={activeEditingGroup() ? [] : activeGraphEditor() ? graphDiagnostics(activeGraphEditor()!) : []}
              graphStatus={activeGraphEditor()?.status ?? 'idle'}
              graphStale={activeGraphEditor() ? graphIsStale(activeGraphEditor()!, graphLibraryRevision()) : activeGraphPass() ? graphFallbackActive(activeGraphPass()!) : false}
              graphFallbackIssue={joinLocalized([
                ...projectGraphIssues()
                  .filter((issue) => !activeGraphPass() || issue.pass === activeGraphPass())
                  .map((issue) => formatProductMessage({
                    code: issue.code,
                    params: issue.params,
                    rawDetail: issue.rawDetail,
                    fallback: issue.message,
                  })),
                ...(activeGraphPass() ? graphRecoveryDiagnostics(activeGraphPass()!) : [])
                  .map((item) => formatProductMessage({
                    code: item.code ?? 'diagnostic.unstructured',
                    params: item.params,
                    rawDetail: item.rawDetail,
                    fallback: item.message,
                  })),
              ])}
              graphWorkspace={graphWorkspace()}
              graphEditingGroup={activeGroupPath().at(-1)}
              graphBreadcrumbPath={activeGroupPath()}
              graphGroupTitle={groupTitle}
              generatedSource={generatedCodeSelection().source}
              generatedSourceAccepted={generatedCodeSelection().accepted}
              revealNodeId={!activeEditingGroup() && activeGraphPass() ? graphRevealNodeId(activeGraphPass()!) : undefined}
              onCreateGraph={() => void createPassGraphEditor()}
              onDetachGraph={() => void detachPassGraph()}
              onDetachFallback={() => void detachGraphFallback()}
              onExportGeneratedFragment={() => void exportGraphGeneratedFragment()}
              onExportGraphJson={() => void exportGraphJson()}
              canDetach={activeGraphEditor() ? graphCanExport(activeGraphEditor()!, graphLibraryRevision()) : false}
              canExport={canExportCurrent()}
              exportBlockedReason={exportBlockedReason()}
              captureExportTicket={() => currentExportEligibility(activeGraphPass() === 'sound' ? SOUND_EXPORT : VISUAL_EXPORT).ticket}
              canExportShadertoy={!shadertoyRepresentationIssue() && shadertoyExportEligibility().eligible}
              shadertoyExportBlockedReason={shadertoyRepresentationIssue() ?? shadertoyExportEligibility().reason}
              captureShadertoyExportTicket={() => shadertoyRepresentationIssue() ? undefined : shadertoyExportEligibility().ticket}
              validateExportTicket={(ticket) => validateExportTicket(ticket, currentExportInput(ticket.requirements)).reason}
              onGraphWorkspaceChange={updateGraphWorkspace}
              onGraphCommand={applyGraphCommand}
              onGraphUndo={undoGraph}
              onGraphRedo={redoGraph}
              onCreateNodeGroup={() => void createNodeGroupFromSelection()}
              onEnterNodeGroup={enterNodeGroup}
              onNavigateGroupBreadcrumb={navigateGroupBreadcrumb}
              onOpenGraphResources={() => setGraphResourcesOpen(true)}
              onGraphSelection={(selection) => {
                const key = activeGroupKey();
                if (key) { setGroupSelections((items) => ({ ...items, [key]: selection })); return; }
                const pass = activeGraphPass();
                if (pass) setGraphEditorFor(pass, (state) => state ? { ...state, selection } : state);
              }}
            />
            <Show when={diagOpen()}>
              <DiagnosticsPane diagnostics={unifiedDiagnostics()} onJump={jumpTo} />
            </Show>
            <footer class="statusline" aria-live="polite">
              <button
                class={`sl-status ${activeCompileStatus() === 'stale' || errCount() ? 'error' : activeCompileStatus() !== 'ready' ? 'pending' : 'ok'}`}
                disabled={errCount() === 0}
                onClick={() => setDiagOpen(true)}
                title={errCount() ? t('app.status.openProblems') : undefined}
              >
                {activeCompileStatus() === 'pending'
                  ? t('app.status.waitingCompile')
                  : activeCompileStatus() === 'compiling'
                    ? t('app.status.compiling')
                    : activeCompileStatus() === 'stale'
                      ? errCount()
                        ? t('app.status.graphStaleWithProblems', { count: errCount() })
                        : t('app.status.graphStale')
                      : errCount()
                        ? t('app.status.compileErrors', { count: errCount() })
                        : t('app.status.compilePassed')}
              </button>
              <span class="statusline-right">
                <span>{stats().width} × {stats().height}</span>
                <span>WebGL2 · GLSL ES 3.0</span>
              </span>
            </footer>
          </section>
          <div
            class="pane-divider"
            role="separator"
            aria-label={t('app.splitter.aria')}
            aria-orientation="vertical"
            aria-valuemin="15"
            aria-valuemax="85"
            aria-valuenow={Math.round(editorRatio() * 100)}
            tabindex="0"
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onPointerUp={onDividerUp}
            onPointerCancel={onDividerUp}
            onKeyDown={onDividerKeyDown}
            onDblClick={() => updateEditorRatio(0.5)}
            title={t('app.splitter.hint')}
          />
          <section
            id="workspace-preview-pane"
            class="preview glass graph-preview-host"
            role="tabpanel"
            aria-labelledby="compact-pane-tab-preview"
          >
            <div class="canvas">
              <PreviewPane
                playing={playing}
                resolution={previewResolution}
                onStats={setStats}
                onReady={(a) => {
                  api = a;
                  try {
                    a.setPreviewResolution(previewResolution());
                  } catch (error) {
                    a.setPreviewResolution(DEFAULT_PREVIEW_RESOLUTION);
                    setPreviewResolution(DEFAULT_PREVIEW_RESOLUTION);
                    persistPreviewResolution(DEFAULT_PREVIEW_RESOLUTION);
                    notify({ code: 'runtime.preview-resolution-failed' }, 'error');
                  }
                  if (enabledGraphPasses().some((pass) => !!graphEditor(pass))) compileGraphCohort();
                  else scheduleCompile();
                }}
              />
              <div class="hud hud-tl">
                <span class="hud-chip">{t('app.hud.pass', { pass: tabLabel(previewTarget()) })}</span>
              </div>
              <div class="hud hud-tr">
                <span class="hud-chip accent">{stats().fps} FPS</span>
                <span class="hud-chip">{t('app.hud.seconds', { value: stats().time.toFixed(1) })}</span>
                <span class="hud-chip">#{stats().frame}</span>
              </div>
            </div>
            <div class="preset-strip" classList={{ compact: uniformGroups().length === 0 }}>
              <span class="preset-label">{t('app.parameters')}</span>
              <Show when={uniformGroups().length === 0}>
                <span class="preset-empty">{t('app.noParameters')}</span>
              </Show>
              <For each={stripUniforms()}>
                {(d) => {
                  const cur = () => Number(uniformValues()[d.name] ?? d.def) || 0;
                  const span = d.max - d.min;
                  const pct = () => span > 0 ? ((cur() - d.min) / span) * 100 : 0;
                  return (
                    <div class="umi">
                      <span class="umi-name" title={d.name}>{d.name}</span>
                      <input
                        type="range"
                        aria-label={t('app.parameterAria', { name: d.name })}
                        min={d.min}
                        max={d.max}
                        step={d.step}
                        value={cur()}
                        style={{ '--val': `${pct()}%` }}
                        onInput={(e) => setUniformValue(d.name, e.currentTarget.valueAsNumber)}
                      />
                      <span class="umi-val">{cur().toFixed(2)}</span>
                    </div>
                  );
                }}
              </For>
              <div class="strip-flex" />
              <button
                class="chip"
                aria-expanded={uniformInspectorOpen()}
                onClick={() => {
                  setUniformMenuOpen(false);
                  setUniformInspectorOpen((open) => !open);
                }}
              >
                {t('app.allParameters')}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
            <Show when={uniformInspectorOpen()}>
              <aside class="uniform-inspector" aria-label={t('app.uniformInspector.title')}>
                <div class="uniform-inspector-head">
                  <strong>{t('app.uniformInspector.title')}</strong>
                  <button
                    class="btn mini"
                    aria-label={t('app.closeUniformInspector')}
                    onClick={() => setUniformInspectorOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <UniformPanel
                  groups={uniformGroups()}
                  values={uniformValues()}
                  onSet={setUniformValue}
                />
              </aside>
            </Show>
          </section>
          </div>
          <Show when={chatOpen()}>
            <Suspense fallback={<FeatureLoading />}>
              <ChatPanel
                onApplyCode={applyAiCode}
                onPreview={startPreview}
                canApplyCode={imageAuthoring() === 'code'}
                codeApplyBlockedReason={imageAuthoring() === 'code' ? undefined : t('chat.graphBlocked')}
                onCancelPreview={stopPreview}
                previewActive={!!previewState()}
                appliedCandidateCode={lastAppliedAiCode()}
                requestConfirm={requestConfirmation}
                onOpenSettings={() => setAgentSettingsOpen(true)}
                onClose={() => setChatOpen(false)}
              />
            </Suspense>
          </Show>
        </div>
      </main>

      <Show when={exportOpen()}>
        <Suspense fallback={<FeatureLoading modal />}>
          <ExportDialog
            api={() => api}
            captureTicket={captureExportTicket}
            validateTicket={validateCaptureTicket}
            onClose={() => setExportOpen(false)}
            onDone={notify}
          />
        </Suspense>
      </Show>

      <Show when={templateOpen()}>
        <Suspense fallback={<FeatureLoading modal />}>
          <TemplateDialog
            templates={PROJECT_TEMPLATES}
            onSelect={(template) => void applyTemplate(template)}
            onClose={() => setTemplateOpen(false)}
            userTemplates={userTemplates()}
            onApplyUser={applyUserTemplateCode}
            onPreviewUser={(t) => startPreview(t.name, t.code)}
            canApplyCode={imageAuthoring() === 'code'}
            codeApplyBlockedReason={imageAuthoring() === 'code' ? undefined : t('chat.graphBlocked')}
            editorCode={() => sources().image ?? ''}
            requestConfirm={requestConfirmation}
            notify={notify}
          />
        </Suspense>
      </Show>

      <Show when={graphResourcesOpen()}>
        <Suspense fallback={<FeatureLoading modal />}>
          <GraphResourcesDialog
            open={true}
            manifest={assetManifest()}
            library={graphLibrary()}
            onClose={() => setGraphResourcesOpen(false)}
            onImportTexture={() => void importTextureAsset()}
            onSetTextureColorSpace={setTextureColorSpace}
            onRemoveTexture={removeTextureAsset}
            onAddStarterGroup={addStarterGroup}
            onRemoveGroup={(id, version) => removeLibraryEntry('groups', id, version)}
            onAddFunction={addCustomFunction}
            onRemoveFunction={(id, version) => removeLibraryEntry('functions', id, version)}
            onUseRaymarchTemplate={() => void useRaymarchTemplate()}
          />
        </Suspense>
      </Show>

      <Show when={appDialog()} keyed>
        {(dialog) => <AppDecisionDialog
          title={dialog.title}
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          cancelLabel={dialog.cancelLabel}
          danger={dialog.danger}
          input={dialog.input}
          onResolve={resolveAppDialog}
        />}
      </Show>

      <Show when={agentSettingsOpen()}>
        <Suspense fallback={<FeatureLoading modal />}>
          <AgentSettingsDialog
            onClose={() => setAgentSettingsOpen(false)}
            onSaved={(v) => {
              setAgentSettingsOpen(false);
              notify(
                v.configured
                  ? t('app.toast.aiConfigured', { model: v.model })
                  : t('app.error.aiKeyMissing'),
                v.configured ? 'ok' : 'error',
              );
            }}
          />
        </Suspense>
      </Show>

      <Show when={toast()}>
        {(value) => (
          <div class={`toast ${value().kind}`} role="status" aria-live="polite">
            <Show
              when={typeof value().message !== 'string' ? value().message as ProductMessageDescriptor : undefined}
              fallback={value().message as string}
            >
              {(descriptor) => <ProductMessageView value={descriptor()} compact />}
            </Show>
          </div>
        )}
      </Show>

      <Show when={previewState()}>
        <div class="preview-bar" role="status">
          <span>{t('app.previewing', { name: previewState()!.name })}</span>
          <span class="spacer" />
          <button class="btn mini" onClick={stopPreview}>
            {t('app.restoreCode')}
          </button>
        </div>
      </Show>

      <Show when={aiUndo() && !previewState()}>
        <div class="preview-bar ai-undo-bar" role="status">
          <span>{t('app.aiApplied')}</span>
          <span class="spacer" />
          <button class="btn mini" onClick={undoAiCode}>{t('app.undoChange')}</button>
          <button class="btn mini" onClick={() => setAiUndo(null)} aria-label={t('app.closeUndo')}>×</button>
        </div>
      </Show>
    </div>
  );
};

export default App;
