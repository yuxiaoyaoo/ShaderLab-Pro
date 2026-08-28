import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from 'solid-js';
import type * as monaco from 'monaco-editor';
import EditorPane from './components/EditorPane';
import DiagnosticsPane, { type MappedDiag } from './components/DiagnosticsPane';
import PreviewPane from './components/PreviewPane';
import ExportDialog from './components/ExportDialog';
import TemplateDialog from './components/TemplateDialog';
import UniformPanel from './components/UniformPanel';
import ChatPanel from './components/ChatPanel';
import AgentSettingsDialog from './components/AgentSettingsDialog';
import { theme, toggleTheme } from './theme';
import type { ProjectTemplate } from './templates';
import { PROJECT_TEMPLATES } from './templates';
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
  type UniformValue,
} from './shadertoy/uniforms';
import type {
  CompileResult,
  CaptureSize,
  Diagnostic,
  RenderPassId,
  RuntimeApi,
  RuntimeSetup,
  RuntimeStats,
} from './shadertoy/runtime';
import {
  BUFFER_IDS,
  BUFFER_LETTER,
  createProject,
  joinPath,
  parseProject,
  serializeProject,
  sourcesWithDefaults,
  type BufferId,
  type ShaderlabProject,
  type SrcPassId,
} from './project/types';
import { hasTauri, pickFile, pickFolder, readTextFile, writeTextFile } from './project/bridge';
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
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

type TabId = SrcPassId;

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
        <button class="win-btn" title="最小化" aria-label="最小化窗口" onClick={() => void getCurrentWindow().minimize()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="6" y1="12" x2="18" y2="12" />
          </svg>
        </button>
        <button
          class="win-btn"
          title={maximized() ? '还原' : '最大化'}
          aria-label={maximized() ? '还原窗口' : '最大化窗口'}
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
        <button class="win-btn close" title="关闭" aria-label="关闭窗口" onClick={() => void getCurrentWindow().close()}>
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
const TOPBAR_INTERACTIVE = 'button, input, select, textarea, label, .menu-root, .menu-pop';

function topbarStartDrag(e: MouseEvent) {
  if (!hasTauri() || e.button !== 0) return;
  const t = e.target as HTMLElement | null;
  if (t && t.closest(TOPBAR_INTERACTIVE)) return;
  getCurrentWindow()
    .startDragging()
    .catch((err) => console.error('[topbar] 窗口拖动失败：', err));
}

function topbarToggleMaximize(e: MouseEvent) {
  if (!hasTauri()) return;
  const t = e.target as HTMLElement | null;
  if (t && t.closest(TOPBAR_INTERACTIVE)) return;
  void getCurrentWindow().toggleMaximize();
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

const App: Component = () => {
  const [sources, setSources] = createSignal(
    sourcesWithDefaults({ image: DEFAULT_SHADER }),
  );
  const [activeTab, setActiveTab] = createSignal<TabId>('image');
  const [previewTarget, setPreviewTarget] = createSignal<RenderPassId>('image');
  const [diagnostics, setDiagnostics] = createSignal<Diagnostic[]>([]);
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
  const savedEditorRatio = Number(localStorage.getItem('shaderlab-editor-ratio'));
  const [editorRatio, setEditorRatio] = createSignal(
    Number.isFinite(savedEditorRatio) && savedEditorRatio >= 0.15 && savedEditorRatio <= 0.85
      ? savedEditorRatio
      : 0.5,
  );
  const [compileState, setCompileState] = createSignal<'pending' | 'compiling' | 'ready'>('pending');

  const [projectDir, setProjectDir] = createSignal<string | null>(null);
  const [projectName, setProjectName] = createSignal('未命名项目');
  const [dirty, setDirty] = createSignal(false);
  const [meta, setMeta] = createSignal<ShaderlabProject>(createProject('未命名项目'));
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
  const [chatOpen, setChatOpen] = createSignal(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = createSignal(false);
  const [toast, setToast] = createSignal<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const [recover, setRecover] = createSignal<{ savedAt: number; name: string } | null>(null);

  let api: RuntimeApi | null = null;
  let editorRef: monaco.editor.IStandaloneCodeEditor | null = null;
  let workspaceRef: HTMLDivElement | undefined;
  let menuRootRef: HTMLDivElement | undefined;
  let passRootRef: HTMLDivElement | undefined;
  let uniformRootRef: HTMLDivElement | undefined;
  let speedRootRef: HTMLDivElement | undefined;
  let dividerDragging = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let unlistenUserTpl: (() => void) | undefined;
  let autosaveInfo: { path?: string; savedAt?: number } = {};
  const bootSession = readSession();

  const SCALE_STEPS = [0.25, 0.5, 1, 2];
  const nearestScale = (s: number) =>
    SCALE_STEPS.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));

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

  const uniformDecls = createMemo<UniformDecl[]>(() =>
    parseUniforms(sources(), (pid) => {
      if (pid === 'image' || pid === 'common' || pid === 'sound') return true;
      return !!meta().passes[pid]?.enabled;
    }).decls,
  );

  const uniformGroups = createMemo<{ pass: SrcPassId; items: UniformDecl[] }[]>(() => {
    const groups = parseUniforms(sources(), (pid) => {
      if (pid === 'image' || pid === 'common' || pid === 'sound') return true;
      return !!meta().passes[pid]?.enabled;
    }).byPass;
    return (['common', 'image', ...BUFFER_IDS, 'sound'] as SrcPassId[])
      .filter((p) => groups[p]?.length)
      .map((p) => ({ pass: p, items: groups[p] }));
  });

  createEffect(() => {
    const decls = uniformDecls();
    const cur = uniformValues();
    const next: Record<string, UniformValue> = { ...cur };
    let changed = false;
    for (const d of decls) {
      if (!(d.name in next)) {
        next[d.name] = d.def;
        changed = true;
      }
    }
    if (changed) setUniformValues(next);
  });

  const runtimeSetup = createMemo<RuntimeSetup>(() => {
    const m = meta();
    const s = sources();
    const chan = (pid: 'image' | BufferId) =>
      (m.passes[pid]?.channels ?? [])
        .filter((c) => c.type === 'buffer')
        .map((c) => ({ index: c.index, type: c.type, src: c.src }));
    const options: RuntimeSetup['options'] = {
      image: { channels: chan('image') },
    };
    for (const b of BUFFER_IDS) {
      const pc = m.passes[b];
      if (!pc?.enabled) continue;
      options[b] = { feedback: !!pc.feedback, channels: chan(b) };
    }
    const vals = uniformValues();
    return {
      sources: {
        common: s.common,
        image: s.image,
        bufferA: s.bufferA,
        bufferB: s.bufferB,
        bufferC: s.bufferC,
        bufferD: s.bufferD,
        sound: s.sound,
      },
      options,
      uniforms: uniformDecls().map((d) => ({
        name: d.name,
        type: d.type,
        value: d.name in vals ? vals[d.name] : d.def,
      })),
    };
  });

  const mappedDiags = createMemo<MappedDiag[]>(() =>
    diagnostics().map((d) => ({
      line: d.line,
      column: d.column,
      message: d.message,
      tab: (d.pass ?? 'image') as TabId,
    })),
  );

  const errCount = () => diagnostics().length;

  const notify = (msg: string, kind: 'ok' | 'error' = 'ok') => {
    clearTimeout(toastTimer);
    setToast({ msg, kind });
    toastTimer = setTimeout(() => setToast(null), 4000);
  };

  const scheduleCompile = () => {
    clearTimeout(debounceTimer);
    setCompileState('pending');
    debounceTimer = setTimeout(() => {
      if (!api) {
        setCompileState('pending');
        return;
      }
      setCompileState('compiling');
      const r = api.compile(runtimeSetup());
      setDiagnostics(r.diagnostics);
      setCompileState('ready');
    }, 400);
  };

  const updateSource = (id: SrcPassId, v: string) => {
    setSources((s) => ({ ...s, [id]: v }));
  };

  const preserveDirtyAiUndo = () => {
    setAiUndo((previous) => previous ? { ...previous, dirty: true } : null);
  };

  const handleEditorChange = (id: string, v: string) => {
    updateSource(id as SrcPassId, v);
    setAiUndo(null);
    setLastAppliedAiCode(null);
    setDirty(true);
    scheduleCompile();
  };

  const applyAiCode = (fragment: string) => {
    if (!fragment.trim()) return;
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
    scheduleCompile();
    setActiveTab('image');
    notify('已应用 AI 候选代码，可随时撤销本次修改', 'ok');
  };

  const undoAiCode = () => {
    const previous = aiUndo();
    if (!previous) return;
    updateSource('image', previous.code);
    setAiUndo(null);
    setLastAppliedAiCode(previous.previousAppliedCode);
    setActiveTab('image');
    setDirty(previous.dirty);
    scheduleCompile();
    notify('已撤销 AI 代码修改', 'ok');
  };

  /** 非破坏性预览：连续切换候选时仍保留最初的用户代码。 */
  const startPreview = (name: string, code: string) => {
    if (!code.trim()) return;
    const currentPreview = previewState();
    setPreviewState({
      name,
      backup: currentPreview?.backup ?? sources().image ?? '',
      dirty: currentPreview?.dirty ?? dirty(),
    });
    updateSource('image', code);
    setActiveTab('image');
    scheduleCompile();
  };

  /** 退出预览并无条件恢复原代码；空字符串同样是有效的项目状态。 */
  const stopPreview = () => {
    const cur = previewState();
    if (!cur) return;
    setPreviewState(null);
    updateSource('image', cur.backup);
    setActiveTab('image');
    setDirty(cur.dirty);
    scheduleCompile();
  };

  /** M6c：拉取自定义模板池（失败静默保留上次快照） */
  const refreshUserTemplates = async () => {
    try {
      setUserTemplates(await listUserTemplates());
    } catch {
      /* 后端尚未就绪时保持现状 */
    }
  };

  /** M6c：应用自定义模板——优先走既有 adopt 通道推进阶段机，异常时直落代码兜底 */
  const applyUserTemplateCode = async (t: UserTemplateViewDto) => {
    let code = t.code;
    try {
      const dto = await adoptTemplate(t.name);
      if (dto.has_code && dto.code_fragment?.trim()) code = dto.code_fragment;
    } catch {
      /* 直落兜底 */
    }
    applyAiCode(code);
    setTemplateOpen(false);
  };

  const applySources = (s: Parameters<typeof sourcesWithDefaults>[0]) => {
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
    scheduleCompile();
  };

  const setPassFeedback = (b: BufferId, fb: boolean) => {
    preserveDirtyAiUndo();
    setMeta((m) => ({
      ...m,
      passes: { ...m.passes, [b]: { ...m.passes[b], feedback: fb } },
    }));
    setDirty(true);
    scheduleCompile();
  };

  const setPassChannel = (pass: 'image' | BufferId, chIndex: number, src: string) => {
    preserveDirtyAiUndo();
    setMeta((m) => {
      const pc = m.passes[pass];
      const others = (pc.channels ?? []).filter((c) => c.index !== chIndex);
      const channels = src
        ? [
            ...others,
            { index: chIndex, type: 'buffer' as const, src, filter: 'linear' as const, wrap: 'repeat' as const },
          ].sort((a, b) => a.index - b.index)
        : others;
      return { ...m, passes: { ...m.passes, [pass]: { ...pc, channels } } };
    });
    setDirty(true);
    scheduleCompile();
  };

  const getPassChannel = (pass: 'image' | BufferId, chIndex: number): string => {
    const c = meta().passes[pass]?.channels?.find((x) => x.index === chIndex);
    return c && c.type === 'buffer' ? c.src : '';
  };

  const applyPreviewTarget = (t: RenderPassId) => {
    setPreviewTarget(t);
    api?.setPreviewTarget(t);
  };

  const setUniformValue = (name: string, v: UniformValue) => {
    preserveDirtyAiUndo();
    setUniformValues((prev) => ({ ...prev, [name]: v }));
    api?.setUniform(name, v);
    setDirty(true);
  };

  const confirmUnsaved = () =>
    !dirty() || window.confirm('当前项目有未保存的更改，确定继续？');

  const newProject = () => {
    if (!confirmUnsaved()) return;
    applySources({ image: DEFAULT_SHADER });
    setMeta(createProject('未命名项目'));
    setProjectName('未命名项目');
    setProjectDir(null);
    setUniformValues({});
    setPreviewTarget('image');
    api?.setPreviewTarget('image');
    setDiagnostics([]);
    setActiveTab('image');
    setDirty(true);
    scheduleCompile();
    notify('已新建空白项目（未命名）', 'ok');
  };

  const applyTemplate = (t: ProjectTemplate) => {
    setTemplateOpen(false);
    closeMenu();
    if (!confirmUnsaved()) return;
    applySources(t.sources);
    const m = createProject(t.name);
    for (const b of t.buffers) {
      m.passes[b.id] = { enabled: true, feedback: b.feedback };
    }
    if (t.sound) m.passes.sound = { enabled: true };
    setMeta(m);
    setProjectName(t.name);
    setProjectDir(null);
    setUniformValues({});
    setPreviewTarget('image');
    api?.setPreviewTarget('image');
    setDiagnostics([]);
    setActiveTab('image');
    setDirty(true);
    scheduleCompile();
    notify(`已从模板创建：${t.name}`, 'ok');
  };

  const openProject = async () => {
    if (!confirmUnsaved()) return;
    let dir: string | null;
    try {
      dir = await pickFolder('打开 ShaderLab 项目');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
      return;
    }
    if (!dir) return;
    try {
      const opened = await openProjectFrom(dir);
      applySources(opened.sources);
      setMeta(opened.meta);
      setUniformValues(valuesFromPersisted(opened.meta.uniforms));
      setProjectName(opened.meta.name || '未命名项目');
      setProjectDir(opened.dir);
      setPreviewTarget('image');
      api?.setPreviewTarget('image');
      setDiagnostics([]);
      setActiveTab('image');
      setDirty(false);
      scheduleCompile();
      notify(`已打开项目：${opened.meta.name}`, 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const saveProjectAs = async () => {
    let dir: string | null;
    try {
      dir = await pickFolder('选择项目保存位置', projectName());
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
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
      await saveProjectTo(dir, full, sources());
      setMeta(parseProject(serializeProject(full)));
      setProjectDir(dir);
      setDirty(false);
      notify(`已保存到 ${dir}`, 'ok');
    } catch (e) {
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const saveProject = async () => {
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
      await saveProjectTo(projectDir()!, full, sources());
      setMeta(full);
      setDirty(false);
      notify('项目已保存', 'ok');
    } catch (e) {
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const importShadertoy = async () => {
    if (!confirmUnsaved()) return;
    let file: string | null;
    try {
      file = await pickFile('导入 Shadertoy JSON', ['json']);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
      return;
    }
    if (!file) return;
    try {
      const text = await readTextFile(file);
      const imp = parseShadertoyJson(text);
      applySources(imp.sources);
      const m = createProject(imp.name || 'Shadertoy 导入');
      m.description = imp.description;
      for (const bid of BUFFER_IDS) {
        const cfg = imp.buffers[bid];
        if (cfg) {
          m.passes[bid] = {
            enabled: cfg.enabled,
            feedback: cfg.feedback,
            channels: cfg.channels,
          };
        }
      }
      const imgCfg = imp.buffers.image;
      if (imgCfg) m.passes.image = { ...m.passes.image, channels: imgCfg.channels };
      if (imp.sound) m.passes.sound = { enabled: true };
      setMeta(m);
      setProjectName(m.name);
      setProjectDir(null);
      setUniformValues({});
      setPreviewTarget('image');
      api?.setPreviewTarget('image');
      setDiagnostics([]);
      setActiveTab('image');
      setDirty(true);
      scheduleCompile();
      const skip = imp.skippedChannels.map((s) => `${s.ctype}×${s.count}`).join('、');
      notify(`已导入 Shadertoy：${m.name}${skip ? `（跳过 ${skip}）` : ''}`, 'ok');
    } catch (e) {
      notify(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const exportShadertoyJson = async () => {
    let dir: string | null;
    try {
      dir = await pickFolder('选择 Shadertoy JSON 导出位置');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
      return;
    }
    if (!dir) return;
    try {
      const full: ShaderlabProject = { ...meta(), name: projectName() };
      const text = toShadertoyJson(full, sources());
      const name = shadertoyFileName(projectName());
      await writeTextFile(joinPath(dir, name), text);
      notify(`已导出 Shadertoy JSON → ${joinPath(dir, name)}`, 'ok');
    } catch (e) {
      notify(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const runAutosave = async () => {
    if (!dirty()) return;
    try {
      const r = await writeAutosave(
        projectDir(),
        projectName(),
        sources(),
        toPersistedUniforms(uniformDecls(), uniformValues()),
      );
      autosaveInfo = { path: r.path || undefined, savedAt: r.savedAt };
    } catch {
      return;
    }
  };

  const persistSession = (cleanExit: boolean) => {
    writeSession({
      cleanExit,
      projectDir: projectDir(),
      projectName: projectName(),
      autosavePath: autosaveInfo.path,
      autosaveAt: autosaveInfo.savedAt,
    });
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
    const snap = await readLatestAutosave(bootSession?.projectDir ?? projectDir());
    setRecover(null);
    if (!snap) {
      notify('没有可恢复的自动保存内容', 'error');
      return;
    }
    applySources(snap.sources);
    setProjectName(snap.name || '未命名项目');
    setUniformValues(valuesFromPersisted(snap.uniforms ?? []));
    setDiagnostics([]);
    setDirty(true);
    scheduleCompile();
    notify('已恢复上次异常退出前的内容（尚未保存）', 'ok');
  };

  const discardRecover = () => {
    if (!projectDir()) clearScratchAutosave();
    setRecover(null);
  };

  const jumpTo = (d: MappedDiag) => {
    setActiveTab(d.tab);
    setTimeout(() => {
      if (!editorRef) return;
      const max = editorRef.getModel()?.getLineCount() ?? d.line;
      const ln = Math.max(1, Math.min(d.line, max));
      editorRef.revealLineInCenter(ln);
      editorRef.setPosition({ lineNumber: ln, column: Math.max(1, d.column) });
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
    if (!projectName().trim()) setProjectName('未命名项目');
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

  const applyResolution = (s: number) => api?.setResolutionScale(s);

  const closeMenu = () => setMenuOpen(false);
  const closePassMenu = () => setPassMenuOpen(false);
  const closeUniformMenu = () => setUniformMenuOpen(false);
  const closeSpeedMenu = () => setSpeedOpen(false);

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
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const el = document.activeElement as HTMLElement | null;
      const inMonaco = !!el?.closest('.monaco-editor');
      const inModal = !!el?.closest('[aria-modal="true"]');
      const inTextControl = !!el?.matches('input, textarea, select, [contenteditable="true"]');
      const inButtonLike = !!el?.matches('button, a, [role="button"], [role="menuitem"]');

      // Esc 只关闭当前最上层，避免一次退出多个上下文。
      if (e.key === 'Escape') {
        if (templateOpen()) setTemplateOpen(false);
        else if (exportOpen()) setExportOpen(false);
        else if (agentSettingsOpen()) setAgentSettingsOpen(false);
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
          newProject();
          return;
        }
        if (key === 'e') {
          e.preventDefault();
          setExportOpen(true);
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
        scheduleCompile();
      },
      setCommon: (src: string) => {
        updateSource('common', src);
        setDirty(true);
        scheduleCompile();
      },
      setSound: (src: string) => {
        updateSource('sound', src);
        setDirty(true);
        scheduleCompile();
      },
      setBuffer: (id: string, src: string) => {
        if (!isBufferId(id)) return;
        updateSource(id, src);
        setDirty(true);
        scheduleCompile();
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
      captureAt: (time: number, frameIndex: number, dt: number, size?: CaptureSize) =>
        api?.captureAt(time, frameIndex, dt, size),
      renderAudio: (dur: number, rate?: number) => api?.renderAudio(dur, rate),
      compileSync: () => {
        clearTimeout(debounceTimer);
        if (!api) return -1;
        const r = api.compile(runtimeSetup());
        setDiagnostics(r.diagnostics);
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
        applyTemplate(t as ProjectTemplate);
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
  }

  const handleCompileResult = (r: CompileResult) => {
    setDiagnostics(r.diagnostics);
    setCompileState('ready');
  };

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
      <aside class="rail" aria-label="主导航">
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
            title="项目"
            aria-label="项目菜单"
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
                  newProject();
                }}
              >
                <span>新建项目</span>
                <kbd>Ctrl+N</kbd>
              </button>
              <button
                class="menu-item"
                onClick={() => setTemplateOpen(true)}
              >
                <span>从模板新建…</span>
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void openProject();
                }}
              >
                <span>打开项目…</span>
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
                <span>保存</span>
                <kbd>Ctrl+S</kbd>
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void saveProjectAs();
                }}
              >
                <span>另存为…</span>
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
                <span>导入 Shadertoy JSON…</span>
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  closeMenu();
                  void exportShadertoyJson();
                }}
              >
                <span>导出 Shadertoy JSON…</span>
              </button>
              <div class="menu-sep" />
              <div class="menu-info">
                {dirty() ? '● 有未保存更改' : '✓ 无未保存更改'}
              </div>
            </div>
          </Show>
        </div>
        <button class="rail-btn" title="模板库" aria-label="打开模板库" onClick={() => setTemplateOpen(true)}>
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
            title="Pass 结构"
            aria-label="渲染 Pass 结构"
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
                        <label class="pass-toggle sub" title="将上一帧输出作为本 Pass 输入">
                          <input
                            type="checkbox"
                            checked={!!meta().passes[b]?.feedback}
                            onChange={(e) => setPassFeedback(b, e.currentTarget.checked)}
                          />
                          <span>反馈</span>
                        </label>
                        <button
                          class="btn mini"
                          onClick={() => {
                            setActiveTab(b);
                            closePassMenu();
                          }}
                        >
                          编辑
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
              <div class="menu-info">启用的 Buffer 按序执行，可被其它 Pass 作为 iChannel 引用</div>
            </div>
          </Show>
        </div>
        <div class="menu-root rail-slot" ref={uniformRootRef}>
          <button
            class="rail-btn"
            classList={{ active: uniformMenuOpen() }}
            title="Uniform 参数"
            aria-label="Uniform 参数"
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
          title="编译诊断"
          aria-label="显示或隐藏编译诊断"
          aria-expanded={diagOpen()}
          onClick={() => setDiagOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 12 7.5 12 10.5 5 14.5 19 17 12 21 12" />
          </svg>
        </button>
        <div class="rail-spacer" />
        <button
          class="rail-btn"
          title={theme() === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-label={theme() === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
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
        <button class="rail-btn" title="AI 服务设置" aria-label="打开 AI 服务设置" onClick={() => setAgentSettingsOpen(true)}>
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
          title="AI 助手（对话生成 Shader）"
          aria-label={chatOpen() ? '关闭 AI 助手' : '打开 AI 助手'}
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
        <header class="topbar glass" onMouseDown={topbarStartDrag} onDblClick={topbarToggleMaximize}>
          <div class="proj">
            <div class="brand-col">
              <div class="proj-row">
                <input
                  class="proj-name-input"
                  value={projectName()}
                  maxlength="80"
                  aria-label="项目名称"
                  title="编辑项目名称"
                  onInput={(e) => renameProject(e.currentTarget.value)}
                  onBlur={finishProjectRename}
                />
                <Show when={dirty()}>
                  <span class="dot-mod" title="未保存修改" aria-label="有未保存修改" />
                </Show>
              </div>
              <span class="proj-sub">ShaderLab Pro · GLSL 工作台</span>
            </div>
          </div>
          <div class="compact-pane-switch" aria-label="工作区视图">
            <button
              classList={{ active: compactPane() === 'editor' }}
              onClick={() => setCompactPane('editor')}
            >
              编辑
            </button>
            <button
              classList={{ active: compactPane() === 'preview' }}
              onClick={() => setCompactPane('preview')}
            >
              预览
            </button>
          </div>
          <div class="transport">
            <button
              class="t-btn t-play"
              onClick={togglePlay}
              title={playing() ? '暂停（空格）' : '播放（空格）'}
              aria-label={playing() ? '暂停预览' : '播放预览'}
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
            <button class="t-btn" onClick={() => api?.reset()} title="重置（R）" aria-label="重置预览时间">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="2 4.5 2 10 7.5 10" />
                <path d="M4 15a8.5 8.5 0 1 0 1.8-9.3L2 10" />
              </svg>
            </button>
            <button class="t-btn" onClick={() => setExportOpen(true)} title="序列帧导出（Ctrl+E）" aria-label="打开导出设置">
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
              aria-label="预览时间轴"
              aria-valuetext={`${stats().time.toFixed(2)} 秒`}
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
              {stats().time.toFixed(2)} / {timelineMax().toFixed(0)} s
            </span>
            <div class="menu-root chip-slot" ref={speedRootRef}>
              <button
                class="chip"
                classList={{ active: speedOpen() }}
                title="播放速度"
                aria-label={`播放速度 ${speed().toFixed(1)} 倍`}
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
                    <span class="ctl-label">速度</span>
                    <input
                      type="range"
                      class="speed-slider"
                      aria-label="播放速度"
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
            <span class="chip-k">查看</span>
            <select
              class="chip-select"
              value={previewTarget()}
              onChange={(e) => applyPreviewTarget(e.currentTarget.value as RenderPassId)}
              title="预览目标 Pass 输出"
            >
              <option value="image">Image</option>
              <For each={enabledBuffers()}>
                {(b) => <option value={b}>Buf {BUFFER_LETTER[b]}</option>}
              </For>
            </select>
          </label>
          <label class="chip">
            {/* 标签在前、值在后，与「查看」chip 保持平行的阅读结构，避免视觉上镜像错位 */}
            <span class="chip-k">分辨率</span>
            <select
              class="chip-select"
              value={String(nearestScale(stats().scale))}
              onChange={(e) => applyResolution(parseFloat(e.currentTarget.value))}
              title="渲染分辨率倍率"
            >
              <For each={SCALE_STEPS}>{(s) => <option value={String(s)}>{s}×</option>}</For>
            </select>
          </label>
          <WindowControls />
        </header>

        <Show when={recover()}>
          <div class="recover-banner glass">
            <span>
              ⚠ 检测到上次异常退出 ·{' '}
              {new Date(recover()!.savedAt).toLocaleTimeString()} 的自动保存可恢复
            </span>
            <button class="btn primary" onClick={() => void doRecover()}>
              恢复
            </button>
            <button class="btn" onClick={discardRecover}>
              丢弃
            </button>
          </div>
        </Show>

        <div class="workspace">
          <div
            class={`workbench pane-${compactPane()}`}
            ref={workspaceRef}
          >
          <section class="editor glass" style={{ flex: `0 0 ${editorRatio() * 100}%` }}>
            <EditorPane
              sources={sources}
              onSourceChange={handleEditorChange}
              diagnostics={mappedDiags()}
              onEditorReady={(e) => (editorRef = e)}
              tabs={tabs()}
              activeTab={activeTab()}
              onTabChange={(id) => setActiveTab(id as TabId)}
              onNotify={notify}
              projectName={projectName()}
            />
            <Show when={diagOpen()}>
              <DiagnosticsPane diagnostics={mappedDiags()} onJump={jumpTo} />
            </Show>
            <footer class="statusline" aria-live="polite">
              <button
                class={`sl-status ${compileState() !== 'ready' ? 'pending' : errCount() ? 'error' : 'ok'}`}
                disabled={compileState() !== 'ready' || errCount() === 0}
                onClick={() => setDiagOpen(true)}
                title={errCount() ? '打开编译问题列表' : undefined}
              >
                {compileState() === 'pending'
                  ? '◌ 等待编译…'
                  : compileState() === 'compiling'
                    ? '◌ 编译中…'
                    : errCount()
                      ? `✕ ${errCount()} 个编译错误`
                      : '✓ 编译通过'}
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
            aria-label="调整编辑器与预览区宽度"
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
            title="拖拽或方向键调整分栏 · 双击恢复"
          />
          <section class="preview glass">
            <div class="canvas">
              <PreviewPane
                setup={runtimeSetup}
                playing={playing}
                onStats={setStats}
                onCompileResult={handleCompileResult}
                onReady={(a) => (api = a)}
              />
              <div class="hud hud-tl">
                <span class="hud-chip">Pass · {tabLabel(previewTarget())}</span>
              </div>
              <div class="hud hud-tr">
                <span class="hud-chip accent">{stats().fps} FPS</span>
                <span class="hud-chip">{stats().time.toFixed(1)} s</span>
                <span class="hud-chip">#{stats().frame}</span>
              </div>
            </div>
            <div class="preset-strip" classList={{ compact: uniformGroups().length === 0 }}>
              <span class="preset-label">参数 · UNIFORM</span>
              <Show when={uniformGroups().length === 0}>
                <span class="preset-empty">暂无参数，可在代码中添加 @uniform 声明</span>
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
                        aria-label={`${d.name} 参数`}
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
                全部参数
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
            <Show when={uniformInspectorOpen()}>
              <aside class="uniform-inspector" aria-label="Uniform Inspector">
                <div class="uniform-inspector-head">
                  <strong>Uniform Inspector</strong>
                  <button
                    class="btn mini"
                    aria-label="关闭 Uniform Inspector"
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
            <ChatPanel
              onApplyCode={applyAiCode}
              onPreview={startPreview}
              onCancelPreview={stopPreview}
              previewActive={!!previewState()}
              appliedCandidateCode={lastAppliedAiCode()}
              onOpenSettings={() => setAgentSettingsOpen(true)}
              onClose={() => setChatOpen(false)}
            />
          </Show>
        </div>
      </main>

      <Show when={exportOpen()}>
        <ExportDialog
          api={() => api}
          onClose={() => setExportOpen(false)}
          onDone={notify}
        />
      </Show>

      <Show when={templateOpen()}>
        <TemplateDialog
          templates={PROJECT_TEMPLATES}
          onSelect={applyTemplate}
          onClose={() => setTemplateOpen(false)}
          userTemplates={userTemplates()}
          onApplyUser={(t) => void applyUserTemplateCode(t)}
          onPreviewUser={(t) => startPreview(t.name, t.code)}
          editorCode={() => sources().image ?? ''}
          notify={notify}
        />
      </Show>

      <Show when={agentSettingsOpen()}>
        <AgentSettingsDialog
          onClose={() => setAgentSettingsOpen(false)}
          onSaved={(v) => {
            setAgentSettingsOpen(false);
            notify(
              v.configured
                ? `AI 服务已生效：${v.model}`
                : 'AI 服务配置已保存，但 API Key 仍为空',
              v.configured ? 'ok' : 'error',
            );
          }}
        />
      </Show>

      <Show when={toast()}>
        <div class={`toast ${toast()!.kind}`} role="status" aria-live="polite">{toast()!.msg}</div>
      </Show>

      <Show when={previewState()}>
        <div class="preview-bar" role="status">
          <span>临时预览：{previewState()!.name}</span>
          <span class="spacer" />
          <button class="btn mini" onClick={stopPreview}>
            恢复原代码
          </button>
        </div>
      </Show>

      <Show when={aiUndo() && !previewState()}>
        <div class="preview-bar ai-undo-bar" role="status">
          <span>AI 候选代码已应用</span>
          <span class="spacer" />
          <button class="btn mini" onClick={undoAiCode}>撤销本次修改</button>
          <button class="btn mini" onClick={() => setAiUndo(null)} aria-label="关闭撤销提示">×</button>
        </div>
      </Show>
    </div>
  );
};

export default App;
