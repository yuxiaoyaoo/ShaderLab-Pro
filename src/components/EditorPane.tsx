import { createEffect, createSignal, onCleanup, onMount, type Component, For, Show } from 'solid-js';
import * as monaco from 'monaco-editor';
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
import { VERT_SRC } from '../shadertoy/runtime';
import { theme } from '../theme';

export interface TabDef {
  id: string;
  label: string;
}

interface Props {
  sources: () => ProjectSources;
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

  const safeBaseName = (): string =>
    (props.projectName?.trim() || 'shader').replace(/[\\/:*?"<>|]/g, '_');

  // —— M5：代码导出 ——

  const copyActive = async () => {
    const text = activeSource();
    if (!text.trim()) return notify('当前 Pass 无内容可复制', 'error');
    try {
      await navigator.clipboard.writeText(text);
      notify('已复制到剪贴板');
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
        notify('已复制到剪贴板');
      } catch {
        notify('复制失败：剪贴板不可用', 'error');
      }
    }
  };

  const saveToFolder = async (fileName: string, contents: string): Promise<void> => {
    if (!hasTauri()) {
      notify('文件导出仅在桌面应用中可用', 'error');
      return;
    }
    try {
      const dir = await pickFolder('选择导出目录', fileName);
      if (!dir) return;
      const path = joinPath(dir, fileName);
      await writeTextFile(path, contents);
      notify(`已导出到 ${path}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const saveActiveFrag = () => {
    const text = activeSource();
    if (!text.trim()) return notify('当前 Pass 无内容可导出', 'error');
    void saveToFolder(`${safeBaseName()}-${props.activeTab}.frag`, `${text}\n`);
  };

  const saveVert = () => {
    void saveToFolder(`${safeBaseName()}-fullscreen.vert`, `${VERT_SRC}\n`);
  };

  const buildShadertoyJson = (): string => {
    const s = props.sources();
    type RenderPass = {
      inputs: unknown[];
      outputs: unknown[];
      code: string;
      name: string;
      description: string;
      type: string;
    };
    const passes: RenderPass[] = [];
    const push = (name: string, type: string, src?: string) => {
      if (!src || !src.trim()) return;
      passes.push({
        inputs: [],
        outputs: type === 'image' ? [{ channel: 0, id: '4dfGRr' }] : [],
        code: src,
        name,
        description: '',
        type,
      });
    };
    push('Common', 'common', s.common);
    push('Buffer A', 'buffer', s.bufferA);
    push('Buffer B', 'buffer', s.bufferB);
    push('Buffer C', 'buffer', s.bufferC);
    push('Buffer D', 'buffer', s.bufferD);
    push('Sound', 'sound', s.sound);
    push('Image', 'image', s.image);
    return (
      JSON.stringify(
        {
          ver: '0.1',
          info: {
            id: '',
            date: Date.now(),
            viewcount: 0,
            name: props.projectName?.trim() || 'ShaderLab Pro 项目',
            username: 'ShaderLab Pro',
            description: '',
            likes: 0,
            published: 3,
            flags: 0,
            tags: [],
            hasliked: 0,
          },
          renderpass: passes,
          extra: {},
        },
        null,
        2,
      ) + '\n'
    );
  };

  const saveShadertoyJson = () => {
    const json = buildShadertoyJson();
    if (json.trim().length === 0) return notify('没有可导出的 Pass 源码', 'error');
    void saveToFolder(`${safeBaseName()}-shadertoy.json`, json);
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
          const lineLen = model.getLineMaxColumn(Math.min(d.line, model.getLineCount()));
          return {
            startLineNumber: d.line,
            endLineNumber: d.line,
            startColumn: Math.max(1, Math.min(d.column, lineLen)),
            endColumn: Math.max(d.column + 1, lineLen),
            message: d.message,
            severity: monaco.MarkerSeverity.Error,
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
        <div class="editor-tabs" role="tablist" aria-label="Shader Pass">
          <For each={props.tabs}>
            {(t) => (
              <button
                class="editor-tab"
                role="tab"
                aria-selected={props.activeTab === t.id}
                classList={{ active: props.activeTab === t.id }}
                onClick={() => props.onTabChange(t.id)}
              >
                {t.label}
              </button>
            )}
          </For>
          {/* M5：代码导出工具栏 */}
          <div class="editor-actions">
            <button class="btn mini" title="复制当前 Pass 源码" onClick={() => void copyActive()}>
              复制
            </button>
            <div class="editor-export">
              <Show when={exportMenuOpen()}>
                <div class="menu-overlay" onPointerDown={() => setExportMenuOpen(false)} />
                <div class="editor-export-menu">
                  <button
                    onClick={() => {
                      setExportMenuOpen(false);
                      saveActiveFrag();
                    }}
                  >
                    当前 Pass (.frag)
                  </button>
                  <button
                    onClick={() => {
                      setExportMenuOpen(false);
                      saveVert();
                    }}
                  >
                    顶点着色器 (.vert)
                  </button>
                  <button
                    onClick={() => {
                      setExportMenuOpen(false);
                      saveShadertoyJson();
                    }}
                  >
                    Shadertoy 包 (shadertoy.json)
                  </button>
                </div>
              </Show>
              <button
                class="btn mini"
                title="导出代码文件"
                onClick={() => setExportMenuOpen((v) => !v)}
              >
                导出 ▾
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