import { For, Show, createSignal, type Component } from 'solid-js';
import { normalizeProductMessage, ProductError, type ProductMessageDescriptor } from '../productMessage';
import ProductMessageView from './ProductMessageView';
import { t } from '../i18n';
import type { AssetManifest, AudioAsset, TextureColorSpace } from '../graph/assets';
import { GRAPH_PARAMETER_VALUE_TYPES, graphTypeComponents, type GraphParameterValue, type GraphValueType } from '../graph/model';
import type { CustomFunctionDefinition, GraphLibraryDocument, LibrarySocket } from '../graph/library';
import { useModalFocus } from './modalFocus';

interface Props {
  open: boolean;
  manifest: AssetManifest;
  library: GraphLibraryDocument;
  onClose: () => void;
  onImportTexture: () => void;
  onImportAudio: () => void;
  onSetTextureColorSpace: (id: string, colorSpace: TextureColorSpace) => void;
  onRemoveTexture: (id: string) => void;
  onRemoveAudio: (id: string) => void;
  onAddStarterGroup: () => void;
  onRemoveGroup: (id: string, version: number) => void;
  onAddFunction: (definition: CustomFunctionDefinition) => ProductMessageDescriptor | null;
  onRemoveFunction: (id: string, version: number) => void;
  onUseRaymarchTemplate: () => void;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function defaultValue(type: Exclude<GraphValueType, 'sdf3'>): GraphParameterValue {
  if (type === 'bool') return false;
  if (type === 'int' || type === 'float') return 0;
  return Array.from({ length: graphTypeComponents(type) }, () => 0);
}

function parseSignature(value: string): LibrarySocket[] {
  const entries = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!entries.length) throw new ProductError({ code: 'graph.resource-input-required' });
  const seen = new Set<string>();
  return entries.map((entry) => {
    const [id, type, ...rest] = entry.split(':').map((part) => part.trim());
    if (rest.length || !id || !IDENTIFIER.test(id) || seen.has(id)) {
      throw new ProductError({ code: 'graph.resource-input-invalid', params: { entry } });
    }
    if (!(GRAPH_PARAMETER_VALUE_TYPES as readonly string[]).includes(type)) {
      throw new ProductError({
        code: 'graph.resource-type-unsupported',
        params: { type: type || 'empty' },
      });
    }
    seen.add(id);
    const valueType = type as Exclude<GraphValueType, 'sdf3'>;
    return { id, title: id, type: valueType, defaultValue: defaultValue(valueType) };
  });
}

const GraphResourcesDialog: Component<Props> = (props) => {
  let dialogRef: HTMLElement | undefined;
  useModalFocus(() => dialogRef);
  const [functionId, setFunctionId] = createSignal('custom_wave');
  const [functionVersion, setFunctionVersion] = createSignal('1');
  const [functionTitle, setFunctionTitle] = createSignal(t('graph.resources.function.defaultTitle'));
  const [functionInputs, setFunctionInputs] = createSignal('value:float, amount:float');
  const [functionOutputType, setFunctionOutputType] = createSignal<Exclude<GraphValueType, 'sdf3'>>('float');
  const [functionExpression, setFunctionExpression] = createSignal('sin(value) * amount');
  const [functionError, setFunctionError] = createSignal<ProductMessageDescriptor | null>(null);

  const addFunction = () => {
    try {
      const version = Number(functionVersion());
      if (!Number.isInteger(version) || version < 1) {
        throw new ProductError({ code: 'graph.resource-version-invalid' });
      }
      const outputType = functionOutputType();
      const issue = props.onAddFunction({
        id: functionId().trim(),
        version,
        title: functionTitle().trim(),
        inputs: parseSignature(functionInputs()),
        output: { id: 'out', title: 'Out', type: outputType },
        expression: functionExpression().trim(),
      });
      if (issue) {
        setFunctionError(issue);
        return;
      }
      setFunctionError(null);
    } catch (error) {
      setFunctionError(error instanceof ProductError
        ? normalizeProductMessage(error)
        : { code: 'graph.custom-function-invalid' });
    }
  };

  return <Show when={props.open}>
    <div class="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        class="modal graph-resources-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-resources-title"
        aria-describedby="graph-resources-subtitle"
        tabindex="-1"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }}
      >
        <header>
          <div>
            <h2 id="graph-resources-title">{t('graph.resources.title')}</h2>
            <p id="graph-resources-subtitle">{t('graph.resources.subtitle')}</p>
          </div>
          <button class="btn mini" onClick={props.onClose}>{t('common.close')}</button>
        </header>
        <div class="graph-resource-grid">
          <section>
            <div class="graph-resource-heading"><h3>{t('graph.resources.textureAssets')}</h3><button class="btn primary" onClick={props.onImportTexture}>{t('graph.resources.importTexture')}</button></div>
            <p class="graph-muted">{t('graph.resources.textureHint')}</p>
            <For each={props.manifest.assets} fallback={<p class="graph-empty">{t('graph.resources.noTextures')}</p>}>
              {(asset) => <div class="graph-resource-row">
                <div class="graph-resource-meta"><strong>{asset.name}</strong><small>{asset.id} · {asset.width}×{asset.height}</small><code title={asset.contentHash}>sha256:{asset.contentHash.slice(0, 12)}…</code></div>
                <label class="graph-resource-inline">{t('graph.resources.colorSpace')}<select value={asset.colorSpace} onChange={(event) => props.onSetTextureColorSpace(asset.id, event.currentTarget.value as TextureColorSpace)}><option value="srgb">{t('graph.resources.colorSpace.srgb')}</option><option value="linear">{t('graph.resources.colorSpace.linear')}</option></select></label>
                <button class="btn mini danger" onClick={() => props.onRemoveTexture(asset.id)}>{t('common.remove')}</button>
              </div>}
            </For>
          </section>
          <section>
            <div class="graph-resource-heading"><h3>{t('graph.resources.audioAssets')}</h3><button class="btn primary" onClick={props.onImportAudio}>{t('graph.resources.importAudio')}</button></div>
            <p class="graph-muted">{t('graph.resources.audioHint')}</p>
            <For each={props.manifest.audio ?? []} fallback={<p class="graph-empty">{t('graph.resources.noAudio')}</p>}>
              {(asset: AudioAsset) => <div class="graph-resource-row">
                <div class="graph-resource-meta"><strong>{asset.name}</strong><small>{asset.id} · {asset.mediaType}</small><code title={asset.contentHash}>sha256:{asset.contentHash.slice(0, 12)}…</code></div>
                <button class="btn mini danger" onClick={() => props.onRemoveAudio(asset.id)}>{t('common.remove')}</button>
              </div>}
            </For>
          </section>
          <section>
            <div class="graph-resource-heading"><h3>{t('graph.resources.nodeGroups')}</h3><button class="btn" onClick={props.onAddStarterGroup}>{t('graph.resources.addGroup')}</button></div>
            <p class="graph-muted">{t('graph.resources.groupHint')}</p>
            <For each={props.library.groups} fallback={<p class="graph-empty">{t('graph.resources.noGroups')}</p>}>
              {(group) => <div class="graph-resource-row"><div class="graph-resource-meta"><strong>{group.title}</strong><small>{group.id}@{group.version} · {t(group.kind === 'graph' ? 'graph.resources.groupKind.graph' : 'graph.resources.groupKind.expression')} · {t('graph.resources.groupIo', { inputs: group.inputs.length, outputs: group.outputs.length })}</small></div><button class="btn mini danger" onClick={() => props.onRemoveGroup(group.id, group.version)}>{t('common.remove')}</button></div>}
            </For>
          </section>
          <section class="graph-custom-function">
            <h3>{t('graph.resources.customFunction')}</h3>
            <div class="graph-resource-form-grid">
              <label>ID<input value={functionId()} onInput={(event) => setFunctionId(event.currentTarget.value)} /></label>
              <label>{t('graph.resources.version')}<input type="number" min="1" step="1" value={functionVersion()} onInput={(event) => setFunctionVersion(event.currentTarget.value)} /></label>
              <label class="wide">{t('graph.resources.titleLabel')}<input value={functionTitle()} onInput={(event) => setFunctionTitle(event.currentTarget.value)} /></label>
              <label class="wide">{t('graph.resources.inputSignature')}<input value={functionInputs()} onInput={(event) => setFunctionInputs(event.currentTarget.value)} placeholder="value:float, amount:float" /></label>
              <label>{t('graph.resources.outputType')}<select value={functionOutputType()} onChange={(event) => setFunctionOutputType(event.currentTarget.value as Exclude<GraphValueType, 'sdf3'>)}><For each={GRAPH_PARAMETER_VALUE_TYPES}>{(type) => <option value={type}>{type}</option>}</For></select></label>
              <label class="wide">{t('graph.resources.expression')}<textarea rows="3" value={functionExpression()} onInput={(event) => setFunctionExpression(event.currentTarget.value)} /></label>
            </div>
            <small>{t('graph.resources.functionHint')}</small>
            <Show when={functionError()}>
              {(descriptor) => <ProductMessageView class="graph-resource-error" value={descriptor()} compact role="alert" />}
            </Show>
            <button class="btn" onClick={addFunction}>{t('graph.resources.validateAdd')}</button>
            <For each={props.library.functions}>{(fn) => <div class="graph-resource-row"><div class="graph-resource-meta"><strong>{fn.title}</strong><small>{fn.id}@{fn.version} · ({fn.inputs.map((input) => `${input.id}:${input.type}`).join(', ')}) → {fn.output.type}</small><code>{fn.expression}</code></div><button class="btn mini danger" onClick={() => props.onRemoveFunction(fn.id, fn.version)}>{t('common.remove')}</button></div>}</For>
          </section>
          <section>
            <h3>{t('graph.resources.raymarchTitle')}</h3>
            <p class="graph-muted">{t('graph.resources.raymarchHint')}</p>
            <button class="btn primary" onClick={props.onUseRaymarchTemplate}>{t('graph.resources.useRaymarch')}</button>
          </section>
        </div>
      </section>
    </div>
  </Show>;
};

export default GraphResourcesDialog;
