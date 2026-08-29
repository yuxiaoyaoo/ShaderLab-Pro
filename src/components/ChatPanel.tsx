import {
  For,
  Show,
  createEffect,
  createSignal,
  onMount,
  type Component,
} from 'solid-js';
import { t, type TranslationKey, type TranslationParams } from '../i18n';
import { normalizeProductMessage, type ProductMessageDescriptor } from '../productMessage';
import ProductMessageView from './ProductMessageView';
import {
  adoptTemplate,
  fetchPhase,
  resetSession,
  sendChatStream,
  type ErrorFeedbackDto,
  type ProductNoticeDto,
  type ShaderDocDto,
  type TemplateSuggestionDto,
  type ValidationViewDto,
} from '../agent/agentClient';

interface ChatMsg {
  id: number;
  role: 'user' | 'assistant' | 'hint';
  text: string;
  descriptor?: ProductMessageDescriptor;
  notices?: ProductNoticeDto[];
  productTextKey?: TranslationKey;
  productTextParams?: TranslationParams;
  intent?: string;
  parseOk?: boolean;
  suggestions?: TemplateSuggestionDto[];
  doc?: ShaderDocDto;
  feedback?: ErrorFeedbackDto;
  validation?: ValidationViewDto;
  candidateCode?: string;
  candidateName?: string;
  candidateNameKey?: TranslationKey;
  candidateState?: 'ready' | 'previewing' | 'applied' | 'dismissed';
}

interface Props {
  onApplyCode: (fragment: string) => boolean;
  /** 非破坏性预览候选代码，不覆盖用户当前版本。 */
  onPreview: (name: string, code: string) => boolean;
  canApplyCode: boolean;
  codeApplyBlockedReason?: string;
  onCancelPreview: () => void;
  previewActive: boolean;
  appliedCandidateCode: string | null;
  requestConfirm: (options: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  onOpenSettings: () => void;
  onClose: () => void;
}

const PHASE_HINT_KEYS: Record<string, TranslationKey> = {
  planning: 'chat.phase.planning',
  coding: 'chat.phase.coding',
  testing: 'chat.phase.testing',
  documentation: 'chat.phase.documentation',
};

const PHASE_NAME_KEYS: Record<string, TranslationKey> = {
  planning: 'chat.phaseName.planning',
  coding: 'chat.phaseName.coding',
  testing: 'chat.phaseName.testing',
  documentation: 'chat.phaseName.documentation',
};

const INTENT_KEYS: Record<string, TranslationKey> = {
  clarify: 'chat.intent.clarify',
  suggest: 'chat.intent.suggest',
  generate: 'chat.intent.generate',
  report_error: 'chat.intent.reportError',
  document: 'chat.intent.document',
  complete: 'chat.intent.complete',
};

const FEEDBACK_PHASE_KEYS: Record<string, TranslationKey> = {
  compile: 'chat.feedback.compile',
  render: 'chat.feedback.render',
};

let nextId = 1;

const feedbackMessage = (message: ChatMsg): string => {
  const value = message.feedback?.message.trim() ?? '';
  if (!value) return '';
  const duplicatedByValidation = message.validation?.errors.some(
    (error) => error.message.trim() === value,
  );
  return duplicatedByValidation ? '' : message.feedback!.message;
};

const showFeedback = (message: ChatMsg): boolean =>
  Boolean(message.feedback && (feedbackMessage(message) || message.feedback.suggestion.trim()));

const IntentBadge: Component<{ intent?: string }> = (props) => (
  <Show when={props.intent}>
    <span class={`chat-intent intent-${props.intent}`}>
      {INTENT_KEYS[props.intent!] ? t(INTENT_KEYS[props.intent!]) : props.intent}
    </span>
  </Show>
);

const VALIDATION_META: Record<string, { icon: string; labelKey: TranslationKey }> = {
  passed: { icon: '✓', labelKey: 'chat.validation.passed' },
  failed: { icon: '⚠', labelKey: 'chat.validation.failed' },
  skipped: { icon: '⊘', labelKey: 'chat.validation.skipped' },
};

const ValidationBadge: Component<{ v?: ValidationViewDto }> = (props) => {
  const meta = () => (props.v ? VALIDATION_META[props.v.status] : undefined);
  const statusLabel = () => meta() ? t(meta()!.labelKey) : '';
  const label = () =>
    props.v?.render?.success ? t('chat.validation.renderPassed') : statusLabel();
  const title = () => {
    if (!props.v) return undefined;
    if (props.v.status === 'skipped') return t('chat.validation.validatorUnavailable');
    if (props.v.render && !props.v.render.success && !props.v.render.unavailable_reason)
      return props.v.note ?? t('chat.validation.renderFailed');
    if (props.v.fix_attempts > 0) {
      return t('chat.validation.afterFixes', {
        attempts: props.v.fix_attempts,
        status: statusLabel(),
      });
    }
    return undefined;
  };
  return (
    <Show when={meta()}>
      <span
        class={`chat-validation val-${props.v!.status}`}
        title={title()}
      >
        {meta()!.icon} {label()}
        <Show when={props.v!.fix_attempts > 0 && props.v!.status !== 'skipped'}>
          <span class="val-attempts">
            {t('chat.validation.fixAttempts', { attempts: props.v!.fix_attempts })}
          </span>
        </Show>
      </span>
    </Show>
  );
};

const ValidationErrors: Component<{ v?: ValidationViewDto }> = (props) => {
  const shown = () => props.v?.errors.slice(0, 3) ?? [];
  return (
    <Show when={props.v && props.v.errors.length > 0}>
      <div class="chat-validation-errors">
        <For each={shown()}>
          {(e) => (
            <div class="verr-line">
              <span class="verr-loc">
                {e.line > 0 ? t('chat.validation.errorLine', { line: e.line }) : t('chat.validation.wrapper')}
              </span>
              <span class="verr-msg">{e.message}</span>
            </div>
          )}
        </For>
        <Show when={props.v!.errors.length > 3}>
          <div class="verr-more">
            {t('chat.validation.moreErrors', { count: props.v!.errors.length })}
          </div>
        </Show>
      </div>
    </Show>
  );
};

/** M2：首帧渲染预览——有缩略图展示图+统计；无 GPU 时弱化提示；纯渲染失败不重复展示 */
const RenderPreview: Component<{ v?: ValidationViewDto }> = (props) => {
  const r = () => props.v?.render;
  return (
    <Show
      when={r() && (r()!.thumbnail_base64 || r()!.unavailable_reason)}
    >
      <Show
        when={r()!.thumbnail_base64}
        fallback={
          <div class="render-unavailable">
            {t('chat.render.skipped')}
          </div>
        }
      >
        <div class="chat-render">
          <img
            class="chat-thumb"
            src={r()!.thumbnail_base64!}
            alt={t('chat.render.alt')}
          />
          <div class="render-stats">
            {t('chat.render.stats', {
              brightness: (r()!.avg_brightness * 100).toFixed(0),
              coverage: (r()!.coverage * 100).toFixed(0),
              time: r()!.render_time_ms.toFixed(1),
            })}
          </div>
        </div>
      </Show>
    </Show>
  );
};

const ChatPanel: Component<Props> = (props) => {
  const [msgs, setMsgs] = createSignal<ChatMsg[]>([
    {
      id: nextId++,
      role: 'hint',
      text: '',
      productTextKey: 'chat.initialHint',
    },
  ]);
  const [input, setInput] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [phaseId, setPhaseId] = createSignal('planning');
  const [phaseName, setPhaseName] = createSignal('');
  /** M5：进行中回合的 LLM 增量直播文本；完成后清空并由富结构整包替换 */
  const [streamText, setStreamText] = createSignal('');
  const [activePreviewId, setActivePreviewId] = createSignal<number | null>(null);

  let listRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;

  const scrollBottom = () => {
    setTimeout(() => {
      listRef?.scrollTo({ top: listRef.scrollHeight });
    }, 30);
  };

  const pushMsg = (m: Omit<ChatMsg, 'id'>) => {
    setMsgs((prev) => [...prev, { ...m, id: nextId++ }]);
    scrollBottom();
  };

  onMount(() => {
    void fetchPhase()
      .then((p) => {
        setPhaseId(p.id);
        setPhaseName(p.name);
      })
      .catch(() => {});
  });

  const send = async (raw?: string) => {
    const content = (raw ?? input()).trim();
    if (!content || busy()) return;
    setInput('');
    setBusy(true);
    setStreamText('');
    pushMsg({ role: 'user', text: content });
    try {
      // M5：走流式命令——增量经 Channel 实时回填打字气泡；Reset 事件清空重来。
      // 最终返回完整 ChatResponse，与原 chat 一致地落入富结构气泡。
      const r = await sendChatStream(content, (ev) => {
        if (ev.type === 'reset') {
          setStreamText('');
        } else {
          setStreamText((prev) => prev + ev.text);
          scrollBottom();
        }
      });
      setPhaseId(r.phase_id);
      setPhaseName(r.phase);
      const candidate = r.code_fragment?.trim() || undefined;
      pushMsg({
        role: 'assistant',
        text: r.text,
        notices: r.notices,
        intent: r.intent,
        parseOk: r.parse_ok,
        suggestions: r.suggestions.length ? r.suggestions : undefined,
        doc: r.documentation,
        feedback: r.error_feedback,
        validation: r.validation,
        candidateCode: candidate,
        candidateNameKey: candidate ? 'chat.candidate.generatedName' : undefined,
        candidateState: candidate ? 'ready' : undefined,
      });
    } catch (e) {
      pushMsg({
        role: 'assistant',
        text: '',
        descriptor: normalizeProductMessage(e, 'chat.request-failed'),
        intent: 'report_error',
      });
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    if (!await props.requestConfirm({
      title: t('chat.resetTitle'),
      message: t('chat.resetMessage'),
      confirmLabel: t('chat.resetConfirm'),
      danger: true,
    })) return;
    void resetSession()
      .then(() => fetchPhase())
      .then((p) => {
        setPhaseId(p.id);
        setPhaseName(p.name);
        setMsgs([
          {
            id: nextId++,
            role: 'hint',
            text: '',
            productTextKey: 'chat.resetDone',
          },
        ]);
      })
      .catch((e) =>
        pushMsg({
          role: 'assistant',
          text: '',
          descriptor: normalizeProductMessage(e, 'chat.state-unavailable'),
          intent: 'report_error',
        }),
      );
  };

  /** M3：确定性选型——直接调 select_template 桥接命令，跳过 LLM 轮次 */
  const useSuggestion = (s: TemplateSuggestionDto) => {
    if (busy()) return;
    setBusy(true);
    pushMsg({
      role: 'user',
      text: '',
      productTextKey: 'chat.action.useSuggestion',
      productTextParams: { name: s.name },
    });
    adoptTemplate(s.name)
      .then((r) => {
        setPhaseId(r.phase_id);
        setPhaseName(r.phase);
        const candidate = r.has_code ? r.code_fragment?.trim() : undefined;
        pushMsg({
          role: 'assistant',
          text: r.text,
          notices: r.notices,
          intent: r.intent,
          suggestions: undefined,
          candidateCode: candidate || undefined,
          candidateName: candidate ? s.name : undefined,
          candidateState: candidate ? 'ready' : undefined,
        });
      })
      .catch((e: unknown) => {
        pushMsg({
          role: 'assistant',
          text: '',
          descriptor: normalizeProductMessage(e, 'chat.template-adopt-failed'),
          intent: 'report_error',
        });
      })
      .finally(() => setBusy(false));
  };

  const previewSuggestion = (s: TemplateSuggestionDto) => {
    if (!s.code.trim()) return;
    if (!props.onPreview(s.name, s.code)) return;
    clearPreviewMarkers();
    setActivePreviewId(null);
  };

  const setCandidateState = (id: number, state: ChatMsg['candidateState']) => {
    setMsgs((items) => items.map((item) => item.id === id ? { ...item, candidateState: state } : item));
  };

  createEffect(() => {
    const previewActive = props.previewActive;
    const appliedCode = props.appliedCandidateCode;
    setMsgs((items) => items.map((item) => {
      if (item.candidateState === 'previewing' && !previewActive) {
        return { ...item, candidateState: 'ready' };
      }
      if (item.candidateState === 'applied' && item.candidateCode !== appliedCode) {
        return { ...item, candidateState: 'ready' };
      }
      return item;
    }));
    if (!previewActive) setActivePreviewId(null);
  });

  const clearPreviewMarkers = (exceptId?: number) => {
    setMsgs((items) => items.map((item) =>
      item.candidateState === 'previewing' && item.id !== exceptId
        ? { ...item, candidateState: 'ready' }
        : item,
    ));
  };

  const candidateName = (
    m: ChatMsg,
    fallbackKey: TranslationKey,
  ) => m.candidateName ?? (m.candidateNameKey ? t(m.candidateNameKey) : t(fallbackKey));

  const previewCandidate = (m: ChatMsg) => {
    if (!m.candidateCode) return;
    if (!props.onPreview(candidateName(m, 'chat.candidate.previewName'), m.candidateCode)) return;
    clearPreviewMarkers(m.id);
    setActivePreviewId(m.id);
    setCandidateState(m.id, 'previewing');
  };

  const applyCandidate = (m: ChatMsg) => {
    if (!m.candidateCode) return;
    if (!props.onApplyCode(m.candidateCode)) return;
    clearPreviewMarkers();
    setActivePreviewId(null);
    setCandidateState(m.id, 'applied');
  };

  const dismissCandidate = (m: ChatMsg) => {
    if (activePreviewId() === m.id) {
      props.onCancelPreview();
      setActivePreviewId(null);
    }
    setCandidateState(m.id, 'dismissed');
  };

  const copyCandidate = async (m: ChatMsg) => {
    if (!m.candidateCode) return;
    try {
      await navigator.clipboard.writeText(m.candidateCode);
      setCandidateState(m.id, m.candidateState ?? 'ready');
    } catch {
      // 剪贴板不可用时不改变候选状态，用户仍可继续预览或应用。
    }
  };

  return (
    <aside class="chat-panel" aria-label={t('chat.title')}>
      <div class="chat-head">
        <span class="chat-title">
          <svg class="chat-title-icon" viewBox="0 0 24 24" aria-hidden="true">
            <defs>
              <linearGradient id="chat-ai-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#8b7bff" />
                <stop offset="1" stop-color="#4f7dff" />
              </linearGradient>
            </defs>
            <rect x="1" y="1" width="22" height="22" rx="7" fill="url(#chat-ai-grad)" />
            <path d="M12 5.5l1.6 4.4 4.4 1.6-4.4 1.6L12 17.5l-1.6-4.4L6 11.5l4.4-1.6L12 5.5z" fill="#fff" />
            <path d="M17.6 14.9l0.8 2 2 0.8-2 0.8-0.8 2-0.8-2-2-0.8 2-0.8 0.8-2z" fill="#fff" opacity="0.85" />
          </svg>
          {t('chat.title')}
        </span>
        <span class={`chat-phase-badge phase-${phaseId()}`}>{PHASE_NAME_KEYS[phaseId()] ? t(PHASE_NAME_KEYS[phaseId()]) : phaseName()}</span>
        <span class="spacer" />
        <button class="btn mini" onClick={props.onOpenSettings} title={t('chat.settingsTitle')}>
          {t('chat.settings')}
        </button>
        <button class="btn mini" onClick={() => void doReset()} title={t('chat.newSessionTitle')}>
          {t('chat.newSession')}
        </button>
        <button
          class="btn mini chat-close"
          onClick={props.onClose}
          title={t('chat.close')}
          aria-label={t('chat.close')}
        >
          ×
        </button>
      </div>
      <div class="chat-hint">{props.canApplyCode ? (PHASE_HINT_KEYS[phaseId()] ? t(PHASE_HINT_KEYS[phaseId()]) : '') : (props.codeApplyBlockedReason ?? t('chat.graphBlocked'))}</div>
      <div class="chat-msgs" ref={listRef} aria-live="polite" aria-busy={busy()}>
        <For each={msgs()}>
          {(m) => (
            <div class={`chat-msg ${m.role}`}>
              <div class="msg-bubble">
                <Show when={m.role === 'assistant'}>
                  <div class="msg-meta">
                    <IntentBadge intent={m.intent} />
                    <Show when={m.parseOk === false}>
                      <span class="chat-intent warn">{t('chat.parse.unparsed')}</span>
                    </Show>
                    <ValidationBadge v={m.validation} />
                  </div>
                </Show>
                <Show when={m.productTextKey || (m.text.trim() && !(m.intent === 'report_error' && m.feedback))}>
                  <div class="msg-text">
                    {m.productTextKey ? t(m.productTextKey, m.productTextParams) : m.text}
                  </div>
                </Show>
                <Show when={m.descriptor}>
                  {(descriptor) => <ProductMessageView class="msg-text" value={descriptor()} compact />}
                </Show>
                <For each={m.notices ?? []}>
                  {(notice) => <ProductMessageView class="msg-text" value={notice} compact />}
                </For>
                <Show when={m.candidateCode}>
                  <div class={`chat-candidate state-${m.candidateState ?? 'ready'}`}>
                    <div class="candidate-head">
                      <span>
                        {t('chat.candidate', {
                          name: candidateName(m, 'chat.candidate.defaultName'),
                          lines: m.candidateCode!.split('\n').length,
                        })}
                      </span>
                      <Show when={m.candidateState === 'applied'}>
                        <span class="candidate-state">{t('chat.applied')}</span>
                      </Show>
                      <Show when={m.candidateState === 'dismissed'}>
                        <span class="candidate-state">{t('chat.dismissed')}</span>
                      </Show>
                    </div>
                    <Show when={m.candidateState !== 'applied' && m.candidateState !== 'dismissed'}>
                      <div class="candidate-actions">
                        <button class="btn mini" disabled={!props.canApplyCode} title={!props.canApplyCode ? props.codeApplyBlockedReason : undefined} onClick={() => previewCandidate(m)}>
                          {m.candidateState === 'previewing' ? t('chat.refreshPreview') : t('chat.tempPreview')}
                        </button>
                        <button class="btn mini" onClick={() => void copyCandidate(m)}>{t('chat.copyCode')}</button>
                        <button class="btn mini" onClick={() => dismissCandidate(m)}>{t('chat.dismiss')}</button>
                        <button class="btn mini primary" disabled={!props.canApplyCode} title={!props.canApplyCode ? props.codeApplyBlockedReason : undefined} onClick={() => applyCandidate(m)}>{t('chat.applyImage')}</button>
                      </div>
                    </Show>
                  </div>
                </Show>
                <ValidationErrors v={m.validation} />
                <RenderPreview v={m.validation} />

                <Show when={m.suggestions?.length}>
                  <div class="chat-suggest-list">
                    <For each={m.suggestions!}>
                      {(s) => (
                        <div class="chat-suggest-item">
                          <div class="suggest-name">{s.name}</div>
                          <div class="suggest-desc">{s.description}</div>
                          <div class="suggest-actions">
                            <Show when={s.code.trim()}>
                              <button class="btn mini" disabled={!props.canApplyCode} title={!props.canApplyCode ? props.codeApplyBlockedReason : undefined} onClick={() => previewSuggestion(s)}>
                                {t('chat.seeEffect')}
                              </button>
                            </Show>
                            <button class="btn mini primary" onClick={() => useSuggestion(s)}>
                              {t('chat.useThis')}
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={showFeedback(m)}>
                  <div class="chat-feedback">
                    <div class="fb-line">
                      <span class="fb-phase">
                        {FEEDBACK_PHASE_KEYS[m.feedback!.phase]
                          ? t(FEEDBACK_PHASE_KEYS[m.feedback!.phase])
                          : (m.feedback!.phase || t('chat.feedback.compile'))}
                      </span>
                      {feedbackMessage(m)}
                    </div>
                    <Show when={m.feedback!.suggestion}>
                      <div class="fb-suggestion">💡 {m.feedback!.suggestion}</div>
                    </Show>
                  </div>
                </Show>

                <Show when={m.doc}>
                  <details class="chat-doc">
                    <summary>{t('chat.algorithm')}</summary>
                    <p>{m.doc!.algorithm_explanation}</p>
                    <Show when={m.doc!.inline_comments.trim().length > 0}>
                      <pre class="doc-comments">{m.doc!.inline_comments}</pre>
                    </Show>
                    <Show when={m.doc!.parameters.length > 0}>
                      <table class="doc-params">
                        <thead>
                          <tr>
                            <th>{t('chat.parameter')}</th>
                            <th>{t('chat.range')}</th>
                            <th>{t('chat.effect')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={m.doc!.parameters}>
                            {(p) => (
                              <tr>
                                <td>{p.name}</td>
                                <td>{p.range}</td>
                                <td>{p.effect}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </Show>
                    <Show when={m.doc!.performance_notes}>
                      <p class="doc-perf">⚡ {m.doc!.performance_notes}</p>
                    </Show>
                  </details>
                </Show>
              </div>
            </div>
          )}
        </For>
        <Show when={busy()}>
          <div class="chat-msg assistant">
            <Show
              when={streamText()}
              fallback={
                <div class="msg-bubble typing">{t('chat.thinking')}</div>
              }
            >
              <div class="msg-bubble msg-text stream-cursor">{streamText()}</div>
            </Show>
          </div>
        </Show>
      </div>
      <div class="chat-input-row">
        <textarea
          ref={inputRef}
          class="chat-input"
          rows="2"
          placeholder={t('chat.placeholder')}
          value={input()}
          disabled={busy()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          class="btn primary chat-send"
          disabled={busy() || !input().trim()}
          onClick={() => void send()}
        >
          {t('chat.send')}
        </button>
      </div>
    </aside>
  );
};

export default ChatPanel;
