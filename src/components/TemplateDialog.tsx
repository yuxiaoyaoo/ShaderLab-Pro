import { For, Show, createSignal, type Component } from 'solid-js';
import { useModalFocus } from './modalFocus';
import type { ProjectTemplate } from '../templates';
import {
  deleteUserTemplate,
  saveUserTemplate,
  type UserTemplateViewDto,
} from '../agent/agentClient';

interface Props {
  templates: ProjectTemplate[];
  onSelect: (t: ProjectTemplate) => void;
  onClose: () => void;
  /** M6c：自定义模板池（App 维护，user-templates-changed 事件驱动刷新） */
  userTemplates: UserTemplateViewDto[];
  onApplyUser: (t: UserTemplateViewDto) => void;
  onPreviewUser: (t: UserTemplateViewDto) => void;
  /** M6c：一键带入编辑器当前 Image 源码 */
  editorCode: () => string;
  notify: (msg: string, kind?: 'ok' | 'error') => void;
}

const BLANK_CODE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}
`;

const DIFFICULTIES = ['入门', '进阶', '高级'];

const TemplateDialog: Component<Props> = (props) => {
  const [formOpen, setFormOpen] = createSignal(false);
  const [editingSlug, setEditingSlug] = createSignal<string | null>(null);
  const [fName, setFName] = createSignal('');
  const [fDesc, setFDesc] = createSignal('');
  const [fTags, setFTags] = createSignal('');
  const [fDiff, setFDiff] = createSignal('入门');
  const [fCode, setFCode] = createSignal(BLANK_CODE);
  const [fError, setFError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let dialogRef: HTMLDivElement | undefined;
  useModalFocus(() => dialogRef);

  const openCreate = (fromEditor: boolean) => {
    setEditingSlug(null);
    setFName('');
    setFDesc('');
    setFTags('');
    setFDiff('入门');
    const cur = props.editorCode().trim();
    setFCode(fromEditor && cur ? cur : BLANK_CODE);
    setFError(null);
    setFormOpen(true);
  };

  const openEdit = (t: UserTemplateViewDto) => {
    setEditingSlug(t.slug);
    setFName(t.name);
    setFDesc(t.description);
    setFTags(t.tags.join('，'));
    setFDiff(DIFFICULTIES.includes(t.difficulty) ? t.difficulty : '入门');
    setFCode(t.code);
    setFError(null);
    setFormOpen(true);
  };

  const submitForm = async () => {
    if (busy()) return;
    setFError(null);
    setBusy(true);
    try {
      await saveUserTemplate({
        name: fName(),
        description: fDesc(),
        tags: fTags()
          .split(/[,，\s]+/)
          .filter(Boolean),
        difficulty: fDiff(),
        uniforms: [],
        code: fCode(),
      });
      props.notify(editingSlug() ? '自定义模板已更新' : '自定义模板已保存', 'ok');
      setEditingSlug(null);
      setFormOpen(false);
    } catch (e) {
      setFError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async (t: UserTemplateViewDto) => {
    if (!window.confirm(`删除自定义模板「${t.name}」？此操作不可恢复。`)) return;
    try {
      await deleteUserTemplate(t.slug);
      props.notify('自定义模板已删除', 'ok');
    } catch (e) {
      props.notify(String(e), 'error');
    }
  };

  return (
    <div
      class="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-dialog-title"
        tabindex="-1"
      >
        <Show
          when={!formOpen()}
          fallback={
            <>
              <h3 id="template-dialog-title">{editingSlug() ? '编辑自定义模板' : '新建自定义模板'}</h3>
              <div class="tpl-form">
                <label>
                  名称 *
                  <input
                    value={fName()}
                    maxlength={32}
                    placeholder="≤ 32 字，如：等离子涟漪"
                    onInput={(e) => setFName(e.currentTarget.value)}
                  />
                </label>
                <label>
                  描述
                  <input
                    value={fDesc()}
                    placeholder="一句话说明效果与亮点"
                    onInput={(e) => setFDesc(e.currentTarget.value)}
                  />
                </label>
                <div class="tpl-form-row">
                  <label>
                    标签（逗号分隔）
                    <input
                      value={fTags()}
                      placeholder="如：粒子，发光"
                      onInput={(e) => setFTags(e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    难度
                    <select value={fDiff()} onChange={(e) => setFDiff(e.currentTarget.value)}>
                      <For each={DIFFICULTIES}>{(d) => <option value={d}>{d}</option>}</For>
                    </select>
                  </label>
                </div>
                <label>
                  GLSL 代码 *
                  <textarea
                    class="tpl-code"
                    spellcheck={false}
                    rows={10}
                    value={fCode()}
                    onInput={(e) => setFCode(e.currentTarget.value)}
                  />
                  <span class="tpl-form-hint">
                    需含 mainImage 入口；iTime/iResolution 等由运行时注入，请勿声明 uniform。
                  </span>
                </label>
                <Show when={fError()}>
                  <pre class="tpl-form-error">{fError()}</pre>
                </Show>
              </div>
              <div class="modal-actions">
                <button class="btn" disabled={busy()} onClick={() => void submitForm()}>
                  {busy() ? '保存中…' : '保存'}
                </button>
                <button class="btn" onClick={() => setFormOpen(false)}>
                  取消
                </button>
              </div>
            </>
          }
        >
          <h3 id="template-dialog-title">模板库</h3>
          <div class="tpl-toolbar">
            <span class="tpl-hint">
              项目模板 {props.templates.length} 个 · 我的模板 {props.userTemplates.length} 个
            </span>
            <button class="btn mini" onClick={() => openCreate(true)}>
              从当前代码新建
            </button>
            <button class="btn mini" onClick={() => openCreate(false)}>
              ＋ 新建
            </button>
          </div>
          <div class="tpl-list">
            <Show when={props.userTemplates.length > 0}>
              <div class="tpl-group-title">📌 我的模板</div>
              <For each={props.userTemplates}>
                {(t) => (
                  <div class="tpl-item custom">
                    <div class="tpl-name">{t.name}</div>
                    <div class="tpl-desc">{t.description || t.tags.join(' · ')}</div>
                    <div class="tpl-actions">
                      <button
                        class="btn mini"
                        onClick={() => {
                          props.onPreviewUser(t);
                          props.onClose();
                        }}
                      >
                        预览
                      </button>
                      <button class="btn mini" onClick={() => props.onApplyUser(t)}>
                        应用
                      </button>
                      <button class="btn mini" onClick={() => openEdit(t)}>
                        编辑
                      </button>
                      <button class="btn mini danger" onClick={() => void removeTemplate(t)}>
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
            <div class="tpl-group-title">🧱 项目模板</div>
            <For each={props.templates}>
              {(t) => (
                <div class="tpl-item">
                  <div class="tpl-name">{t.name}</div>
                  <div class="tpl-desc">{t.desc}</div>
                  <button class="btn" onClick={() => props.onSelect(t)}>
                    应用
                  </button>
                </div>
              )}
            </For>
          </div>
          <div class="modal-actions">
            <button class="btn" onClick={() => props.onClose()}>
              关闭
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default TemplateDialog;
