import { localizedDetail, t, type TranslationKey, type TranslationParams } from './i18n';
import { normalizeProductMessage, type ProductError, type ProductMessageDescriptor } from './productMessage';
import { sanitizeProductMessageDetail, type SafeProductMessageDetail } from './productMessageDetail';

export const MESSAGE_KEYS = {
  'export.requirements-missing': 'product.export.requirementsMissing',
  'export.uniform-conflict': 'product.export.uniformConflict',
  'export.compile-errors': 'product.export.compileErrors',
  'export.compile-status': 'product.export.compileStatus',
  'export.visual-runtime-not-ready': 'product.export.visualRuntimeNotReady',
  'export.sound-runtime-not-ready': 'product.export.soundRuntimeNotReady',
  'export.graph-not-accepted': 'product.export.graphNotAccepted',
  'export.ticket-expired': 'product.export.ticketExpired',
  'export.canvas-unavailable': 'product.export.canvasUnavailable',
  'export.frame-capture-failed': 'product.export.frameCaptureFailed',
  'export.frame-size-mismatch': 'product.export.frameSizeMismatch',
  'export.no-frames': 'product.export.noFrames',
  'export.h264-unsupported': 'product.export.h264Unsupported',
  'export.video-encode-failed': 'product.export.videoEncodeFailed',
  'export.failed': 'product.export.failed',
  'shadertoy.invalid-json': 'product.shadertoy.invalidJson',
  'shadertoy.root-invalid': 'product.shadertoy.rootInvalid',
  'shadertoy.renderpass-missing': 'product.shadertoy.renderpassMissing',
  'shadertoy.image-missing': 'product.shadertoy.imageMissing',
  'shadertoy.image-empty': 'product.shadertoy.imageEmpty',
  'shadertoy.warning.extra-buffers': 'product.shadertoy.warningExtraBuffers',
  'shadertoy.warning.channels-skipped': 'product.shadertoy.warningChannelsSkipped',
  'shadertoy.warning.missing-assets': 'product.shadertoy.warningMissingAssets',
  'updater.download-failed': 'product.updater.downloadFailed',
  'export.shadertoy-pass-graph-invalid': 'product.export.shadertoyPassGraphInvalid',
  'export.shadertoy-timing-unsupported': 'product.export.shadertoyTimingUnsupported',
  'export.shadertoy-graph-texture-unsupported': 'product.export.shadertoyGraphTextureUnsupported',
  'export.shadertoy-code-texture-unsupported': 'product.export.shadertoyCodeTextureUnsupported',
  'export.shadertoy-missing-assets': 'product.export.shadertoyMissingAssets',
  'runtime.disposed': 'product.runtime.disposed',
  'runtime.visual-prepare-failed': 'product.runtime.visualPrepareFailed',
  'runtime.sound-prepare-failed': 'product.runtime.soundPrepareFailed',
  'runtime.program-link-failed': 'product.runtime.programLinkFailed',
  'runtime.image-source-missing': 'product.runtime.imageSourceMissing',
  'runtime.timing-plan-invalid': 'product.runtime.timingPlanInvalid',
  'runtime.channel-plan-invalid': 'product.runtime.channelPlanInvalid',
  'runtime.texture-upload-failed': 'product.runtime.textureUploadFailed',
  'runtime.audio-decode-failed': 'product.runtime.audioDecodeFailed',
  'runtime.visual-resources-failed': 'product.runtime.visualResourcesFailed',
  'runtime.sound-channel-invalid': 'product.runtime.soundChannelInvalid',
  'runtime.sound-program-unavailable': 'product.runtime.soundProgramUnavailable',
  'runtime.sound-texture-upload-failed': 'product.runtime.soundTextureUploadFailed',
  'runtime.glsl-compile-failed': 'product.runtime.glslCompileFailed',
  'runtime.preview-resolution-failed': 'product.runtime.previewResolutionFailed',
  'runtime.webgl2-unavailable': 'product.runtime.webgl2Unavailable',
  'runtime.preview-snapshot-texture-failed': 'product.runtime.previewSnapshotTextureFailed',
  'runtime.preview-freeze-container-missing': 'product.runtime.previewFreezeContainerMissing',
  'runtime.preview-snapshot-failed': 'product.runtime.previewSnapshotFailed',
  'runtime.capture-dimension-limit': 'product.runtime.captureDimensionLimit',
  'runtime.texture-create-failed': 'product.runtime.textureCreateFailed',
  'runtime.texture-source-missing': 'product.runtime.textureSourceMissing',
  'runtime.feedback-framebuffer-failed': 'product.runtime.feedbackFramebufferFailed',
  'runtime.feedback-texture-failed': 'product.runtime.feedbackTextureFailed',
  'runtime.sampler-create-failed': 'product.runtime.samplerCreateFailed',
  'runtime.preview-dimensions-invalid': 'product.runtime.previewDimensionsInvalid',
  'runtime.preview-dimension-limit': 'product.runtime.previewDimensionLimit',
  'runtime.sound-render-target-failed': 'product.runtime.soundRenderTargetFailed',
  'bridge.native-unavailable': 'product.bridge.nativeUnavailable',
  'bridge.duplicate-target': 'product.bridge.duplicateTarget',
  'bridge.blob-read-failed': 'product.bridge.blobReadFailed',
  'bridge.pick-folder-failed': 'product.bridge.pickFolderFailed',
  'bridge.pick-file-failed': 'product.bridge.pickFileFailed',
  'bridge.read-text-failed': 'product.bridge.readTextFailed',
  'bridge.read-binary-failed': 'product.bridge.readBinaryFailed',
  'bridge.write-text-failed': 'product.bridge.writeTextFailed',
  'bridge.write-files-failed': 'product.bridge.writeFilesFailed',
  'bridge.write-binary-failed': 'product.bridge.writeBinaryFailed',
  'bridge.create-dir-failed': 'product.bridge.createDirFailed',
  'bridge.delete-file-failed': 'product.bridge.deleteFileFailed',
  'graph.invalid-json': 'product.graph.invalidJson',
  'graph.invalid': 'product.graph.invalid',
  'graph.future-version': 'product.graph.futureVersion',
  'schema.future-version': 'product.graph.futureVersion',
  'graph.pass-mismatch': 'product.graph.passMismatch',
  'graph.unsafe-path': 'product.graph.unsafePath',
  'graph.missing': 'product.graph.missing',
  'graph.document-missing': 'product.graph.documentMissing',
  'graph.artifact-missing': 'product.graph.artifactMissing',
  'graph.runtime-acceptance-required': 'product.graph.runtimeAcceptanceRequired',
  'graph.artifact-pass-mismatch': 'product.graph.artifactPassMismatch',
  'graph.artifact-hash-mismatch': 'product.graph.artifactHashMismatch',
  'graph.artifact-stale': 'product.graph.artifactStale',
  'graph.compile-failed': 'product.graph.compileFailed',
  'graph.duplicate-parameter-id': 'product.graph.duplicateIdentifier',
  'graph.duplicate-node-id': 'product.graph.duplicateIdentifier',
  'graph.duplicate-edge-id': 'product.graph.duplicateIdentifier',
  'graph.unknown-node': 'product.graph.unknownNode',
  'graph.node-pass-unavailable': 'product.graph.nodePassUnavailable',
  'graph.unknown-parameter': 'product.graph.unknownParameter',
  'graph.output-target': 'product.graph.outputTargetInvalid',
  'graph.output-count': 'product.graph.outputCountInvalid',
  'graph.self-edge': 'product.graph.connectionSelf',
  'graph.dangling-edge': 'product.graph.danglingEdge',
  'graph.edge-direction': 'product.graph.edgeDirectionInvalid',
  'graph.unknown-socket': 'product.graph.unknownSocket',
  'graph.duplicate-input': 'product.graph.duplicateInput',
  'graph.cycle': 'product.graph.cycle',
  'schema.invalid-json': 'product.graph.invalidJson',
  'schema.document': 'product.graph.schemaDocumentInvalid',
  'schema.format': 'product.graph.schemaFormatInvalid',
  'schema.version': 'product.graph.schemaVersionInvalid',
  'schema.unsupported-version': 'product.graph.schemaVersionUnsupported',
  'schema.pass': 'product.graph.schemaPassInvalid',
  'schema.viewport': 'product.graph.schemaViewportInvalid',
  'schema.nodes': 'product.graph.schemaNodesInvalid',
  'schema.node': 'product.graph.schemaNodeInvalid',
  'schema.position': 'product.graph.schemaPositionInvalid',
  'schema.node-values': 'product.graph.schemaNodeValuesInvalid',
  'schema.invalid-node-value': 'product.graph.schemaNodeValueUnsafe',
  'schema.edges': 'product.graph.schemaEdgesInvalid',
  'schema.edge': 'product.graph.schemaEdgeInvalid',
  'schema.parameters': 'product.graph.schemaParametersInvalid',
  'schema.parameter': 'product.graph.schemaParameterInvalid',
  'schema.parameter-default': 'product.graph.schemaParameterDefaultInvalid',
  'schema.parameter-ui': 'product.graph.schemaParameterUiInvalid',
  'schema.parameter-widget': 'product.graph.schemaParameterWidgetInvalid',
  'schema.non-finite': 'product.graph.schemaFiniteRequired',
  'schema.parameter-step': 'product.graph.schemaParameterStepInvalid',
  'schema.parameter-range': 'product.graph.schemaParameterRangeInvalid',
  'graph.workspace-invalid': 'product.graph.workspaceInvalid',
  'graph.library-invalid': 'product.graph.libraryInvalid',
  'graph.resource-input-required': 'product.graph.resourceInputRequired',
  'graph.resource-input-invalid': 'product.graph.resourceInputInvalid',
  'graph.resource-type-unsupported': 'product.graph.resourceTypeUnsupported',
  'graph.resource-version-invalid': 'product.graph.resourceVersionInvalid',
  'graph.library-update-failed': 'product.graph.libraryUpdateFailed',
  'graph.custom-function-invalid': 'product.graph.customFunctionInvalid',
  'graph.group-change-rejected': 'product.graph.groupChangeRejected',
  'graph.group-node-not-pure': 'product.graph.groupNodeNotPure',
  'graph.group-parameter-not-pure': 'product.graph.groupParameterNotPure',
  'graph.runtime-rejected-recovery': 'product.graph.runtimeRejectedRecovery',
  'graph.recovery-fallback-rejected': 'product.graph.recoveryFallbackRejected',
  'graph.group-undo-rejected': 'product.graph.groupUndoRejected',
  'graph.group-redo-rejected': 'product.graph.groupRedoRejected',
  'graph.group-atomic-undo-failed': 'product.graph.groupAtomicUndoFailed',
  'graph.group-atomic-redo-failed': 'product.graph.groupAtomicRedoFailed',
  'graph.group-create-failed': 'product.graph.groupCreateFailed',
  'graph.connection-endpoint-missing': 'product.graph.connectionEndpointMissing',
  'graph.connection-self': 'product.graph.connectionSelf',
  'graph.connection-definition-missing': 'product.graph.connectionDefinitionMissing',
  'graph.connection-source-output-required': 'product.graph.connectionSourceOutputRequired',
  'graph.connection-target-input-required': 'product.graph.connectionTargetInputRequired',
  'graph.value-boolean-required': 'product.graph.valueBooleanRequired',
  'graph.value-integer-required': 'product.graph.valueIntegerRequired',
  'graph.value-number-required': 'product.graph.valueNumberRequired',
  'graph.value-components-required': 'product.graph.valueComponentsRequired',
  'graph.value-undeclared': 'product.graph.valueUndeclared',
  'graph.value-boolean-text-required': 'product.graph.valueBooleanTextRequired',
  'graph.value-components-text-required': 'product.graph.valueComponentsTextRequired',
  'graph.value-finite-required': 'product.graph.valueFiniteRequired',
  'graph.value-integer-text-required': 'product.graph.valueIntegerTextRequired',
  'graph.value-vector-mask-invalid': 'product.graph.valueVectorMaskInvalid',
  'graph.value-asset-id-string-required': 'product.graph.valueAssetIdStringRequired',
  'graph.value-filter-invalid': 'product.graph.valueFilterInvalid',
  'graph.value-wrap-invalid': 'product.graph.valueWrapInvalid',
  'graph.value-string-required': 'product.graph.valueStringRequired',
  'graph.serialize-failed': 'product.graph.serializeFailed',
  'graph.generated-hash-missing': 'product.graph.generatedHashMissing',
  'graph.generated-hash-mismatch': 'product.graph.generatedHashMismatch',
  'graph.generated-source-mismatch': 'product.graph.generatedSourceMismatch',
  'graph.format-version-mismatch': 'product.graph.formatVersionMismatch',
  'pass-graph.invalid-json': 'product.passGraph.invalidJson',
  'pass-graph.invalid-format': 'product.passGraph.invalidFormat',
  'pass-graph.invalid-version': 'product.passGraph.invalidVersion',
  'pass-graph.future-version': 'product.passGraph.futureVersion',
  'pass-graph.edges-missing': 'product.passGraph.edgesMissing',
  'pass-graph.invalid-edge': 'product.passGraph.invalidEdge',
  'pass-graph.invalid': 'product.passGraph.invalid',
  'pass-graph.duplicate-edge': 'product.passGraph.duplicateEdge',
  'pass-graph.duplicate-endpoint': 'product.passGraph.duplicateEndpoint',
  'pass-graph.source-disabled': 'product.passGraph.sourceDisabled',
  'pass-graph.target-disabled': 'product.passGraph.targetDisabled',
  'pass-graph.current-self-loop': 'product.passGraph.currentSelfLoop',
  'pass-graph.endpoint-authoring': 'product.passGraph.endpointAuthoring',
  'pass-graph.endpoint-missing': 'product.passGraph.endpointMissing',
  'pass-graph.code-slot-mismatch': 'product.passGraph.codeSlotMismatch',
  'pass-graph.duplicate-slot': 'product.passGraph.duplicateSlot',
  'pass-graph.too-many-channels': 'product.passGraph.tooManyChannels',
  'pass-graph.current-cycle': 'product.passGraph.currentCycle',
  'pass-graph.no-slot': 'product.passGraph.noSlot',
  'pass-graph.reference-format-mismatch': 'product.passGraph.referenceFormatMismatch',
  'pass-graph.reference-revision-missing': 'product.passGraph.referenceRevisionMissing',
  'pass-graph.reference-revision-mismatch': 'product.passGraph.referenceRevisionMismatch',
  'pass-graph.load-failed': 'product.passGraph.loadFailed',
  'pass-graph.code-conversion-unresolved': 'product.passGraph.codeConversionUnresolved',
  'compiler.internal': 'product.graph.compilerInternal',
  'type.required-input': 'product.graph.typeRequiredInput',
  'type.missing-source-type': 'product.graph.typeMissingSourceType',
  'type.incompatible': 'product.graph.typeIncompatible',
  'type.inference-failed': 'product.graph.typeInferenceFailed',
  'type.output-unresolved': 'product.graph.typeOutputUnresolved',
  'uniform.type-conflict': 'product.uniform.typeConflict',
  'asset.binding-invalid': 'product.asset.bindingInvalid',
  'asset.manifest-invalid': 'product.asset.manifestInvalid',
  'diagnostic.unstructured': 'product.diagnostic.unstructured',
  'project.duplicate-target': 'product.project.duplicateTarget',
  'project.pass-graph-invalid': 'product.project.passGraphInvalid',
  'project.unsafe-path': 'product.project.unsafePath',
  'project.graph-metadata-missing': 'product.project.graphMetadataMissing',
  'project.asset-payload-missing': 'product.project.assetPayloadMissing',
  'project.asset-hash-mismatch': 'product.project.assetHashMismatch',
  'project.config-missing': 'product.project.configMissing',
  'project.main-pass-missing': 'product.project.mainPassMissing',
  'project.identity-mismatch': 'product.project.identityMismatch',
  'project.autosave-invalid': 'product.project.autosaveInvalid',
  'project.autosave-pass-graph-snapshot-missing': 'product.project.autosavePassGraphSnapshotMissing',
  'chat.message-empty': 'product.chat.messageEmpty',
  'chat.ai-not-configured': 'product.chat.aiNotConfigured',
  'chat.request-failed': 'product.chat.requestFailed',
  'chat.state-unavailable': 'product.chat.stateUnavailable',
  'chat.config-save-failed': 'product.chat.configSaveFailed',
  'chat.agent-init-failed': 'product.chat.agentInitFailed',
  'chat.template-name-empty': 'product.chat.templateNameEmpty',
  'chat.template-name-too-long': 'product.chat.templateNameTooLong',
  'chat.template-code-empty': 'product.chat.templateCodeEmpty',
  'chat.template-code-too-large': 'product.chat.templateCodeTooLarge',
  'chat.template-entry-missing': 'product.chat.templateEntryMissing',
  'chat.template-uniform-declared': 'product.chat.templateUniformDeclared',
  'chat.template-dir-create-failed': 'product.chat.templateDirCreateFailed',
  'chat.template-name-invalid': 'product.chat.templateNameInvalid',
  'chat.template-name-collision': 'product.chat.templateNameCollision',
  'chat.template-serialize-failed': 'product.chat.templateSerializeFailed',
  'chat.template-write-failed': 'product.chat.templateWriteFailed',
  'chat.template-slug-invalid': 'product.chat.templateSlugInvalid',
  'chat.template-delete-not-found': 'product.chat.templateDeleteNotFound',
  'chat.template-delete-file-failed': 'product.chat.templateDeleteFileFailed',
  'chat.template-not-found': 'product.chat.templateNotFound',
  'chat.template-preflight-failed': 'product.chat.templatePreflightFailed',
  'chat.template-save-failed': 'product.chat.templateSaveFailed',
  'chat.template-delete-failed': 'product.chat.templateDeleteFailed',
  'chat.template-list-failed': 'product.chat.templateListFailed',
  'chat.template-adopt-failed': 'product.chat.templateAdoptFailed',
  'chat.data-dir-failed': 'product.chat.dataDirFailed',
  'chat.notice.clarification-required': 'product.chat.noticeClarificationRequired',
  'chat.notice.suggestions-empty': 'product.chat.noticeSuggestionsEmpty',
  'chat.notice.suggestions-available': 'product.chat.noticeSuggestionsAvailable',
  'chat.notice.code-generated': 'product.chat.noticeCodeGenerated',
  'chat.notice.documentation-ready': 'product.chat.noticeDocumentationReady',
  'chat.notice.complete': 'product.chat.noticeComplete',
  'chat.notice.auto-documentation': 'product.chat.noticeAutoDocumentation',
  'chat.notice.compile-passed': 'product.chat.noticeCompilePassed',
  'chat.notice.render-skipped': 'product.chat.noticeRenderSkipped',
  'chat.notice.render-passed': 'product.chat.noticeRenderPassed',
  'chat.notice.render-failed': 'product.chat.noticeRenderFailed',
  'chat.notice.template-adopted-user': 'product.chat.noticeTemplateAdoptedUser',
  'chat.notice.template-adopted-builtin': 'product.chat.noticeTemplateAdoptedBuiltin',
  // Compatibility with intermediate producers.
  'chat.notice.template-adopted': 'product.chat.noticeTemplateAdoptedBuiltin',
} as const satisfies Readonly<Record<string, TranslationKey>>;

export type ProductMessageCode = keyof typeof MESSAGE_KEYS;
export type KnownProductMessageDescriptor = ProductMessageDescriptor<ProductMessageCode>;

export function isKnownProductMessageCode(code: string): code is ProductMessageCode {
  return Object.prototype.hasOwnProperty.call(MESSAGE_KEYS, code);
}

function keyForCode(code: string): TranslationKey | undefined {
  return isKnownProductMessageCode(code)
    ? MESSAGE_KEYS[code]
    : code.startsWith('pass-graph.')
      ? 'product.passGraph.invalid'
      : code.startsWith('schema.') || code.startsWith('graph.')
        ? 'product.graph.invalid'
        : undefined;
}

export interface ProductMessageViewModel {
  descriptor: ProductMessageDescriptor;
  code: string;
  summary: string;
  detail?: SafeProductMessageDetail;
}

export function createProductMessageViewModel(
  value: ProductMessageDescriptor | ProductError | unknown,
  summaryOverride?: string,
): ProductMessageViewModel {
  const descriptor = normalizeProductMessage(value);
  const exactKey = isKnownProductMessageCode(descriptor.code)
    ? MESSAGE_KEYS[descriptor.code]
    : undefined;
  const key = exactKey ?? keyForCode(descriptor.code);
  const summary = summaryOverride ?? (key
    ? t(key, descriptor.params as TranslationParams | undefined)
    : t('product.message.unknown'));
  const rawDetail = descriptor.rawDetail ?? (!exactKey ? descriptor.fallback : undefined);
  const detail = rawDetail && rawDetail !== summary
    ? sanitizeProductMessageDetail(rawDetail)
    : undefined;
  return {
    descriptor,
    code: sanitizeProductMessageDetail(descriptor.code).text || 'product.unknown',
    summary,
    ...(detail?.text ? { detail } : {}),
  };
}

/** 仅返回稳定、可本地化的产品摘要，不附加外部详情。 */
export function formatProductMessageSummary(
  value: ProductMessageDescriptor | ProductError | unknown,
): string {
  return createProductMessageViewModel(value).summary;
}

/**
 * 兼容纯字符串 UI 的安全 formatter。新 UI 应优先使用 ProductMessageView，
 * 以便将已脱敏详情默认折叠并提供安全复制。
 */
export function formatProductMessage(value: ProductMessageDescriptor | ProductError | unknown): string {
  const model = createProductMessageViewModel(value);
  return `${model.summary}${model.detail ? localizedDetail(model.detail.text) : ''}`;
}
