import { For, Show, createMemo, type Component } from 'solid-js';
import type { DiagnosticStage, UnifiedDiagnostic } from '../diagnostics/model';
import { t } from '../i18n';
import type { ProductMessageDescriptor } from '../productMessage';
import { formatProductMessageSummary } from '../productMessageFormatter';
import { BUFFER_LETTER, type SrcPassId } from '../project/types';
import ProductMessageView from './ProductMessageView';

export interface MappedDiag extends ProductMessageDescriptor {
  line: number;
  column: number;
  message: string;
  tab: SrcPassId;
  stage: DiagnosticStage;
  severity: UnifiedDiagnostic['severity'];
}

interface Props {
  diagnostics: UnifiedDiagnostic[];
  onJump: (diagnostic: UnifiedDiagnostic) => void;
}

const TAB_ORDER: Record<SrcPassId, number> = {
  image: 0,
  bufferA: 1,
  bufferB: 2,
  bufferC: 3,
  bufferD: 4,
  sound: 8,
  common: 9,
};

const tabLabel = (tab: SrcPassId) => tab === 'common'
  ? 'Common'
  : tab === 'image'
    ? 'Image'
    : tab === 'sound'
      ? 'Sound'
      : `Buffer ${BUFFER_LETTER[tab]}`;

const location = (diagnostic: UnifiedDiagnostic) => diagnostic.origin.kind === 'code'
  ? t('diagnostics.location.line', {
      line: diagnostic.origin.line,
      column: diagnostic.origin.column,
    })
  : diagnostic.origin.nodeId
    ? t('diagnostics.location.node', {
        node: `${diagnostic.origin.nodeId}${diagnostic.origin.socketId ? ` · ${diagnostic.origin.socketId}` : ''}`,
      })
    : diagnostic.origin.parameterId
      ? t('diagnostics.location.parameter', { parameter: diagnostic.origin.parameterId })
      : t('diagnostics.location.graph');

const diagnosticDescriptor = (diagnostic: UnifiedDiagnostic): ProductMessageDescriptor => ({
  code: diagnostic.code ?? 'diagnostic.unstructured',
  ...(diagnostic.params ? { params: diagnostic.params } : {}),
  ...(diagnostic.rawDetail ? { rawDetail: diagnostic.rawDetail } : {}),
  fallback: diagnostic.message,
});

const DiagnosticsPane: Component<Props> = (props) => {
  const sorted = createMemo(() => [...props.diagnostics]
    .sort((a, b) => TAB_ORDER[a.origin.pass] - TAB_ORDER[b.origin.pass]));

  return (
    <div class="diag-pane" aria-label={t('diagnostics.aria')}>
      <div class="diag-header">
        {sorted().length > 0
          ? t('diagnostics.problems', { count: sorted().length })
          : t('diagnostics.title')}
      </div>
      <Show
        when={sorted().length > 0}
        fallback={<div class="diag-empty">{t('diagnostics.empty')}</div>}
      >
        <div class="diag-list">
          <For each={sorted()}>
            {(diagnostic) => {
              const descriptor = () => diagnosticDescriptor(diagnostic);
              return (
                <div class="diag-item">
                  <button class="diag-jump" onClick={() => props.onJump(diagnostic)}>
                    <span class="diag-icon" aria-hidden="true">✕</span>
                    <span class="diag-tab">{tabLabel(diagnostic.origin.pass)}</span>
                    <span class="diag-loc">{location(diagnostic)}</span>
                    <span class="diag-msg">{formatProductMessageSummary(descriptor())}</span>
                  </button>
                  <ProductMessageView value={descriptor()} hideSummary compact />
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default DiagnosticsPane;
