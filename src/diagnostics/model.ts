import type { SrcPassId } from '../project/types';
import type { GraphSourceMap } from '../graph/compiler/sourceMap';
import { lookupGraphSource } from '../graph/compiler/sourceMap';
import type { Diagnostic as RuntimeDiagnostic } from '../shadertoy/runtime';
import type { ProductMessageParams } from '../productMessage';

export type DiagnosticOrigin =
  | { kind: 'code'; pass: SrcPassId; line: number; column: number }
  | {
      kind: 'graph';
      pass: SrcPassId;
      /** No target fields means the diagnostic belongs to the whole document. */
      nodeId?: string;
      socketId?: string;
      edgeId?: string;
      parameterId?: string;
    };

export type DiagnosticStage =
  | 'graph-schema'
  | 'graph-validate'
  | 'graph-typecheck'
  | 'glsl-compile'
  | 'runtime';

export interface UnifiedDiagnostic {
  message: string;
  severity: 'error' | 'warning' | 'info';
  stage: DiagnosticStage;
  origin: DiagnosticOrigin;
  code?: string;
  params?: ProductMessageParams;
  rawDetail?: string;
  relatedOrigins?: DiagnosticOrigin[];
}

const PASS_IDS = new Set<SrcPassId>([
  'common',
  'image',
  'bufferA',
  'bufferB',
  'bufferC',
  'bufferD',
  'sound',
]);

function runtimePass(pass: string | undefined): SrcPassId {
  return PASS_IDS.has(pass as SrcPassId) ? (pass as SrcPassId) : 'image';
}

export function fromRuntimeDiagnostic(diagnostic: RuntimeDiagnostic): UnifiedDiagnostic {
  return {
    message: diagnostic.message,
    severity: 'error',
    stage: diagnostic.stage ?? 'runtime',
    ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
    ...(diagnostic.params !== undefined ? { params: diagnostic.params } : {}),
    ...(diagnostic.rawDetail !== undefined ? { rawDetail: diagnostic.rawDetail } : {}),
    origin: {
      kind: 'code',
      pass: runtimePass(diagnostic.pass),
      line: Math.max(1, diagnostic.line),
      column: Math.max(1, diagnostic.column),
    },
  };
}

/** Optional Runtime identity. A mismatch deliberately disables Graph line mapping. */
export interface GraphDiagnosticMapExpectation {
  sourceHash?: string;
  revision?: string;
}

function sourceMapMatches(
  sourceMap: GraphSourceMap,
  expected: string | GraphDiagnosticMapExpectation | undefined,
): boolean {
  if (typeof expected === 'string') return sourceMap.sourceHash === expected;
  if (!expected) return true;
  return (expected.sourceHash === undefined || sourceMap.sourceHash === expected.sourceHash) &&
    (expected.revision === undefined || sourceMap.revision === expected.revision);
}

/** Maps a pass-local Runtime line through a fresh Graph source map, with Code origin fallback. */
export function fromRuntimeDiagnosticWithGraphSourceMap(
  diagnostic: RuntimeDiagnostic,
  sourceMap: GraphSourceMap | undefined,
  expected?: string | GraphDiagnosticMapExpectation,
): UnifiedDiagnostic {
  const pass = runtimePass(diagnostic.pass);
  const mapped = sourceMap && sourceMap.pass === pass && sourceMapMatches(sourceMap, expected)
    ? lookupGraphSource(sourceMap, Math.max(1, diagnostic.line))
    : undefined;
  if (!mapped) return fromRuntimeDiagnostic(diagnostic);
  return {
    message: diagnostic.message,
    severity: 'error',
    stage: diagnostic.stage ?? 'runtime',
    ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
    ...(diagnostic.params !== undefined ? { params: diagnostic.params } : {}),
    ...(diagnostic.rawDetail !== undefined ? { rawDetail: diagnostic.rawDetail } : {}),
    origin: {
      kind: 'graph',
      pass,
      nodeId: mapped.nodeId,
      ...(mapped.socketId ? { socketId: mapped.socketId } : {}),
    },
  };
}

export function fromRuntimeDiagnostics(diagnostics: RuntimeDiagnostic[]): UnifiedDiagnostic[] {
  return diagnostics.map(fromRuntimeDiagnostic);
}

export function fromRuntimeDiagnosticsWithGraphSourceMaps(
  diagnostics: RuntimeDiagnostic[],
  sourceMaps: Partial<Record<SrcPassId, GraphSourceMap>>,
  expected: Partial<Record<SrcPassId, string | GraphDiagnosticMapExpectation>> = {},
): UnifiedDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const pass = runtimePass(diagnostic.pass);
    return fromRuntimeDiagnosticWithGraphSourceMap(diagnostic, sourceMaps[pass], expected[pass]);
  });
}
