import type { GraphPassId } from '../model';
import { deterministicHash } from './hash';

export interface GraphSourceMapEntry {
  startLine: number;
  endLine: number;
  nodeId: string;
  socketId?: string;
}

export interface GraphSourceMapIdentity {
  semanticHash: string;
  sourceHash: string;
  revision: string;
}

export interface GraphSourceMap extends GraphSourceMapIdentity {
  version: 1;
  pass: GraphPassId;
  entries: GraphSourceMapEntry[];
}

export function createEmptySourceMap(
  pass: GraphPassId = 'image',
  semanticHash = deterministicHash('invalid-graph'),
): GraphSourceMap {
  const sourceHash = deterministicHash('');
  return { version: 1, pass, semanticHash, sourceHash, revision: semanticHash, entries: [] };
}

export function lookupGraphSource(
  sourceMap: GraphSourceMap,
  line: number,
): GraphSourceMapEntry | undefined {
  if (!Number.isInteger(line) || line < 1) return undefined;
  return sourceMap.entries.find((entry) => line >= entry.startLine && line <= entry.endLine);
}
