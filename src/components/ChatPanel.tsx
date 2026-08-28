import {
  For,
  Show,
  createEffect,
  createSignal,
  onMount,
  type Component,
} from 'solid-js';
import {
  adoptTemplate,
  fetchPhase,
  resetSession,
  sendChatStream,
  type ErrorFeedbackDto,
  type ShaderDocDto,
  type TemplateSuggestionDto,
  type ValidationViewDto,
} from '../agent/agentClient';

interface ChatMsg {
  id: number;
  role: 'user' | 'assistant' | 'hint';
  text: string;
  intent?: string;
  parseOk?: boolean;
  suggestions?: TemplateSuggestionDto[];
  doc?: ShaderDocDto;
  feedback?: ErrorFeedbackDto;
  validation?: ValidationViewDto;
  candidateCode?: string;
  candidateName?: string;
  candidateState?: 'ready' | 'previewing' | 'applied' | 'dismissed';
}

interface Props {
  onApplyCode: (fragment: string) => void;
  /** 非破坏性预览候选代码，不覆盖用户当前版本。 */
  onPreview: (name: string, code: string) => void;
  onCancelPreview: () => void;
  previewActive: boolean;
  appliedCandidateCode: string | null;
  onOpenSettings: () => void;
  onClose: () => void;
}

const PHASE_HINTS: Record<string, string> = {
  planning: '需求澄清中 —— 描述你想要的效果，或回答 AI 的追问',
  coding: '代码已推送，可在预览中查看效果并提出调整',
  testing: '反馈编译或渲染问题，AI 会修复；没问题就说“完成”',
  documentation: '文档阶段 —— 可要求算法说明，或直接开始新需求',
};

let nextId = 1;

const IntentBadge: Component<{ intent?: string }> = (props) => (
  <Show when={props.intent}>
    <span class={`chat-intent intent-${props.intent}`}>
      {{ clarify: '澄清', suggest: '建议', generate: '生成', report_error: '纠错', document: '文档', complete: '完成' }[props.intent!] ?? props.intent}
    </span>
  </Show>
);

const VALIDATION_META: Record<string, { icon: string; label: string; title?: string }> = {
  passed: { icon: '✓', label: '编译通过' },
  failed: { icon: '⚠', label: '编译未通过' },
  skipped: { icon: '⊘', label: '已跳过验证' },
};

const ValidationBadge: Component<{ v?: ValidationViewDto }> = (props) => {
  const meta = () => (props.v ? VALIDATION_META[props.v.status] : undefined);
  const label = () =>
    props.v?.render?.success ? '编译+渲染通过' : meta()?.label;
  const title = () => {
    if (!props.v) return undefined;
    if (props.v.status === 'skipped') return props.v.note ?? '未检测到 glslangValidator';
    if (props.v.render && !props.v.render.success && !props.v.render.unavailable_reason)
      return props.v.note ?? '渲染验证未通过';
    if (props.v.fix_attempts > 0) return `自动修复 ${props.v.fix_attempts} 次后${VALIDATION_META[props.v.status]?.label ?? ''}`;
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
          <span class="val-attempts"> · 修复 {props.v!.fix_attempts} 次</span>
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
              <span class="verr-loc">{e.line > 0 ? `第 ${e.line} 行` : '包装层'}</span>
              <span class="verr-msg">{e.message}</span>
            </div>
          )}
        </For>
        <Show when={props.v!.errors.length > 3}>
          <div class="verr-more">…等共 {props.v!.errors.length} 条错误</div>
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
            ℹ️ 已跳过渲染预览：{r()!.unavailable_reason}
          </div>
        }
      >
        <div class="chat-render">
          <img
            class="chat-thumb"
            src={r()!.thumbnail_base64!}
            alt="首帧渲染预览"
          />
          <div class="render-stats">
            首帧 · 亮度 {(r()!.avg_brightness * 100).toFixed(0)}% · 有效像素 {(r()!.coverage * 100).toFixed(0)}% · {r()!.render_time_ms.toFixed(1)} ms
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
      text: '描述你想要的 shader 效果（例：「做一个蓝色流动水波纹背景」），AI 会先确认需求再生成代码。',
    },
  ]);
  const [input, setInput] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [phaseId, setPhaseId] = createSignal('planning');
  const [phaseName, setPhaseName] = createSignal('规划');
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
        intent: r.intent,
        parseOk: r.parse_ok,
        suggestions: r.suggestions.length ? r.suggestions : undefined,
        doc: r.documentation,
        feedback: r.error_feedback,
        validation: r.validation,
        candidateCode: candidate,
        candidateName: candidate ? 'AI 生成方案' : undefined,
        candidateState: candidate ? 'ready' : undefined,
      });
    } catch (e) {
      pushMsg({
        role: 'assistant',
        text: e instanceof Error ? e.message : String(e),
        intent: 'report_error',
      });
    } finally {
      setBusy(false);
    }
  };

  const doReset = () => {
    if (!window.confirm('清空当前 AI 会话？阶段与上下文将重置。')) return;
    void resetSession()
      .then(() => fetchPhase())
      .then((p) => {
        setPhaseId(p.id);
        setPhaseName(p.name);
        setMsgs([
          {
            id: nextId++,
            role: 'hint',
            text: '会话已重置。描述一个新效果开始吧！',
          },
        ]);
      })
      .catch((e) =>
        pushMsg({ role: 'assistant', text: e instanceof Error ? e.message : String(e), intent: 'report_error' }),
      );
  };

  /** M3：确定性选型——直接调 select_template 桥接命令，跳过 LLM 轮次 */
  const useSuggestion = (s: TemplateSuggestionDto) => {
    if (busy()) return;
    setBusy(true);
    pushMsg({ role: 'user', text: `用此方案：「${s.name}」` });
    adoptTemplate(s.name)
      .then((r) => {
        setPhaseId(r.phase_id);
        setPhaseName(r.phase);
        const candidate = r.has_code ? r.code_fragment?.trim() : undefined;
        pushMsg({
          role: 'assistant',
          text: r.text,
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
          text: e instanceof Error ? e.message : String(e),
          intent: 'report_error',
        });
      })
      .finally(() => setBusy(false));
  };

  const previewSuggestion = (s: TemplateSuggestionDto) => {
    if (!s.code.trim()) return;
    clearPreviewMarkers();
    setActivePreviewId(null);
    props.onPreview(s.name, s.code);
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

  const previewCandidate = (m: ChatMsg) => {
    if (!m.candidateCode) return;
    clearPreviewMarkers(m.id);
    props.onPreview(m.candidateName ?? 'AI 候选方案', m.candidateCode);
    setActivePreviewId(m.id);
    setCandidateState(m.id, 'previewing');
  };

  const applyCandidate = (m: ChatMsg) => {
    if (!m.candidateCode) return;
    clearPreviewMarkers();
    props.onApplyCode(m.candidateCode);
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
    <aside class="chat-panel" aria-label="AI 助手">
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
          AI 助手
        </span>
        <span class={`chat-phase-badge phase-${phaseId()}`}>{phaseName()}</span>
        <span class="spacer" />
        <button class="btn mini" onClick={props.onOpenSettings} title="AI 服务设置">
          ⚙ 设置
        </button>
        <button class="btn mini" onClick={doReset} title="清空会话并回到规划阶段">
          ⟲ 新会话
        </button>
        <button
          class="btn mini chat-close"
          onClick={props.onClose}
          title="关闭 AI 助手"
          aria-label="关闭 AI 助手"
        >
          ×
        </button>
      </div>
      <div class="chat-hint">{PHASE_HINTS[phaseId()] ?? ''}</div>
      <div class="chat-msgs" ref={listRef} aria-live="polite" aria-busy={busy()}>
        <For each={msgs()}>
          {(m) => (
            <div class={`chat-msg ${m.role}`}>
              <div class="msg-bubble">
                <Show when={m.role === 'assistant'}>
                  <div class="msg-meta">
                    <IntentBadge intent={m.intent} />
                    <Show when={m.parseOk === false}>
                      <span class="chat-intent warn">未解析</span>
                    </Show>
                    <ValidationBadge v={m.validation} />
                  </div>
                </Show>
                <div class="msg-text">{m.text}</div>
                <Show when={m.candidateCode}>
                  <div class={`chat-candidate state-${m.candidateState ?? 'ready'}`}>
                    <div class="candidate-head">
                      <span>
                        候选代码 · {m.candidateName ?? 'AI 方案'} · {m.candidateCode!.split('\n').length} 行
                      </span>
                      <Show when={m.candidateState === 'applied'}>
                        <span class="candidate-state">✓ 已应用</span>
                      </Show>
                      <Show when={m.candidateState === 'dismissed'}>
                        <span class="candidate-state">已放弃</span>
                      </Show>
                    </div>
                    <Show when={m.candidateState !== 'applied' && m.candidateState !== 'dismissed'}>
                      <div class="candidate-actions">
                        <button class="btn mini" onClick={() => previewCandidate(m)}>
                          {m.candidateState === 'previewing' ? '刷新预览' : '临时预览'}
                        </button>
                        <button class="btn mini" onClick={() => void copyCandidate(m)}>复制代码</button>
                        <button class="btn mini" onClick={() => dismissCandidate(m)}>放弃</button>
                        <button class="btn mini primary" onClick={() => applyCandidate(m)}>应用到 Image</button>
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
                              <button class="btn mini" onClick={() => previewSuggestion(s)}>
                                先看效果
                              </button>
                            </Show>
                            <button class="btn mini primary" onClick={() => useSuggestion(s)}>
                              用此方案
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={m.feedback}>
                  <div class="chat-feedback">
                    <div class="fb-line">
                      <span class="fb-phase">{m.feedback!.phase || 'compile'}</span>
                      {m.feedback!.message}
                    </div>
                    <Show when={m.feedback!.suggestion}>
                      <div class="fb-suggestion">💡 {m.feedback!.suggestion}</div>
                    </Show>
                  </div>
                </Show>

                <Show when={m.doc}>
                  <details class="chat-doc">
                    <summary>📄 算法说明</summary>
                    <p>{m.doc!.algorithm_explanation}</p>
                    <Show when={m.doc!.inline_comments.trim().length > 0}>
                      <pre class="doc-comments">{m.doc!.inline_comments}</pre>
                    </Show>
                    <Show when={m.doc!.parameters.length > 0}>
                      <table class="doc-params">
                        <thead>
                          <tr>
                            <th>参数</th>
                            <th>范围</th>
                            <th>作用</th>
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
                <div class="msg-bubble typing">思考中…</div>
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
          placeholder="描述效果或提出修改…（Enter 发送 / Shift+Enter 换行）"
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
          发送
        </button>
      </div>
    </aside>
  );
};

export default ChatPanel;
