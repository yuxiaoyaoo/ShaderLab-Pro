import type { ProductMessageDescriptor, ProductMessageParams } from '../productMessage';

export type ExportAuthoring = 'code' | 'graph';
export type ExportCompileStatus = 'idle' | 'pending' | 'compiling' | 'ready' | 'stale';

export interface ExportRequirements {
  readonly visual: boolean;
  readonly sound: boolean;
}

export interface ExportGraphArtifactIdentity {
  readonly pass: 'image' | 'bufferA' | 'bufferB' | 'bufferC' | 'bufferD' | 'sound';
  readonly generation: number;
  readonly revision: string;
  readonly sourceHash: string;
}

export interface ExportEligibilityInput {
  authoring: ExportAuthoring;
  /** Legacy single-lane revision retained for M0-M5 callers. */
  runtimeSetupRevision: number;
  visualRuntimeSetupRevision?: number;
  soundRuntimeSetupRevision?: number;
  /** Legacy Visual lane revision retained for M0-M5 callers. */
  successfulRuntimeSetupRevision?: number;
  successfulVisualRuntimeSetupRevision?: number;
  successfulSoundRuntimeSetupRevision?: number;
  compileStatus: ExportCompileStatus;
  hasCompileError: boolean;
  hasUniformConflict: boolean;
  requirements?: ExportRequirements;
  /** Legacy single-Image identity retained for M0-M4 callers. */
  graphGeneration?: number;
  graphArtifactRevision?: string;
  graphSourceHash?: string;
  graphArtifacts?: readonly ExportGraphArtifactIdentity[];
  passGraphRevision?: string;
  effectiveSourcesHash?: string;
  graphAccepted: boolean;
}

export interface ExportTicket {
  readonly runtimeSetupRevision: number;
  readonly visualRuntimeSetupRevision?: number;
  readonly soundRuntimeSetupRevision?: number;
  readonly authoring: ExportAuthoring;
  readonly requirements: ExportRequirements;
  readonly graphGeneration?: number;
  readonly graphArtifactRevision?: string;
  readonly graphSourceHash?: string;
  readonly graphArtifacts?: readonly ExportGraphArtifactIdentity[];
  readonly passGraphRevision?: string;
  readonly effectiveSourcesHash?: string;
}

export interface ExportEligibility {
  eligible: boolean;
  reason?: ProductMessageDescriptor;
  ticket?: ExportTicket;
}

const blocked = (
  code: string,
  fallback: string,
  params?: ProductMessageParams,
): ExportEligibility => ({ eligible: false, reason: { code, ...(params ? { params } : {}), fallback } });

const DEFAULT_REQUIREMENTS: ExportRequirements = Object.freeze({ visual: true, sound: false });

export function exportEligibility(input: ExportEligibilityInput): ExportEligibility {
  const requirements = input.requirements ?? DEFAULT_REQUIREMENTS;
  if (!requirements.visual && !requirements.sound) return blocked('export.requirements-missing', '导出未声明 Visual 或 Sound 需求');
  if (input.hasUniformConflict) return blocked('export.uniform-conflict', '所需 Runtime 域存在 Uniform 类型冲突');
  if (input.hasCompileError) return blocked('export.compile-errors', '所需 Runtime 域当前仍有编译错误');
  if (input.compileStatus !== 'ready') return blocked('export.compile-status', `所需 Runtime 域编译状态为 ${input.compileStatus}`, { status: input.compileStatus });
  const visualRevision = input.visualRuntimeSetupRevision ?? input.runtimeSetupRevision;
  const soundRevision = input.soundRuntimeSetupRevision ?? input.runtimeSetupRevision;
  const successfulVisualRevision = input.successfulVisualRuntimeSetupRevision ?? input.successfulRuntimeSetupRevision;
  if (requirements.visual && successfulVisualRevision !== visualRevision) {
    return blocked('export.visual-runtime-not-ready', '当前 Visual Runtime setup 尚未成功编译');
  }
  if (requirements.sound && input.successfulSoundRuntimeSetupRevision !== soundRevision) {
    return blocked('export.sound-runtime-not-ready', '当前 Sound Runtime setup 尚未成功编译');
  }
  const graphArtifacts = input.graphArtifacts ?? [];
  const needsPassGraphIdentity = graphArtifacts.some((item) => item.pass !== 'sound');
  const multiGraphIdentityValid = graphArtifacts.length > 0
    && (!needsPassGraphIdentity || !!input.passGraphRevision)
    && !!input.effectiveSourcesHash
    && graphArtifacts.every((item) => Number.isInteger(item.generation) && !!item.revision && !!item.sourceHash);
  const legacyGraphIdentityValid = input.graphGeneration !== undefined && !!input.graphArtifactRevision && !!input.graphSourceHash;
  if (input.authoring === 'graph' && (!input.graphAccepted || (!multiGraphIdentityValid && !legacyGraphIdentityValid))) {
    return blocked('export.graph-not-accepted', '所需 Graph cohort 尚未被对应 Runtime 域接受');
  }
  const frozenArtifacts = graphArtifacts.length
    ? Object.freeze([...graphArtifacts].sort((a, b) => a.pass.localeCompare(b.pass)).map((item) => Object.freeze({ ...item })))
    : undefined;
  const ticket: ExportTicket = Object.freeze({
    runtimeSetupRevision: input.runtimeSetupRevision,
    ...(requirements.visual ? { visualRuntimeSetupRevision: visualRevision } : {}),
    ...(requirements.sound ? { soundRuntimeSetupRevision: soundRevision } : {}),
    authoring: input.authoring,
    requirements: Object.freeze({ ...requirements }),
    ...(input.passGraphRevision ? { passGraphRevision: input.passGraphRevision } : {}),
    ...(input.effectiveSourcesHash ? { effectiveSourcesHash: input.effectiveSourcesHash } : {}),
    ...(input.authoring === 'graph' && multiGraphIdentityValid ? {
      graphArtifacts: frozenArtifacts,
    } : input.authoring === 'graph' ? {
      graphGeneration: input.graphGeneration,
      graphArtifactRevision: input.graphArtifactRevision,
      graphSourceHash: input.graphSourceHash,
    } : {}),
  });
  return { eligible: true, ticket };
}

export function validateExportTicket(ticket: ExportTicket, input: ExportEligibilityInput): ExportEligibility {
  const current = exportEligibility({ ...input, requirements: ticket.requirements });
  if (!current.eligible || !current.ticket) return current;
  return JSON.stringify(ticket) === JSON.stringify(current.ticket)
    ? current
    : blocked('export.ticket-expired', '导出 ticket 已失效；项目或所需 Runtime 域 revision 已变化');
}

export const guardedExportStart = <T>(ticket: ExportTicket, input: ExportEligibilityInput, start: () => T): T | undefined =>
  validateExportTicket(ticket, input).eligible ? start() : undefined;
