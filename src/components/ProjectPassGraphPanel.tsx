import { For, Show, type Component } from 'solid-js';
import type { UnifiedDiagnostic } from '../diagnostics/model';
import type { GraphDocument, GraphPassId, VisualGraphPassId } from '../graph/model';
import ProductMessageView from './ProductMessageView';
import { t } from '../i18n';
import { BUFFER_IDS, type ShaderlabProject } from '../project/types';
import {
  endpointChangedForTarget,
  endpointSelectionForTarget,
  retargetPassGraphEdge,
  type PassGraphDocument,
  type PassGraphEdge,
} from '../project/passGraph';

interface Props {
  open: boolean;
  project: ShaderlabProject;
  document: PassGraphDocument;
  graphDocuments: Partial<Record<GraphPassId, GraphDocument>>;
  diagnostics: UnifiedDiagnostic[];
  onClose: () => void;
  onChange: (document: PassGraphDocument) => void;
  onIssue?: (message: string) => void;
}

const PASS_LABEL_KEYS = {
  image: 'passGraph.pass.image',
  bufferA: 'passGraph.pass.bufferA',
  bufferB: 'passGraph.pass.bufferB',
  bufferC: 'passGraph.pass.bufferC',
  bufferD: 'passGraph.pass.bufferD',
  sound: 'passGraph.pass.sound',
} as const;
const passLabel = (pass: GraphPassId) => t(PASS_LABEL_KEYS[pass]);
const graphPasses: VisualGraphPassId[] = ['image', ...BUFFER_IDS];

const ProjectPassGraphPanel: Component<Props> = (props) => {
  const enabledSources = () => BUFFER_IDS.filter((pass) => props.project.passes[pass].enabled);
  const enabledTargets = () => graphPasses.filter((pass) => props.project.passes[pass].enabled);
  const channelNodes = (pass: GraphPassId) => (props.graphDocuments[pass]?.nodes ?? []).filter((node) => node.type === 'input.channel-sample');
  const patch = (id: string, update: (edge: PassGraphEdge) => PassGraphEdge) => props.onChange({
    ...props.document,
    edges: props.document.edges.map((edge) => edge.id === id ? update(edge) : edge),
  });
  const endpointIssue = (target: VisualGraphPassId) => props.project.passes[target].authoring?.kind === 'graph'
    ? t('passGraph.error.noChannelSample', { pass: passLabel(target) })
    : t('passGraph.error.channelsFull', { pass: passLabel(target) });
  const addEdge = () => {
    const source = enabledSources()[0];
    const target = enabledTargets()[0];
    if (!source || !target) return;
    const selection = endpointSelectionForTarget(props.document, props.project, props.graphDocuments, target);
    if (!selection) {
      props.onIssue?.(endpointIssue(target));
      return;
    }
    const edge: PassGraphEdge = {
      id: `edge-${Date.now().toString(36)}-${props.document.edges.length}`,
      source, target, ...selection, filter: 'linear', wrap: 'repeat', timing: target === 'image' ? 'current' : 'previous',
    };
    props.onChange({ ...props.document, edges: [...props.document.edges, edge] });
  };
  return (
    <Show when={props.open}>
      <section class="pass-graph-panel" aria-label={t('passGraph.title')} tabindex="0">
        <header>
          <div><strong>{t('passGraph.title')}</strong><small>{t('passGraph.subtitle')}</small></div>
          <div><button class="btn mini primary" onClick={addEdge} disabled={!enabledSources().length}>{t('passGraph.addConnection')}</button><button class="btn mini" onClick={props.onClose} aria-label={t('passGraph.closeAria')}>{t('common.close')}</button></div>
        </header>
        <div class="pass-graph-nodes" role="list" aria-label={t('passGraph.nodesAria')}>
          <For each={enabledTargets()}>{(pass) => <span role="listitem"><b>{passLabel(pass)}</b><small>{props.project.passes[pass].authoring?.kind === 'graph' ? t('passGraph.authoring.graph') : t('passGraph.authoring.code')}</small></span>}</For>
        </div>
        <div class="pass-graph-edges">
          <For each={props.document.edges}>{(edge) => (
            <fieldset class="pass-graph-edge">
              <legend>{passLabel(edge.source)} → {passLabel(edge.target)}</legend>
              <label>{t('passGraph.source')}<select aria-label={t('passGraph.sourceAria')} value={edge.source} onChange={(event) => patch(edge.id, (item) => ({ ...item, source: event.currentTarget.value as typeof item.source }))}><For each={enabledSources()}>{(pass) => <option value={pass}>{passLabel(pass)}</option>}</For></select></label>
              <label>{t('passGraph.target')}<select aria-label={t('passGraph.targetAria')} value={edge.target} onChange={(event) => {
                const target = event.currentTarget.value as VisualGraphPassId;
                const retargeted = retargetPassGraphEdge(props.document, edge, target, props.project, props.graphDocuments);
                if (retargeted) patch(edge.id, () => retargeted);
                else props.onIssue?.(endpointIssue(target));
              }}><For each={enabledTargets()}>{(pass) => <option value={pass}>{passLabel(pass)}</option>}</For></select></label>
              <label>{t('passGraph.endpoint')}<select aria-label={t('passGraph.endpointAria')} value={edge.endpoint.kind === 'graph-channel' ? edge.endpoint.nodeId : String(edge.endpoint.slot)} onChange={(event) => patch(edge.id, (item) => endpointChangedForTarget(item, props.project, event.currentTarget.value))}>
                <Show when={props.project.passes[edge.target].authoring?.kind === 'graph'} fallback={<For each={[0, 1, 2, 3]}>{(slot) => <option value={slot}>{t('passGraph.endpoint.codeChannel', { slot })}</option>}</For>}>
                  <For each={channelNodes(edge.target)}>{(node) => <option value={node.id}>{t('passGraph.endpoint.graphNode', { id: node.id })}</option>}</For>
                </Show>
              </select></label>
              <label>{t('passGraph.slot')}<select aria-label={t('passGraph.slotAria')} disabled={edge.endpoint.kind === 'code-slot'} title={edge.endpoint.kind === 'code-slot' ? t('passGraph.codeSlotFixed') : undefined} value={edge.slot.mode === 'auto' ? 'auto' : String(edge.slot.index)} onChange={(event) => patch(edge.id, (item) => ({ ...item, slot: event.currentTarget.value === 'auto' ? { mode: 'auto' } : { mode: 'manual', index: Number(event.currentTarget.value) as 0 | 1 | 2 | 3 } }))}><option value="auto">{t('passGraph.option.auto')}</option><For each={[0, 1, 2, 3]}>{(slot) => <option value={slot}>iChannel{slot}</option>}</For></select></label>
              <label>{t('passGraph.timing')}<select aria-label={t('passGraph.timingAria')} value={edge.timing} onChange={(event) => patch(edge.id, (item) => ({ ...item, timing: event.currentTarget.value as typeof item.timing }))}><option value="current">{t('passGraph.option.current')}</option><option value="previous">{t('passGraph.option.previousFeedback')}</option></select></label>
              <label>{t('passGraph.filter')}<select aria-label={t('passGraph.filterAria')} value={edge.filter} onChange={(event) => patch(edge.id, (item) => ({ ...item, filter: event.currentTarget.value as typeof item.filter }))}><option value="linear">{t('passGraph.option.linear')}</option><option value="nearest">{t('passGraph.option.nearest')}</option></select></label>
              <label>{t('passGraph.wrap')}<select aria-label={t('passGraph.wrapAria')} value={edge.wrap} onChange={(event) => patch(edge.id, (item) => ({ ...item, wrap: event.currentTarget.value as typeof item.wrap }))}><option value="repeat">{t('passGraph.option.repeat')}</option><option value="clamp">{t('passGraph.option.clamp')}</option></select></label>
              <button class="btn mini danger" aria-label={t('passGraph.deleteConnectionAria', { id: edge.id })} onClick={() => props.onChange({ ...props.document, edges: props.document.edges.filter((item) => item.id !== edge.id) })}>{t('common.delete')}</button>
            </fieldset>
          )}</For>
          <Show when={!props.document.edges.length}><p class="empty">{t('passGraph.empty')}</p></Show>
        </div>
        <Show when={props.diagnostics.length}>
          <div class="pass-graph-diagnostics" role="alert">
            <For each={props.diagnostics}>
              {(item) => (
                <ProductMessageView
                  value={{
                    code: item.code ?? 'diagnostic.unstructured',
                    params: item.params,
                    rawDetail: item.rawDetail,
                    fallback: item.message,
                  }}
                  compact
                />
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
};

export default ProjectPassGraphPanel;
