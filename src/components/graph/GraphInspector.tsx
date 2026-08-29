import { For, Show, createEffect, createMemo, createSignal, type Component } from 'solid-js';
import { formatGraphValueDraft, graphParameterTypePatch, parseGraphValueDraft } from '../../graph/editor/valueDraft';
import { GRAPH_PARAMETER_VALUE_TYPES, graphTypeComponents, type GraphDocument, type GraphParameter, type GraphParameterValue, type GraphValueType } from '../../graph/model';
import type { TextureAsset } from '../../graph/assets';
import { type NodeDefinition, type NodeRegistry } from '../../graph/registry';
import type { ProductMessageDescriptor } from '../../productMessage';
import ProductMessageView from '../ProductMessageView';
import { t } from '../../i18n';

interface Props { document: GraphDocument; registry: NodeRegistry; assets?: readonly TextureAsset[]; selectedNodeId?: string; onSetValue: (nodeId: string, key: string, value: unknown) => void; onAddParameter: (parameter: GraphParameter) => void; onUpdateParameter: (id: string, patch: Partial<Omit<GraphParameter, 'id'>>) => void; onDeleteParameter: (id: string) => void }

interface StrictValueInputProps { label: string; type: GraphValueType; value: GraphParameterValue; onValid: (value: GraphParameterValue) => void }
const StrictValueInput: Component<StrictValueInputProps> = (props) => {
  const [draft, setDraft] = createSignal(formatGraphValueDraft(props.value));
  const [error, setError] = createSignal<ProductMessageDescriptor | null>(null);
  createEffect(() => { setDraft(formatGraphValueDraft(props.value)); setError(null); });
  const update = (raw: string) => {
    setDraft(raw);
    const parsed = parseGraphValueDraft(props.type, raw);
    if (!parsed.ok) { setError(parsed.error); return; }
    setError(null);
    props.onValid(parsed.value);
  };
  return <><input aria-label={props.label} value={draft()} aria-invalid={error() ? 'true' : 'false'} onInput={(event) => update(event.currentTarget.value)} /><Show when={error()}>{(descriptor) => <ProductMessageView class="graph-field-error" value={descriptor()} compact role="alert" />}</Show></>;
};

interface StrictStringInputProps { label: string; value: string; validate: (value: unknown) => ProductMessageDescriptor | undefined; onValid: (value: string) => void }
const StrictStringInput: Component<StrictStringInputProps> = (props) => {
  const [draft, setDraft] = createSignal(props.value);
  const [error, setError] = createSignal<ProductMessageDescriptor | null>(null);
  createEffect(() => { setDraft(props.value); setError(null); });
  const update = (raw: string) => {
    setDraft(raw);
    const issue = props.validate(raw);
    setError(issue ?? null);
    if (!issue) props.onValid(raw);
  };
  return <><input aria-label={props.label} value={draft()} aria-invalid={error() ? 'true' : 'false'} onInput={(event) => update(event.currentTarget.value)} /><Show when={error()}>{(descriptor) => <ProductMessageView class="graph-field-error" value={descriptor()} compact role="alert" />}</Show></>;
};

function fieldValueType(definition: NodeDefinition, key: string, fallback: unknown): GraphValueType | undefined {
  const socket = definition.inputs.find((item) => item.id === key);
  if (socket?.defaultType) return socket.defaultType;
  if (socket && GRAPH_PARAMETER_VALUE_TYPES.includes(socket.type as GraphParameter['valueType'])) return socket.type as GraphValueType;
  if (typeof fallback === 'boolean') return 'bool';
  if (Array.isArray(fallback)) return `vec${fallback.length}` as GraphValueType;
  if (typeof fallback === 'number') {
    const validator = definition.valueFields?.[key];
    return validator?.validate(1.5) && !validator.validate(1) ? 'int' : 'float';
  }
  return undefined;
}

const GraphInspector: Component<Props> = (props) => {
  const node = createMemo(() => props.document.nodes.find((item) => item.id === props.selectedNodeId));
  const definition = createMemo(() => { const value = node(); return value ? props.registry.get(value.type, value.typeVersion) : undefined; });
  const fields = createMemo(() => {
    const def = definition();
    if (!def) return [];
    const keys = new Set([...Object.keys(def.defaultValues), ...Object.keys(def.valueFields ?? {})]);
    keys.delete('parameterId');
    return [...keys];
  });
  const addParameter = () => props.onAddParameter({ id: `parameter-${Date.now().toString(36)}`, name: t('graph.inspector.parameter.defaultName', { index: props.document.parameters.length + 1 }), valueType: 'float', defaultValue: 0.5, ui: { widget: 'slider', min: 0, max: 1, step: 0.01 } });

  return <aside class="graph-inspector"><div class="graph-inspector-scroll"><h3>{t('graph.inspector.title')}</h3><Show when={node()} fallback={<p class="graph-muted">{t('graph.inspector.empty')}</p>}>{(selected) => <><div class="graph-node-id">{definition()?.title}<small>{selected().id}</small></div><For each={fields()}>{(key) => {
    const def = definition()!;
    const fallback = def.defaultValues[key];
    const value = () => selected().values[key] ?? fallback;
    const type = fieldValueType(def, key, fallback);
    const validator = def.valueFields?.[key];
    return <label class="graph-field"><span>{key}</span><Show when={selected().type === 'input.texture2d' && key === 'assetId'} fallback={<Show when={type === 'bool'} fallback={<Show when={type} fallback={<StrictStringInput label={t('graph.inspector.valueAria', { key })} value={String(value() ?? '')} validate={(raw) => validator?.validate(raw)} onValid={(next) => props.onSetValue(selected().id, key, next)} />}>{(valueType) => <StrictValueInput label={t('graph.inspector.valueAria', { key })} type={valueType()} value={value() as GraphParameterValue} onValid={(next) => props.onSetValue(selected().id, key, next)} />}</Show>}><input type="checkbox" checked={Boolean(value())} onChange={(event) => props.onSetValue(selected().id, key, event.currentTarget.checked)} /></Show>}><select aria-label={t('graph.inspector.textureAssetAria')} value={String(value() ?? '')} onChange={(event) => props.onSetValue(selected().id, key, event.currentTarget.value)}><option value="">{t('graph.inspector.selectTexture')}</option><For each={props.assets ?? []}>{(asset) => <option value={asset.id}>{asset.name} ({asset.width}×{asset.height})</option>}</For></select></Show></label>;
  }}</For><Show when={selected().type === 'core.parameter'}><label class="graph-field"><span>{t('graph.inspector.parameter')}</span><select value={String(selected().values.parameterId ?? '')} onChange={(event) => props.onSetValue(selected().id, 'parameterId', event.currentTarget.value)}><option value="">{t('graph.inspector.selectParameter')}</option><For each={props.document.parameters}>{(parameter) => <option value={parameter.id}>{parameter.name}</option>}</For></select></label></Show></>}</Show><div class="graph-parameter-head"><h3>{t('graph.inspector.parameters')}</h3><button class="btn mini" onClick={addParameter}>＋</button></div><For each={props.document.parameters}>{(parameter) => <div class="graph-parameter"><input aria-label={t('graph.inspector.parameterNameAria')} value={parameter.name} onChange={(event) => props.onUpdateParameter(parameter.id, { name: event.currentTarget.value })} /><select aria-label={t('graph.inspector.parameterTypeAria')} value={parameter.valueType} onChange={(event) => { const valueType = event.currentTarget.value as GraphParameter['valueType']; props.onUpdateParameter(parameter.id, graphParameterTypePatch(valueType)); }}><For each={GRAPH_PARAMETER_VALUE_TYPES}>{(type) => <option value={type}>{type}</option>}</For></select><Show when={parameter.valueType === 'bool'} fallback={<div class="graph-parameter-value"><StrictValueInput label={t('graph.inspector.parameterDefaultAria')} type={parameter.valueType} value={parameter.defaultValue} onValid={(defaultValue) => props.onUpdateParameter(parameter.id, { defaultValue })} /></div>}><select aria-label={t('graph.inspector.parameterDefaultAria')} value={String(parameter.defaultValue)} onChange={(event) => { const parsed = parseGraphValueDraft('bool', event.currentTarget.value); if (parsed.ok) props.onUpdateParameter(parameter.id, { defaultValue: parsed.value }); }}><option value="false">false</option><option value="true">true</option></select></Show><button class="btn mini danger" aria-label={t('graph.inspector.deleteParameterAria')} onClick={() => props.onDeleteParameter(parameter.id)}>×</button></div>}</For></div></aside>;
};
export default GraphInspector;
