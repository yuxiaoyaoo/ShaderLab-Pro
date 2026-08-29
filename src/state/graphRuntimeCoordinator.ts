import type { GraphArtifact } from '../graph/compiler/types';
import type { GraphEditorState } from './graphEditorStore';

export interface GraphRuntimeCandidate {
  artifact: GraphArtifact;
  generation: number;
  kind: 'current' | 'accepted-fallback';
}

export function selectGraphRuntimeCandidate(state: GraphEditorState): GraphRuntimeCandidate | null {
  const current = state.latestResult?.ok ? state.latestResult.artifact : undefined;
  if (current) return { artifact: current, generation: state.generation, kind: 'current' };
  if (state.runtimeAcceptedArtifact) {
    return { artifact: state.runtimeAcceptedArtifact, generation: state.generation, kind: 'accepted-fallback' };
  }
  return null;
}

export function shouldCommitGraphRuntimeCandidate(
  state: GraphEditorState,
  candidate: GraphRuntimeCandidate,
): boolean {
  return candidate.kind === 'current'
    && state.generation === candidate.generation
    && !!state.latestResult?.ok
    && state.latestResult.artifact?.revision === candidate.artifact.revision;
}

export const nextRuntimeSetupRevision = (current: number): number => current + 1;
export const isCurrentRuntimeSetupRevision = (request: number, current: number): boolean => request === current;

export interface GeneratedCodeSelection { source: string; accepted: boolean }

export function selectGeneratedCodeSource(state: GraphEditorState | undefined): GeneratedCodeSelection {
  if (state?.runtimeAcceptedArtifact) return { source: state.runtimeAcceptedArtifact.source, accepted: true };
  if (state?.lastSuccessfulArtifact) return { source: state.lastSuccessfulArtifact.source, accepted: false };
  return { source: '', accepted: false };
}
