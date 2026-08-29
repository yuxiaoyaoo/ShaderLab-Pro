import { Show, createMemo, createSignal, onCleanup, type Component } from 'solid-js';
import { t } from '../i18n';
import type { ProductError, ProductMessageDescriptor } from '../productMessage';
import { createProductMessageViewModel } from '../productMessageFormatter';

interface Props {
  value: ProductMessageDescriptor | ProductError | unknown;
  summary?: string;
  class?: string;
  compact?: boolean;
  hideSummary?: boolean;
  role?: 'alert' | 'status';
}

const ProductMessageView: Component<Props> = (props) => {
  const model = createMemo(() => createProductMessageViewModel(props.value, props.summary));
  const [copyState, setCopyState] = createSignal<'idle' | 'copied' | 'failed'>('idle');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => clearTimeout(copyTimer));

  const copyDetail = async (event: MouseEvent) => {
    event.stopPropagation();
    const detail = model().detail?.text;
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopyState('idle'), 1800);
  };

  return (
    <div
      class={`product-message${props.compact ? ' compact' : ''}${props.class ? ` ${props.class}` : ''}`}
      role={props.role}
    >
      <Show when={!props.hideSummary}>
        <div class="product-message-summary">{model().summary}</div>
      </Show>
      <Show when={model().detail}>
        {(detail) => (
          <details class="product-message-details" onClick={(event) => event.stopPropagation()}>
            <summary>{t('product.message.details')}</summary>
            <div class="product-message-meta">
              <span>{t('product.message.code')}</span>
              <code>{model().code}</code>
              <Show when={detail().redacted}><span class="product-message-badge">{t('product.message.redacted')}</span></Show>
              <Show when={detail().truncated}><span class="product-message-badge">{t('product.message.truncated')}</span></Show>
            </div>
            <pre class="product-message-detail">{detail().text}</pre>
            <div class="product-message-actions">
              <button type="button" class="btn mini" onClick={(event) => void copyDetail(event)}>
                {copyState() === 'copied'
                  ? t('product.message.copied')
                  : copyState() === 'failed'
                    ? t('product.message.copyFailed')
                    : t('product.message.copyDetail')}
              </button>
            </div>
          </details>
        )}
      </Show>
    </div>
  );
};

export default ProductMessageView;
