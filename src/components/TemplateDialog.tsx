import { For, Show, createMemo, createSignal, type Component } from 'solid-js';
import { difficultyLabel, locale, normalizeDifficulty, t, type TemplateDifficulty } from '../i18n';
import { normalizeProductMessage, type ProductMessageDescriptor } from '../productMessage';
import ProductMessageView from './ProductMessageView';
import { formatProductMessage } from '../productMessageFormatter';
import { useModalFocus } from './modalFocus';
import { getBuiltinTemplateDisplay, type ProjectTemplate } from '../templates';
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
  onApplyUser: (t: UserTemplateViewDto) => boolean | Promise<boolean>;
  onPreviewUser: (t: UserTemplateViewDto) => boolean;
  canApplyCode: boolean;
  codeApplyBlockedReason?: string;
  /** M6c：一键带入编辑器当前 Image 源码 */
  editorCode: () => string;
  requestConfirm: (options: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  notify: (msg: string, kind?: 'ok' | 'error') => void;
}

const BLANK_CODE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}
`;

const DIFFICULTIES: readonly TemplateDifficulty[] = ['beginner', 'intermediate', 'advanced'];

const TemplateDialog: Component<Props> = (props) => {
  const [formOpen, setFormOpen] = createSignal(false);
  const [editingSlug, setEditingSlug] = createSignal<string | null>(null);
  const [fName, setFName] = createSignal('');
  const [fDesc, setFDesc] = createSignal('');
  const [fTags, setFTags] = createSignal('');
  const [fDiff, setFDiff] = createSignal<TemplateDifficulty>('beginner');
  const [fCode, setFCode] = createSignal(BLANK_CODE);
  const [fError, setFError] = createSignal<ProductMessageDescriptor | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  let dialogRef: HTMLDivElement | undefined;
  useModalFocus(() => dialogRef);

  const normalizeForSearch = (value: string) => value.toLocaleLowerCase(locale());
  const filteredUserTemplates = createMemo(() => {
    const query = normalizeForSearch(searchQuery().trim());
    if (!query) return props.userTemplates;
    return props.userTemplates.filter((template) => (
      [template.name, template.description, ...template.tags, difficultyLabel(template.difficulty)]
        .some((value) => normalizeForSearch(value).includes(query))
    ));
  });
  const filteredProjectTemplates = createMemo(() => {
    const currentLocale = locale();
    const query = searchQuery().trim().toLocaleLowerCase(currentLocale);
    if (!query) return props.templates;
    return props.templates.filter((template) => {
      const display = getBuiltinTemplateDisplay(template, currentLocale);
      return [template.id, display.name, display.description]
        .some((value) => value.toLocaleLowerCase(currentLocale).includes(query));
    });
  });

  const openCreate = (fromEditor: boolean) => {
    setEditingSlug(null);
    setFName('');
    setFDesc('');
    setFTags('');
    setFDiff('beginner');
    const cur = props.editorCode().trim();
    setFCode(fromEditor && cur ? cur : BLANK_CODE);
    setFError(null);
    setFormOpen(true);
  };

  const openEdit = (t: UserTemplateViewDto) => {
    setEditingSlug(t.slug);
    setFName(t.name);
    setFDesc(t.description);
    setFTags(t.tags.join(', '));
    setFDiff(normalizeDifficulty(t.difficulty));
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
          .split(/[,，]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        difficulty: fDiff(),
        uniforms: [],
        code: fCode(),
      });
      props.notify(editingSlug() ? t('template.updated') : t('template.saved'), 'ok');
      setEditingSlug(null);
      setFormOpen(false);
    } catch (error) {
      setFError(normalizeProductMessage(error, 'chat.template-save-failed'));
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async (template: UserTemplateViewDto) => {
    if (!await props.requestConfirm({
      title: t('template.deleteTitle'),
      message: t('template.deleteMessage', { name: template.name }),
      confirmLabel: t('template.deleteConfirm'),
      danger: true,
    })) return;
    try {
      await deleteUserTemplate(template.slug);
      props.notify(t('template.deleted'), 'ok');
    } catch (error) {
      props.notify(
        formatProductMessage(normalizeProductMessage(error, 'chat.template-delete-failed')),
        'error',
      );
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
              <h3 id="template-dialog-title">{editingSlug() ? t('template.edit') : t('template.new')}</h3>
              <div class="tpl-form">
                <label>
                  {t('template.name')}
                  <input
                    value={fName()}
                    maxlength={32}
                    placeholder={t('template.namePlaceholder')}
                    onInput={(e) => setFName(e.currentTarget.value)}
                  />
                </label>
                <label>
                  {t('template.description')}
                  <input
                    value={fDesc()}
                    placeholder={t('template.descriptionPlaceholder')}
                    onInput={(e) => setFDesc(e.currentTarget.value)}
                  />
                </label>
                <div class="tpl-form-row">
                  <label>
                    {t('template.tags')}
                    <input
                      value={fTags()}
                      placeholder={t('template.tagsPlaceholder')}
                      onInput={(e) => setFTags(e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    {t('template.difficulty')}
                    <select value={fDiff()} onChange={(e) => setFDiff(normalizeDifficulty(e.currentTarget.value))}>
                      <For each={DIFFICULTIES}>{(d) => <option value={d}>{difficultyLabel(d)}</option>}</For>
                    </select>
                  </label>
                </div>
                <label>
                  {t('template.code')}
                  <textarea
                    class="tpl-code"
                    spellcheck={false}
                    rows={10}
                    value={fCode()}
                    onInput={(e) => setFCode(e.currentTarget.value)}
                  />
                  <span class="tpl-form-hint">
                    {t('template.codeHint')}
                  </span>
                </label>
                <Show when={fError()}>
                  {(descriptor) => (
                    <ProductMessageView class="tpl-form-error" value={descriptor()} compact role="alert" />
                  )}
                </Show>
              </div>
              <div class="modal-actions">
                <button class="btn" disabled={busy()} onClick={() => void submitForm()}>
                  {busy() ? t('common.saving') : t('common.save')}
                </button>
                <button class="btn" onClick={() => setFormOpen(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            </>
          }
        >
          <h3 id="template-dialog-title">{t('template.library')}</h3>
          <div class="tpl-toolbar">
            <span class="tpl-hint">
              {t('template.counts', { projects: props.templates.length, mine: props.userTemplates.length })}
            </span>
            <input
              type="search"
              value={searchQuery()}
              placeholder={t('template.searchPlaceholder')}
              aria-label={t('template.searchAria')}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />
            <button class="btn mini" onClick={() => openCreate(true)}>
              {t('template.fromCurrent')}
            </button>
            <button class="btn mini" onClick={() => openCreate(false)}>
              {t('template.create')}
            </button>
          </div>
          <div class="tpl-list">
            <Show when={filteredUserTemplates().length > 0}>
              <div class="tpl-group-title">{t('template.mine')}</div>
              <For each={filteredUserTemplates()}>
                {(template) => (
                  <div class="tpl-item custom">
                    <div class="tpl-name">{template.name}</div>
                    <div class="tpl-desc">{template.description || template.tags.join(' · ')}</div>
                    <div class="tpl-actions">
                      <button
                        class="btn mini"
                        disabled={!props.canApplyCode}
                        title={!props.canApplyCode ? props.codeApplyBlockedReason : undefined}
                        onClick={() => {
                          if (props.onPreviewUser(template)) props.onClose();
                        }}
                      >
                        {t('common.preview')}
                      </button>
                      <button class="btn mini" disabled={!props.canApplyCode} title={!props.canApplyCode ? props.codeApplyBlockedReason : undefined} onClick={() => void Promise.resolve(props.onApplyUser(template)).then((ok) => { if (ok) props.onClose(); })}>
                        {t('common.apply')}
                      </button>
                      <button class="btn mini" onClick={() => openEdit(template)}>
                        {t('common.edit')}
                      </button>
                      <button class="btn mini danger" onClick={() => void removeTemplate(template)}>
                        {t('common.delete')}
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
            <div class="tpl-group-title">{t('template.projects')}</div>
            <For each={filteredProjectTemplates()}>
              {(projectTemplate) => {
                const display = () => getBuiltinTemplateDisplay(projectTemplate, locale());
                return (
                  <div class="tpl-item">
                    <div class="tpl-name">{display().name}</div>
                    <div class="tpl-desc">{display().description}</div>
                    <button class="btn" onClick={() => props.onSelect(projectTemplate)}>
                      {t('common.apply')}
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="modal-actions">
            <button class="btn" onClick={() => props.onClose()}>
              {t('common.close')}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default TemplateDialog;
