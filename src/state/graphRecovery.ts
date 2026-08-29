import type { UnifiedDiagnostic } from '../diagnostics/model';
import { compileGraph, type CompileGraphOptions } from '../graph/compiler/index';
import type { GraphDocument, GraphPassId } from '../graph/model';
import {
  resolvePassGraph,
  type PassGraphDocument,
  type PassGraphResolution,
} from '../project/passGraph';
export type { GraphRecoveryReason } from '../project/types';
import type { GraphRecoveryReason, ShaderlabProject } from '../project/types';

/** A deterministic shader used only to replace an unrelated previous-project frame after recovery failure. */
export const SAFE_GRAPH_RECOVERY_SHADER = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / max(iResolution.xy, vec2(1.0));
    vec3 base = mix(vec3(0.06, 0.07, 0.10), vec3(0.18, 0.08, 0.12), uv.y);
    float stripe = step(0.5, fract((uv.x + uv.y) * 16.0));
    fragColor = vec4(base + stripe * 0.025, 1.0);
}
`;

export type PersistedGraphClassification =
  | { kind: 'editable' }
  | { kind: 'readonly-recovery'; diagnostics: UnifiedDiagnostic[] };

/** Schema-valid persisted Graphs become editable only when the Graph compiler accepts them. */
export function classifyPersistedGraph(
  document: GraphDocument,
  options: CompileGraphOptions = {},
): PersistedGraphClassification {
  const result = compileGraph(document, options);
  return result.ok && result.artifact
    ? { kind: 'editable' }
    : { kind: 'readonly-recovery', diagnostics: result.diagnostics };
}

export type GraphRecoveryDocuments = Partial<Record<GraphPassId, GraphDocument>>;
export type GraphRecoveryReasonMap = Partial<Record<GraphPassId, GraphRecoveryReason>>;

export type PersistedGraphRecoveryDecision =
  | { kind: 'editable' }
  | { kind: 'readonly-recovery'; reason: Extract<GraphRecoveryReason, 'identity-mismatch' | 'compiler-invalid'>; diagnostics: UnifiedDiagnostic[] };

/** Compiler rejection always wins over identity mismatch so invalid authoring is never mislabeled or auto-promoted. */
export function persistedGraphRecoveryDecision(
  classification: PersistedGraphClassification,
  identityValid: boolean,
): PersistedGraphRecoveryDecision {
  if (classification.kind === 'readonly-recovery') {
    return { kind: 'readonly-recovery', reason: 'compiler-invalid', diagnostics: classification.diagnostics };
  }
  return identityValid
    ? { kind: 'editable' }
    : { kind: 'readonly-recovery', reason: 'identity-mismatch', diagnostics: [] };
}

export type PassGraphIdentityRecoveryPlan =
  | {
    kind: 'promote';
    resolution: PassGraphResolution & { resolved: NonNullable<PassGraphResolution['resolved']> };
    documents: GraphRecoveryDocuments;
    diagnostics: Partial<Record<GraphPassId, UnifiedDiagnostic[]>>;
  }
  | {
    kind: 'blocked';
    resolution: PassGraphResolution;
    documents: GraphRecoveryDocuments;
    diagnostics: Partial<Record<GraphPassId, UnifiedDiagnostic[]>>;
  };

/**
 * Resolves a candidate Pass Graph against the exact current authoring documents, then
 * reclassifies every editor and recovery document in that same resolved environment.
 * Promotion is deliberately all-or-nothing and limited to identity-bound recovery.
 */
export function planPassGraphIdentityRecovery(
  candidate: PassGraphDocument,
  project: ShaderlabProject,
  editorDocuments: GraphRecoveryDocuments,
  recoveryDocuments: GraphRecoveryDocuments,
  recoveryReasons: GraphRecoveryReasonMap,
): PassGraphIdentityRecoveryPlan {
  const graphDocuments = { ...recoveryDocuments, ...editorDocuments };
  const resolution = resolvePassGraph(candidate, project, graphDocuments);
  if (!resolution.ok || !resolution.resolved) {
    return { kind: 'blocked', resolution, documents: {}, diagnostics: {} };
  }

  const diagnostics: Partial<Record<GraphPassId, UnifiedDiagnostic[]>> = {};
  for (const pass of Object.keys(graphDocuments) as GraphPassId[]) {
    const document = graphDocuments[pass];
    if (!document) continue;
    const classification = classifyPersistedGraph(document, {
      channelEnvironment: resolution.resolved.channelEnvironment[pass],
      channelEnvironmentRevision: resolution.resolved.revision,
    });
    if (classification.kind === 'readonly-recovery') diagnostics[pass] = classification.diagnostics;
  }

  if (Object.keys(diagnostics).length) {
    return { kind: 'blocked', resolution, documents: {}, diagnostics };
  }

  const documents: GraphRecoveryDocuments = {};
  for (const pass of Object.keys(recoveryDocuments) as GraphPassId[]) {
    if (recoveryReasons[pass] === 'identity-mismatch' && recoveryDocuments[pass]) {
      documents[pass] = recoveryDocuments[pass];
    }
  }
  return {
    kind: 'promote',
    resolution: resolution as PassGraphResolution & { resolved: NonNullable<PassGraphResolution['resolved']> },
    documents,
    diagnostics: {},
  };
}

export function clearAcceptedRuntimeRecoveryFlags(
  pending: Partial<Record<GraphPassId, boolean>>,
  acceptedPasses: readonly GraphPassId[],
): Partial<Record<GraphPassId, boolean>> {
  const next = { ...pending };
  for (const pass of acceptedPasses) delete next[pass];
  return next;
}

export type LoadedGraphRuntimeAction = 'keep-normal-flow' | 'try-persisted-fallback';

/** M2 stale-preview behavior is preserved once any artifact has already been accepted. */
export function loadedGraphRuntimeAction(
  hasRuntimeAcceptedArtifact: boolean,
  candidateAccepted: boolean,
): LoadedGraphRuntimeAction {
  return !candidateAccepted && !hasRuntimeAcceptedArtifact
    ? 'try-persisted-fallback'
    : 'keep-normal-flow';
}

export type GraphRecoveryPreview = 'persisted-fallback' | 'safe-placeholder';

export function graphRecoveryPreview(fallbackAccepted: boolean): GraphRecoveryPreview {
  return fallbackAccepted ? 'persisted-fallback' : 'safe-placeholder';
}
