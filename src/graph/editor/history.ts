import type { GraphDocument } from '../model';
import { applyGraphCommand, type GraphCommand, type GraphCommandContext, type GraphCommandImpact } from './commands';

export interface GraphHistoryEntry { command: GraphCommand; before: GraphDocument; after: GraphDocument; impact: GraphCommandImpact }
export interface GraphHistory { undo: GraphHistoryEntry[]; redo: GraphHistoryEntry[]; limit: number }
export interface GraphHistoryResult { document: GraphDocument; history: GraphHistory; impact?: GraphCommandImpact; changed: boolean }

export const createGraphHistory = (limit = 100): GraphHistory => ({ undo: [], redo: [], limit });

export function executeGraphCommand(
  document: GraphDocument,
  history: GraphHistory,
  command: GraphCommand,
  context: GraphCommandContext = {},
): GraphHistoryResult {
  const applied = applyGraphCommand(document, command, context);
  if (!applied.changed) return { document, history, impact: applied.impact, changed: false };
  const entry: GraphHistoryEntry = { command, before: document, after: applied.document, impact: applied.impact };
  return { document: applied.document, history: { ...history, undo: [...history.undo, entry].slice(-history.limit), redo: [] }, impact: applied.impact, changed: true };
}

export function undoGraphCommand(document: GraphDocument, history: GraphHistory): GraphHistoryResult {
  const entry = history.undo.at(-1);
  if (!entry) return { document, history, changed: false };
  return { document: entry.before, history: { ...history, undo: history.undo.slice(0, -1), redo: [...history.redo, entry] }, impact: entry.impact, changed: true };
}

export function redoGraphCommand(document: GraphDocument, history: GraphHistory): GraphHistoryResult {
  const entry = history.redo.at(-1);
  if (!entry) return { document, history, changed: false };
  return { document: entry.after, history: { ...history, undo: [...history.undo, entry].slice(-history.limit), redo: history.redo.slice(0, -1) }, impact: entry.impact, changed: true };
}
