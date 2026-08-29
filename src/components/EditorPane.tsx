import { createEffect, createSignal, onCleanup, onMount, type Component, For, Show } from 'solid-js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { GLSL_LANGUAGE_ID } from '../editor/glslLanguage';
import {
  registerGlslProviders,
  setPassSourcesGetter,
  uriForPass,
  type PassSource,
} from '../editor/glslIntellisense';
import type { MappedDiag } from './DiagnosticsPane';
import type { ProjectSources, SrcPassId } from '../project/types';
import { joinPath } from '../project/types';
import { hasTauri, pickFolder, writeTextFile } from '../project/bridge';
import type { ExportTicket } from '../export/exportEligibility';
import type { ProductMessageDescriptor } from '../productMessage';
import { formatProductMessage } from '../productMessageFormatter';
import { VERT_SRC } from '../shadertoy/runtime';
import { theme } from '../theme';
import { t } from '../i18n';

export interface TabDef {
  id: string;
  label: string;
}

interface Props {
  /** Editable Code sources used by Monaco models. */
  sources: () => ProjectSources;
  /** Runtime/export sources; Graph passes can supply generated GLSL here in M1. */
  effectiveSources: () => ProjectSources;
  shadertoyJson: () => string;
  tabs: TabDef[];
  activeTab: string;
  onSourceChange: (id: string, v: string) => void;
  onTabChange: (id: string) => void;
  diagnostics: MappedDiag[];
  onEditorReady?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  /** M5：导出/复制结果通知（接 App 的 toast） */
  onNotify?: (msg: string, kind: 'ok' | 'error') => void;
  /** M5：项目名，用于导出文件命名与 Shadertoy 包 info.name */
  projectName?: string;
  canExport?: boolean;
  exportBlockedReason?: ProductMessageDescriptor;
  captureExportTicket?: () => ExportTicket | undefined;
  canExportShadertoy?: boolean;
  shadertoyExportBlockedReason?: ProductMessageDescriptor;
  captureShadertoyExportTicket?: () => ExportTicket | undefined;
  validateExportTicket?: (ticket: ExportTicket) => ProductMessageDescriptor | undefined;
}

let providersRegistered = false;

const passIdOf = (id: string): SrcPassId =>
  (id === 'image' || id === 'common' || id === 'sound' || id.startsWith('buffer')
    ? id
    : 'image') as SrcPassId;

const passIdFromUri = (path: string): string => {
  const m = /([^/]+)\.glsl$/.exec(path.replace(/\\/g, '/'));
  const id = m ? m[1] : 'image';
  return id === 'image' || id === 'common' || id === 'sound' || id.startsWith('buffer')
    ? id
    : 'image';
};

const EditorPane: Component<Props> = (props) => {
  let container!: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let syncingExternalSource = false;
  const models: Record<string, monaco.editor.ITextModel> = {};
  /** M5：代码导出下拉菜单 */
  const [exportMenuOpen, setExportMenuOpen] = createSignal(false);

  const notify = (msg: string, kind: 'ok' | 'error' = 'ok') => {
    if (props.onNotify) props.onNotify(msg, kind);
    else if (kind === 'error') console.warn(msg);
  };

  const activeSource = (): string =>
    (props.sources()[passIdOf(props.activeTab)] as string) ?? '';

  const activeEffectiveSource = (): string =>
    (props.effectiveSources()[passIdOf(props.activeTab)] as string) ?? '';

  const safeBaseName = (): string =>
    (props.projectName?.trim() || 'shader').replace(/[\\/:*?"<>|]/g, '_');

  // —— M5：代码导出 ——

  const copyActive = async () => {
    const text = activeEffectiveSource();
    if (!text.trim()) return notify(t('editor.copy.emptyPass'), 'error');
    try {
      await navigator.clipboard.writeText(text);
      notify(props.canExport === false
        ? t('editor.copy.staleSourceCopied')
        : t('editor.copy.success'));
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        notify(props.canExport === false
          ? t('editor.copy.staleSourceCopied')
          : t('editor.copy.success'));
      } catch {
        notify(t('editor.copy.clipboardUnavailable'), 'error');
      }
    }
  };

  const saveToFolder = async (fileName: string, contents: string, ticket?: ExportTicket): Promise<void> => {
    if (!hasTauri()) {
      notify(t('editor.export.desktopOnly'), 'error');
      return;
    }
    try {
      const dir = await pickFolder(t('editor.export.pickerTitle'), fileName);
      if (!dir) return;
      const path = joinPath(dir, fileName);
      if (ticket) {
        const blocked = props.validateExportTicket?.(ticket);
        if (blocked) return notify(t('editor.export.blocked', { detail: formatProductMessage(blocked) }), 'error');
      }
      await writeTextFile(path, contents);
      notify(t('editor.export.saved', { path }));
    } catch (e) {
      const detail = formatProductMessage(e);
      notify(t('editor.export.failed', { detail }), 'error');
    }
  };

  const saveActiveFrag = () => {
    if (props.canExport === false) {
      const detail = props.exportBlockedReason ? formatProductMessage(props.exportBlockedReason) : t('editor.export.graphNotAccepted');
      return notify(t('editor.export.blocked', { detail }), 'error');
    }
    const ticket = props.captureExportTicket?.();
    if (!ticket) {
      const detail = props.exportBlockedReason ? formatProductMessage(props.exportBlockedReason) : t('editor.export.invalidTicket');
      return notify(t('editor.export.blocked', { detail }), 'error');
    }
    const text = activeEffectiveSource();
    if (!text.trim()) return notify(t('editor.export.emptyPass'), 'error');
    void saveToFolder(`${safeBaseName()}-${props.activeTab}.frag`, `${text}\n`, ticket);
  };

  const saveVert = () => {
    void saveToFolder(`${safeBaseName()}-fullscreen.vert`, `${VERT_SRC}\n`);
  };

  const saveShadertoyJson = () => {
    if ((props.canExportShadertoy ?? props.canExport) === false) {
      const reason = props.shadertoyExportBlockedReason ?? props.exportBlockedReason;
      const detail = reason ? formatProductMessage(reason) : t('editor.export.projectNotAccepted');
      return notify(t('editor.export.blocked', { detail }), 'error');
    }
    const captureTicket = props.captureShadertoyExportTicket ?? props.captureExportTicket;
    const ticket = captureTicket?.();
    if (!ticket) {
      const reason = props.shadertoyExportBlockedReason ?? props.exportBlockedReason;
      const detail = reason ? formatProductMessage(reason) : t('editor.export.projectInvalidTicket');
      return notify(t('editor.export.blocked', { detail }), 'error');
    }
    let json: string;
    try {
      json = props.shadertoyJson();
    } catch (error) {
      const detail = formatProductMessage(error);
      notify(t('editor.export.packageFailed', { detail }), 'error');
      return;
    }
    if (!json.trim()) return notify(t('editor.export.noPassSources'), 'error');
    void saveToFolder(`${safeBaseName()}-shadertoy.json`, json, ticket);
  };

  const getModel = (id: string): monaco.editor.ITextModel => {
    let m = models[id];
    if (m) return m;
    m = monaco.editor.createModel(
      (props.sources()[passIdOf(id)] as string) || '',
      GLSL_LANGUAGE_ID,
      uriForPass(id),
    );
    models[id] = m;
    return m;
  };

  createEffect(() => {
    monaco.editor.setTheme(theme() === 'dark' ? 'shaderlab-dark' : 'shaderlab-light');
  });

  onMount(() => {
    if (!providersRegistered) {
      providersRegistered = true;
      registerGlslProviders(monaco);
    }
    const g = props.sources;
    setPassSourcesGetter(() => {
      const s = g();
      return props.tabs.map((t): PassSource => ({
        id: passIdOf(t.id),
        label: t.label,
        text: (s[passIdOf(t.id)] as string) || '',
      }));
    });
    editor = monaco.editor.create(container, {
      model: getModel(props.activeTab),
      language: GLSL_LANGUAGE_ID,
      // 主题不可硬编码：须取当前信号值，否则浅色模式下刷新/重挂载后编辑器会卡在深色（同步 effect 只在主题变化时重跑）
      theme: theme() === 'dark' ? 'shaderlab-dark' : 'shaderlab-light',
      fontSize: 14,
      fontLigatures: true,
      minimap: { enabled: false },
      automaticLayout: true,
      tabSize: 4,
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      guides: { indentation: false },
      smoothScrolling: true,
      padding: { top: 10 },
    });
    editor.onDidChangeModelContent(() => {
      if (syncingExternalSource) return;
      const m = editor!.getModel();
      if (!m) return;
      const id = passIdFromUri(m.uri.path);
      props.onSourceChange(id, m.getValue());
    });
    editor.onDidChangeModel(() => {
      const m = editor!.getModel();
      if (!m) return;
      props.onTabChange(passIdFromUri(m.uri.path));
    });
    props.onEditorReady?.(editor);
  });

  createEffect(() => {
    const tab = props.activeTab;
    if (!editor) return;
    const m = getModel(tab);
    if (editor.getModel() !== m) editor.setModel(m);
  });

  createEffect(() => {
    const s = props.sources();
    for (const id of Object.keys(models)) {
      const model = models[id];
      const target = (s[passIdOf(id)] as string) || '';
      if (model.getValue() !== target) {
        syncingExternalSource = true;
        try {
          model.setValue(target);
        } finally {
          syncingExternalSource = false;
        }
      }
    }
  });

  createEffect(() => {
    const diags = props.diagnostics;
    for (const id of Object.keys(models)) {
      const model = models[id];
      const tab = passIdOf(id);
      const list = diags
        .filter((d) => d.tab === tab)
        .map((d) => {
          const line = Math.max(1, Math.min(d.line, model.getLineCount()));
          const lineLen = model.getLineMaxColumn(line);
          const severity = d.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : d.severity === 'info'
              ? monaco.MarkerSeverity.Info
              : monaco.MarkerSeverity.Error;
          return {
            startLineNumber: line,
            endLineNumber: line,
            startColumn: Math.max(1, Math.min(d.column, lineLen)),
            endColumn: Math.max(d.column + 1, lineLen),
            message: formatProductMessage(d),
            severity,
            source: d.stage,
            code: d.code,
          };
        });
      monaco.editor.setModelMarkers(model, GLSL_LANGUAGE_ID, list);
    }
  });

  onCleanup(() => {
    editor?.dispose();
    for (const m of Object.values(models)) m.dispose();
  });

  return (
    <div class="editor-pane">
      <Show when={props.tabs.length > 0}>
        <div class="editor-tabs" role="tablist" aria-label={t('editor.passTabsAria')}>
          <For each={props.tabs}>
            {(tab) => (
              <button
                class="editor-tab"
                role="tab"
                aria-selected={props.activeTab === tab.id}
                classList={{ active: props.activeTab === tab.id }}
                onClick={() => props.onTabChange(tab.id)}
              >
                {tab.label}
              </button>
            )}
          </For>
          {/* M5：代码导出工具栏 */}
          <div class="editor-actions">
            <button
              class="btn mini"
              title={t('editor.copy.title')}
              onClick={() => void copyActive()}
            >
              {t('editor.copy.action')}
            </button>
            <div class="editor-export">
              <Show when={exportMenuOpen()}>
                <div class="menu-overlay" onPointerDown={() => setExportMenuOpen(false)} />
                <div class="editor-export-menu">
                  <button
                    disabled={props.canExport === false}
                    title={props.canExport === false
                      ? t('editor.export.blocked', {
                          detail: props.exportBlockedReason
                            ? formatProductMessage(props.exportBlockedReason)
                            : t('editor.export.graphNotAccepted'),
                        })
                      : undefined}
                    onClick={() => {
                      setExportMenuOpen(false);
                      saveActiveFrag();
                    }}
                  >
                    {t('editor.export.currentPass', { extension: '.frag' })}
                  </button>
                  <button
                    onClick={() => {
                      setExportMenuOpen(false);
                      saveVert();
                    }}
                  >
                    {t('editor.export.vertexShader', { extension: '.vert' })}
                  </button>
                  <button
                    disabled={(props.canExportShadertoy ?? props.canExport) === false}
                    title={(props.canExportShadertoy ?? props.canExport) === false
                      ? t('editor.export.blocked', {
                          detail: props.shadertoyExportBlockedReason || props.exportBlockedReason
                            ? formatProductMessage(props.shadertoyExportBlockedReason ?? props.exportBlockedReason)
                            : t('editor.export.projectNotAccepted'),
                        })
                      : undefined}
                    onClick={() => {
                      setExportMenuOpen(false);
                      saveShadertoyJson();
                    }}
                  >
                    {t('editor.export.shadertoyPackage', { file: 'shadertoy.json' })}
                  </button>
                </div>
              </Show>
              <button
                class="btn mini"
                title={t('editor.export.codeFilesTitle')}
                onClick={() => setExportMenuOpen((v) => !v)}
              >
                {t('editor.export.action')} ▾
              </button>
            </div>
          </div>
        </div>
      </Show>
      <div class="editor-container" ref={container} />
    </div>
  );
};

export default EditorPane;