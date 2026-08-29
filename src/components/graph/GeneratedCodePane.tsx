import { type Component } from 'solid-js';
import type { ProductMessageDescriptor } from '../../productMessage';
import { formatProductMessage } from '../../productMessageFormatter';
import { t } from '../../i18n';

interface Props {
  source: string;
  stale: boolean;
  onCopy?: () => void;
  canExportFragment?: boolean;
  exportBlockedReason?: ProductMessageDescriptor;
  onExportFragment?: () => void;
  onExportGraph?: () => void;
}
const GeneratedCodePane: Component<Props> = (props) => (
  <div class="generated-code-pane">
    {props.stale && <div class="graph-stale-banner">{t('graph.generated.stale')}</div>}
    <div class="generated-code-head">
      <strong>{t('graph.generated.title')}</strong>
      <button class="btn mini" onClick={props.onCopy}>{t('graph.generated.copy')}</button>
      <button
        class="btn mini"
        disabled={!props.canExportFragment}
        title={props.canExportFragment
          ? t('graph.generated.exportAcceptedTitle')
          : props.exportBlockedReason
            ? formatProductMessage(props.exportBlockedReason)
            : t('graph.generated.exportBlockedTitle')}
        onClick={props.onExportFragment}
      >{t('graph.generated.exportFragment')}</button>
      <button class="btn mini" title={t('graph.generated.backupTitle')} onClick={props.onExportGraph}>{t('graph.generated.backupGraph')}</button>
    </div>
    <textarea readonly spellcheck={false} value={props.source || t('graph.generated.emptySource')} />
  </div>
);
export default GeneratedCodePane;
