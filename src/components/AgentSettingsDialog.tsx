import { For, Show, createSignal, onMount, type Component } from 'solid-js';
import { t } from '../i18n';
import { normalizeProductMessage, type ProductMessageDescriptor } from '../productMessage';
import ProductMessageView from './ProductMessageView';
import { useModalFocus } from './modalFocus';
import {
  fetchAgentConfig,
  saveAgentConfig,
  type AgentConfigViewDto,
} from '../agent/agentClient';

interface Props {
  onClose: () => void;
  onSaved: (view: AgentConfigViewDto) => void;
}

const CUSTOM_ID = 'custom';

/** M6d：URL 归一化（去首尾空白与末尾斜杠），用于服务商反查匹配 */
const normUrl = (u: string) => u.trim().replace(/\/+$/, '');

const AgentSettingsDialog: Component<Props> = (props) => {
  const [view, setView] = createSignal<AgentConfigViewDto | null>(null);
  const [apiKey, setApiKey] = createSignal('');
  const [baseUrl, setBaseUrl] = createSignal('');
  const [model, setModel] = createSignal('');
  const [temperature, setTemperature] = createSignal('0.7');
  const [maxTokens, setMaxTokens] = createSignal('4096');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<ProductMessageDescriptor | null>(null);
  let dialogRef: HTMLDivElement | undefined;
  useModalFocus(() => dialogRef);

  onMount(() => {
    void fetchAgentConfig()
      .then((v) => {
        setView(v);
        setBaseUrl(v.base_url);
        setModel(v.model);
        setTemperature(String(v.temperature));
        setMaxTokens(String(v.max_tokens));
      })
      .catch((error) => setError(normalizeProductMessage(error, 'chat.state-unavailable')));
  });

  /** M6d：服务商选中态由 base_url 派生——手动改 URL 会自动回显为对应预设/自定义，无需双向同步 */
  const activePreset = () => {
    const cur = normUrl(baseUrl());
    return view()?.presets.find((p) => normUrl(p.base_url) === cur) ?? null;
  };

  const pickProvider = (id: string) => {
    if (!view() || id === CUSTOM_ID) return;
    const p = view()!.presets.find((x) => x.id === id);
    if (!p) return;
    setBaseUrl(p.base_url);
    setModel(p.models[0] ?? '');
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const args: Record<string, unknown> = {
        base_url: baseUrl(),
        model: model(),
        temperature: parseFloat(temperature()) || 0.7,
        max_tokens: parseInt(maxTokens(), 10) || 4096,
      };
      if (apiKey().trim()) args.api_key = apiKey().trim();
      const updated = await saveAgentConfig(args);
      props.onSaved(updated);
    } catch (error) {
      setError(normalizeProductMessage(error, 'chat.config-save-failed'));
    } finally {
      setSaving(false);
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
        class="modal agent-settings"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
        tabindex="-1"
      >
        <h3 id="agent-settings-title">{t('agent.title')}</h3>
        <Show
          when={view()}
          fallback={<div class="settings-loading" role="status">{t('agent.loading')}</div>}
        >
          <div class="field-row">
            <label>{t('agent.provider')}</label>
            <select
              class="text-input grow"
              aria-label={t('agent.provider')}
              value={activePreset()?.id ?? CUSTOM_ID}
              onChange={(e) => pickProvider(e.currentTarget.value)}
            >
              <For each={view()!.presets}>{(p) => <option value={p.id}>{p.label}</option>}</For>
              <option value={CUSTOM_ID}>{t('agent.custom')}</option>
            </select>
          </div>
          <div class="field-row">
            <label>{t('agent.apiKey')}</label>
            <input
              type="password"
              class="text-input grow"
              aria-label={t('agent.apiKey')}
              placeholder={
                view()!.api_key_hint
                  ? t('agent.savedKey', { hint: view()!.api_key_hint ?? '' })
                  : activePreset()?.local
                    ? t('agent.localKey')
                    : 'sk-...'
              }
              value={apiKey()}
              onInput={(e) => setApiKey(e.currentTarget.value)}
            />
          </div>
          <Show when={activePreset()?.local}>
            <div class="field-hint">
              {t('agent.localHint')}
            </div>
          </Show>
          <div class="field-row">
            <label>{t('agent.baseUrl')}</label>
            <input
              type="text"
              class="text-input grow"
              aria-label={t('agent.baseUrl')}
              placeholder="https://api.openai.com/v1"
              value={baseUrl()}
              onInput={(e) => setBaseUrl(e.currentTarget.value)}
            />
          </div>
          <div class="field-hint">
            {t('agent.baseUrlHint')}
          </div>
          <div class="field-row">
            <label>{t('agent.model')}</label>
            <input
              type="text"
              class="text-input grow"
              aria-label={t('agent.model')}
              list="provider-model-suggestions"
              placeholder="gpt-4o-mini"
              value={model()}
              onInput={(e) => setModel(e.currentTarget.value)}
            />
            <datalist id="provider-model-suggestions">
              <For each={activePreset()?.models ?? []}>
                {(m) => <option value={m} />}
              </For>
            </datalist>
          </div>
          <div class="field-hint">{t('agent.modelHint')}</div>
          <div class="field-row">
            <label>{t('agent.temperature')}</label>
            <input
              type="number"
              class="text-input"
              aria-label={t('agent.temperature')}
              min="0"
              max="2"
              step="0.1"
              value={temperature()}
              onInput={(e) => setTemperature(e.currentTarget.value)}
            />
          </div>
          <div class="field-row">
            <label>{t('agent.maxTokens')}</label>
            <input
              type="number"
              class="text-input"
              aria-label={t('agent.maxTokens')}
              min="256"
              max="32768"
              step="256"
              value={maxTokens()}
              onInput={(e) => setMaxTokens(e.currentTarget.value)}
            />
          </div>
          <Show when={view()!.configured}>
            <div class="settings-status ok" role="status">{t('agent.configured')}</div>
          </Show>
          <Show when={!view()!.configured}>
            <div class="settings-status" role="status">{t('agent.unconfigured')}</div>
          </Show>
        </Show>
        <Show when={error()}>
          {(descriptor) => (
            <ProductMessageView class="settings-status err" value={descriptor()} compact role="alert" />
          )}
        </Show>
        <div class="modal-actions">
          <button class="btn" onClick={() => props.onClose()}>
            {t('common.cancel')}
          </button>
          <button class="btn primary" disabled={saving()} onClick={() => void save()}>
            {saving() ? t('common.saving') : t('agent.save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentSettingsDialog;
