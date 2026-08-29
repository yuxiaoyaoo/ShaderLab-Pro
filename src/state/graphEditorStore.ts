import type { UnifiedDiagnostic } from '../diagnostics/model';
import { compileGraph, type CompileGraphOptions, type GraphArtifact, type GraphCompileResult } from '../graph/compiler/index';
import type { GraphDocument } from '../graph/model';
import { createGraphHistory, type GraphHistory } from '../graph/editor/history';
import type { ProjectSources } from '../project/types';

export type GraphEditorStatus = 'idle' | 'pending' | 'compiling' | 'ready' | 'stale';
export interface GraphEditorState { document: GraphDocument; selection: string[]; history: GraphHistory; latestResult?: GraphCompileResult; lastSuccessfulArtifact?: GraphArtifact; runtimeAcceptedArtifact?: GraphArtifact; runtimeDiagnostics: UnifiedDiagnostic[]; generation: number; status: GraphEditorStatus }

export function createGraphEditorState(document: GraphDocument): GraphEditorState { return { document, selection: [], history: createGraphHistory(), runtimeDiagnostics: [], generation: 0, status: 'pending' }; }
export function graphSemanticChanged(state: GraphEditorState, document: GraphDocument, history = state.history): GraphEditorState { return { ...state, document, history, latestResult: undefined, runtimeDiagnostics: [], generation: state.generation + 1, status: 'pending' }; }
export function graphLayoutChanged(state: GraphEditorState, document: GraphDocument, history = state.history): GraphEditorState { return { ...state, document, history }; }
export function graphCompileStarted(state: GraphEditorState, generation: number): GraphEditorState { return generation === state.generation ? { ...state, status: 'compiling' } : state; }
export function graphCompileResolved(state: GraphEditorState, generation: number, result: GraphCompileResult): GraphEditorState {
  if (generation !== state.generation) return state;
  if (!result.ok || !result.artifact) return { ...state, latestResult: result, runtimeDiagnostics: [], status: 'stale' };
  return { ...state, latestResult: result, lastSuccessfulArtifact: result.artifact, runtimeDiagnostics: [], status: 'compiling' };
}
export function graphRuntimeResolved(state: GraphEditorState, generation: number, revision: string, ok: boolean, diagnostics: UnifiedDiagnostic[] = []): GraphEditorState {
  if (generation !== state.generation || !state.latestResult?.ok || state.latestResult.artifact?.revision !== revision || state.lastSuccessfulArtifact?.revision !== revision) return state;
  if (!ok) return { ...state, runtimeDiagnostics: diagnostics, status: 'stale' };
  return { ...state, runtimeAcceptedArtifact: state.lastSuccessfulArtifact, runtimeDiagnostics: diagnostics, status: 'ready' };
}
export const graphDiagnostics = (state: GraphEditorState): UnifiedDiagnostic[] => [...(state.latestResult?.diagnostics ?? []), ...state.runtimeDiagnostics];
export const graphIsStale = (state: GraphEditorState, expectedLibraryRevision?: string): boolean => state.status !== 'ready'
  || (!!state.lastSuccessfulArtifact && state.runtimeAcceptedArtifact?.revision !== state.lastSuccessfulArtifact.revision)
  || !state.runtimeAcceptedArtifact
  || (expectedLibraryRevision !== undefined && state.runtimeAcceptedArtifact.libraryRevision !== expectedLibraryRevision);
export const graphCanExport = (state: GraphEditorState, expectedLibraryRevision?: string): boolean => !!state.runtimeAcceptedArtifact && !graphIsStale(state, expectedLibraryRevision);

export type GraphPersistenceArtifactSelection =
  | { ok: true; kind: 'runtime-accepted' | 'authoring-compiled'; artifact: GraphArtifact; diagnostics: UnifiedDiagnostic[] }
  | { ok: false; diagnostics: UnifiedDiagnostic[] };

/** Enabled Graphs require Runtime acceptance; disabled Graphs persist a deterministic authoring compile only. */
export function selectGraphPersistenceArtifact(
  state: GraphEditorState,
  runtimeAcceptanceRequired: boolean,
  options: CompileGraphOptions,
): GraphPersistenceArtifactSelection {
  if (runtimeAcceptanceRequired) {
    if (graphCanExport(state, options.libraryRevision) && state.runtimeAcceptedArtifact) {
      return { ok: true, kind: 'runtime-accepted', artifact: state.runtimeAcceptedArtifact, diagnostics: [] };
    }
    const diagnostics = graphDiagnostics(state);
    return {
      ok: false,
      diagnostics: diagnostics.length ? diagnostics : [{
        message: `${state.document.pass} Graph 尚未被同一 Runtime cohort 接受或处于 stale`,
        severity: 'error',
        stage: 'runtime',
        code: 'graph.runtime-acceptance-required',
        params: { pass: state.document.pass },
        origin: { kind: 'graph', pass: state.document.pass },
      }],
    };
  }

  const result = compileGraph(state.document, options);
  if (!result.ok || !result.artifact) return { ok: false, diagnostics: result.diagnostics };
  return { ok: true, kind: 'authoring-compiled', artifact: result.artifact, diagnostics: result.diagnostics };
}

export type GraphEditorStates = Partial<Record<GraphDocument['pass'], GraphEditorState>>;
export type GraphLibrarySemanticPatches = Partial<Record<GraphDocument['pass'], { document?: GraphDocument; history?: GraphHistory }>>;

/** Invalidates every pass because artifact identity includes the complete project Library revision. */
export function graphLibrarySemanticChanged(
  states: GraphEditorStates,
  patches: GraphLibrarySemanticPatches = {},
): GraphEditorStates {
  const next: GraphEditorStates = {};
  for (const [pass, state] of Object.entries(states) as Array<[GraphDocument['pass'], GraphEditorState]>) {
    const patch = patches[pass];
    next[pass] = graphSemanticChanged(state, patch?.document ?? state.document, patch?.history ?? state.history);
  }
  return next;
}

export function acceptedGeneratedSources(state: GraphEditorState | undefined): Partial<ProjectSources>;
export function acceptedGeneratedSources(states: GraphEditorStates): Partial<ProjectSources>;
export function acceptedGeneratedSources(input: GraphEditorState | GraphEditorStates | undefined): Partial<ProjectSources> {
  if (!input) return {};
  if ('document' in input) {
    return input.runtimeAcceptedArtifact ? { [input.document.pass]: input.runtimeAcceptedArtifact.source } : {};
  }
  const result: Partial<ProjectSources> = {};
  for (const pass of ['image', 'bufferA', 'bufferB', 'bufferC', 'bufferD', 'sound'] as const) {
    const artifact = input[pass]?.runtimeAcceptedArtifact;
    if (artifact) result[pass] = artifact.source;
  }
  return result;
}

/** Atomically promotes exactly one Runtime-accepted multi-pass cohort. */
export function acceptGraphCohort(
  states: GraphEditorStates,
  candidates: Partial<Record<GraphDocument['pass'], { generation: number; artifact: GraphArtifact }>>,
  ok: boolean,
  diagnostics: Partial<Record<GraphDocument['pass'], UnifiedDiagnostic[]>> = {},
): GraphEditorStates {
  if (!ok) {
    const failed: GraphEditorStates = { ...states };
    for (const pass of Object.keys(candidates) as GraphDocument['pass'][]) {
      const candidate = candidates[pass];
      const state = states[pass];
      if (candidate && state) failed[pass] = graphRuntimeResolved(state, candidate.generation, candidate.artifact.revision, false, diagnostics[pass] ?? []);
    }
    return failed;
  }
  for (const pass of Object.keys(candidates) as GraphDocument['pass'][]) {
    const candidate = candidates[pass];
    const state = states[pass];
    if (!candidate || !state || candidate.generation !== state.generation || state.lastSuccessfulArtifact?.revision !== candidate.artifact.revision) return states;
  }
  const accepted: GraphEditorStates = { ...states };
  for (const pass of Object.keys(candidates) as GraphDocument['pass'][]) {
    const candidate = candidates[pass]!;
    accepted[pass] = graphRuntimeResolved(states[pass]!, candidate.generation, candidate.artifact.revision, true, diagnostics[pass] ?? []);
  }
  return accepted;
}

export const graphCohortReady = (
  states: GraphEditorStates,
  enabledGraphPasses: readonly GraphDocument['pass'][],
  expectedLibraryRevision?: string,
): boolean => enabledGraphPasses.every((pass) => !!states[pass] && graphCanExport(states[pass]!, expectedLibraryRevision));

export function detachAcceptedGraph(state: GraphEditorState, expectedLibraryRevision?: string): { source: string } | null {
  return graphCanExport(state, expectedLibraryRevision) && state.runtimeAcceptedArtifact ? { source: state.runtimeAcceptedArtifact.source } : null;
}
