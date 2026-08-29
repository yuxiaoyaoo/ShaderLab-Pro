import { ProductError, type ProductMessageParams } from '../productMessage';
import { compileGraph, type CompileGraphOptions } from '../graph/compiler/index';
import { deterministicHash } from '../graph/compiler/hash';
import type { GraphArtifact } from '../graph/compiler/types';
import type { DiagnosticOrigin, DiagnosticStage, UnifiedDiagnostic } from '../diagnostics/model';
import {
  CURRENT_GRAPH_VERSION,
  type GraphDocument,
  type GraphPassId,
} from '../graph/model';
import { normalizeGraphDocument } from '../graph/schema';

export type ProjectGraphDocuments = Partial<Record<GraphPassId, GraphDocument>>;
export type ProjectGraphArtifacts = Partial<Record<GraphPassId, GraphArtifact>>;

export interface GraphProjectIssue {
  pass: GraphPassId;
  severity: 'warning' | 'error';
  /** Persisted Graph/compiler diagnostic code. Compiler codes are preserved verbatim. */
  code: string;
  message: string;
  params?: ProductMessageParams;
  rawDetail?: string;
  path?: string;
  stage?: DiagnosticStage;
  origin?: DiagnosticOrigin;
  relatedOrigins?: DiagnosticOrigin[];
}

export interface ParsedGraphDocument {
  document?: GraphDocument;
  issues: GraphProjectIssue[];
}

function graphIssueCode(code: string): string {
  return code;
}

function graphCompileIssue(pass: GraphPassId, diagnostic: UnifiedDiagnostic): GraphProjectIssue {
  return {
    pass,
    severity: diagnostic.severity === 'error' ? 'error' : 'warning',
    code: diagnostic.code ?? 'graph.invalid',
    message: diagnostic.message,
    ...(diagnostic.params ? { params: diagnostic.params } : {}),
    ...(diagnostic.rawDetail ? { rawDetail: diagnostic.rawDetail } : {}),
    stage: diagnostic.stage,
    origin: diagnostic.origin,
    ...(diagnostic.relatedOrigins ? { relatedOrigins: diagnostic.relatedOrigins } : {}),
  };
}

/** Preserves compiler validation/type diagnostics for schema-valid persisted Graphs. */
export function inspectGraphCompilation(
  pass: GraphPassId,
  document: GraphDocument,
  options: CompileGraphOptions = {},
): GraphProjectIssue[] {
  const compiled = compileGraph(document, options);
  return compiled.ok && compiled.artifact
    ? []
    : compiled.diagnostics.map((diagnostic) => graphCompileIssue(pass, diagnostic));
}

/** Project paths are always portable, relative, and traversal-free. */
export function isSafeProjectRelativePath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** Canonical Graph v1 serialization after schema normalization. */
export function serializeGraphDocument(value: unknown): string {
  const normalized = normalizeGraphDocument(value);
  if (!normalized.ok || !normalized.document) {
    const first = normalized.diagnostics[0];
    throw new ProductError({
      code: 'graph.serialize-failed',
      params: { count: normalized.diagnostics.length },
      fallback: 'Graph 文档无法序列化',
      ...(first?.rawDetail !== undefined ? { rawDetail: first.rawDetail } : {}),
    }, { cause: normalized.diagnostics });
  }
  return `${JSON.stringify(normalized.document, null, 2)}\n`;
}

/** JSON parse -> validate -> migrate -> normalize. V1 migration is currently identity. */
export function parseProjectGraph(
  text: string,
  pass: GraphPassId,
): ParsedGraphDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      issues: [{
        pass,
        severity: 'error',
        code: 'graph.invalid-json',
        message: 'Graph JSON 损坏',
        rawDetail: error instanceof Error ? error.message : String(error),
        path: '$',
      }],
    };
  }

  // normalizeGraphDocument performs strict validation, explicit V1 migration, and
  // returns a normalized document without ever manufacturing an empty graph on error.
  const result = normalizeGraphDocument(raw);
  if (!result.ok || !result.document) {
    return {
      issues: result.diagnostics.map((diagnostic) => ({
        pass,
        severity: 'error' as const,
        code: graphIssueCode(diagnostic.code),
        message: diagnostic.message,
        ...(diagnostic.params ? { params: diagnostic.params } : {}),
        ...(diagnostic.rawDetail ? { rawDetail: diagnostic.rawDetail } : {}),
        path: diagnostic.path,
      })),
    };
  }
  if (result.document.pass !== pass) {
    return {
      issues: [{
        pass,
        severity: 'error',
        code: 'graph.pass-mismatch',
        message: `Graph 声明为 ${result.document.pass}，但项目 Pass 为 ${pass}`,
        params: { actual: result.document.pass, expected: pass },
        path: '$.pass',
      }],
    };
  }
  return { document: result.document, issues: [] };
}

export interface ValidatedGraphSave {
  document: GraphDocument;
  artifact: GraphArtifact;
  serializedDocument: string;
}

/**
 * Enforces the M3 save contract. The artifact must be the exact compiler output
 * for the current document; App additionally supplies only Runtime-accepted artifacts.
 */
export function validateGraphSave(
  pass: GraphPassId,
  document: GraphDocument | undefined,
  artifact: GraphArtifact | undefined,
  options: CompileGraphOptions = {},
): ValidatedGraphSave {
  if (!document) throw new ProductError({ code: 'graph.document-missing', params: { pass }, fallback: `Graph Pass ${pass} 缺少 GraphDocument，拒绝保存` });
  if (!artifact) throw new ProductError({ code: 'graph.artifact-missing', params: { pass }, fallback: `Graph Pass ${pass} 缺少 Runtime accepted artifact，拒绝保存` });
  if (artifact.pass !== pass) throw new ProductError({ code: 'graph.artifact-pass-mismatch', params: { pass }, fallback: `Graph Pass ${pass} artifact pass 不匹配，拒绝保存` });
  const parsed = parseProjectGraph(serializeGraphDocument(document), pass);
  if (!parsed.document) {
    const first = parsed.issues[0];
    throw new ProductError({
      code: 'graph.invalid',
      params: { pass, count: parsed.issues.length },
      fallback: `Graph Pass ${pass} 文档无效`,
      ...(first?.rawDetail !== undefined ? { rawDetail: first.rawDetail } : {}),
    }, { cause: parsed.issues });
  }
  if (deterministicHash(artifact.source) !== artifact.sourceHash) {
    throw new ProductError({ code: 'graph.artifact-hash-mismatch', params: { pass }, fallback: `Graph Pass ${pass} artifact sourceHash 与源码不一致，拒绝保存` });
  }
  const compiled = compileGraph(parsed.document, options);
  if (!compiled.ok || !compiled.artifact) {
    const first = compiled.diagnostics[0];
    throw new ProductError({
      code: first?.code ?? 'graph.compile-failed',
      ...(first?.params ? { params: first.params } : { params: { pass } }),
      ...(first?.rawDetail !== undefined ? { rawDetail: first.rawDetail } : {}),
      fallback: first?.message ?? `Graph Pass ${pass} 当前文档无法编译，拒绝保存`,
    }, { cause: compiled.diagnostics });
  }
  if (
    compiled.artifact.sourceHash !== artifact.sourceHash
    || compiled.artifact.revision !== artifact.revision
    || compiled.artifact.source !== artifact.source
  ) {
    throw new ProductError({ code: 'graph.artifact-stale', params: { pass }, fallback: `Graph Pass ${pass} 的 accepted artifact 已过期或与当前文档不一致，拒绝保存` });
  }
  return {
    document: parsed.document,
    artifact,
    serializedDocument: serializeGraphDocument(parsed.document),
  };
}

export function inspectPersistedGraph(
  pass: GraphPassId,
  document: GraphDocument,
  graphFormatVersion: number,
  generatedHash: string | undefined,
  fallbackSource: string,
  options: CompileGraphOptions = {},
): GraphProjectIssue[] {
  const issues: GraphProjectIssue[] = [];
  if (graphFormatVersion !== document.version || graphFormatVersion !== CURRENT_GRAPH_VERSION) {
    issues.push({
      pass,
      severity: 'warning',
      code: 'graph.format-version-mismatch',
      message: `项目记录的 Graph 版本 ${graphFormatVersion} 与文档版本 ${document.version} 不一致`,
      params: { version: graphFormatVersion, documentVersion: document.version },
      path: '$.version',
    });
  }
  const fallbackHash = deterministicHash(fallbackSource);
  if (!generatedHash) {
    issues.push({
      pass,
      severity: 'warning',
      code: 'graph.generated-hash-missing',
      message: '项目缺少 generatedHash，需要重新保存',
    });
  } else if (generatedHash !== fallbackHash) {
    issues.push({
      pass,
      severity: 'warning',
      code: 'graph.generated-hash-mismatch',
      message: `generatedHash 与持久化 GLSL fallback 不一致（记录 ${generatedHash}，实际 ${fallbackHash}）`,
      params: { recorded: generatedHash, actual: fallbackHash },
    });
  }
  const compiled = compileGraph(document, options);
  if (!compiled.ok || !compiled.artifact) {
    issues.push(...compiled.diagnostics.map((diagnostic) => graphCompileIssue(pass, diagnostic)));
  } else if (compiled.artifact.sourceHash !== fallbackHash) {
    issues.push({
      pass,
      severity: 'warning',
      code: 'graph.generated-source-mismatch',
      message: 'Graph 当前生成结果与持久化 GLSL fallback 不一致，需要重新编译并保存',
    });
  }
  return issues;
}
