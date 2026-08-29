import type { UnifiedDiagnostic } from '../../diagnostics/model';
import type { GraphParameterValue, GraphPassId, GraphValueType } from '../model';
import type { TypedIrModule } from './ir';
import type { GraphSourceMap } from './sourceMap';

export type GeneratedUniformType = Exclude<GraphValueType, 'color3' | 'color4' | 'sdf3'>;

export interface GeneratedUniform {
  id: string;
  displayName: string;
  emittedName: string;
  type: GeneratedUniformType;
  defaultValue: GraphParameterValue;
  min?: number;
  max?: number;
  step?: number;
  widget: 'slider' | 'color' | 'number';
  pass: GraphPassId;
  nodeId: string;
}

export interface GraphArtifact {
  pass: GraphPassId;
  revision: string;
  /** Identity of pass-local Graph semantics plus the resolved channel environment. */
  semanticHash: string;
  channelEnvironmentRevision: string;
  textureEnvironmentRevision: string;
  libraryRevision: string;
  sourceHash: string;
  source: string;
  sourceMap: GraphSourceMap;
  uniforms: GeneratedUniform[];
}

export type GraphDiagnostic = UnifiedDiagnostic;

export interface GraphCompileResult {
  ok: boolean;
  source: string;
  sourceMap: GraphSourceMap;
  uniforms: GeneratedUniform[];
  diagnostics: GraphDiagnostic[];
  semanticHash: string;
  sourceHash: string;
  /** Present only after a complete Typed IR build, useful to M1 optimizers and tests. */
  ir?: TypedIrModule;
  /** Present only on success; stores can persist this contract directly in M2. */
  artifact?: GraphArtifact;
}
