import { For, Show, createSignal, onMount, type Component } from 'solid-js';
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
  const [error, setError] = createSignal('');
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
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
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
    setError('');
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        <h3 id="agent-settings-title">AI 服务设置</h3>
        <Show
          when={view()}
          fallback={<div class="settings-loading" role="status">读取配置中…</div>}
        >
          <div class="field-row">
            <label>服务商</label>
            <select
              class="text-input grow"
              aria-label="服务商"
              value={activePreset()?.id ?? CUSTOM_ID}
              onChange={(e) => pickProvider(e.currentTarget.value)}
            >
              <For each={view()!.presets}>{(p) => <option value={p.id}>{p.label}</option>}</For>
              <option value={CUSTOM_ID}>自定义…</option>
            </select>
          </div>
          <div class="field-row">
            <label>API Key</label>
            <input
              type="password"
              class="text-input grow"
              aria-label="API Key"
              placeholder={
                view()!.api_key_hint
                  ? `已保存 ${view()!.api_key_hint}（留空保持不变）`
                  : activePreset()?.local
                    ? '本地服务可填任意字符，如 ollama'
                    : 'sk-...'
              }
              value={apiKey()}
              onInput={(e) => setApiKey(e.currentTarget.value)}
            />
          </div>
          <Show when={activePreset()?.local}>
            <div class="field-hint">
              本地服务无需真实 Key，任意占位符即可通过校验；确认本地服务已启动并开放对应端口。
            </div>
          </Show>
          <div class="field-row">
            <label>Base URL</label>
            <input
              type="text"
              class="text-input grow"
              aria-label="Base URL"
              placeholder="https://api.openai.com/v1"
              value={baseUrl()}
              onInput={(e) => setBaseUrl(e.currentTarget.value)}
            />
          </div>
          <div class="field-hint">
            兼容 OpenAI Chat Completions 协议的服务均可；切换服务商后手动改 URL 将自动转为自定义。
          </div>
          <div class="field-row">
            <label>模型</label>
            <input
              type="text"
              class="text-input grow"
              aria-label="模型"
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
          <div class="field-hint">可在推荐列表中选择，或直接输入服务端支持的任意模型名。</div>
          <div class="field-row">
            <label>Temperature</label>
            <input
              type="number"
              class="text-input"
              aria-label="Temperature"
              min="0"
              max="2"
              step="0.1"
              value={temperature()}
              onInput={(e) => setTemperature(e.currentTarget.value)}
            />
          </div>
          <div class="field-row">
            <label>Max Tokens</label>
            <input
              type="number"
              class="text-input"
              aria-label="Max Tokens"
              min="256"
              max="32768"
              step="256"
              value={maxTokens()}
              onInput={(e) => setMaxTokens(e.currentTarget.value)}
            />
          </div>
          <Show when={view()!.configured}>
            <div class="settings-status ok" role="status">✓ 服务已配置可用</div>
          </Show>
          <Show when={!view()!.configured}>
            <div class="settings-status" role="status">尚未配置 API Key，AI 功能暂不可用</div>
          </Show>
        </Show>
        <Show when={error()}>
          <div class="settings-status err" role="alert">{error()}</div>
        </Show>
        <div class="modal-actions">
          <button class="btn" onClick={() => props.onClose()}>
            取消
          </button>
          <button class="btn primary" disabled={saving()} onClick={() => void save()}>
            {saving() ? '保存中…' : '保存并生效'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentSettingsDialog;
