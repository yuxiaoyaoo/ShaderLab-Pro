export interface NodePointerSelection {
  selection: string[];
  dragNodeIds: string[];
  selectionBefore: string[];
}

export function nodePointerSelection(
  selection: readonly string[],
  nodeId: string,
  additive: boolean,
): NodePointerSelection {
  const alreadySelected = selection.includes(nodeId);
  if (additive && alreadySelected) {
    return { selection: selection.filter((id) => id !== nodeId), dragNodeIds: [], selectionBefore: [...selection] };
  }
  const next = alreadySelected
    ? [...selection]
    : additive
      ? [...selection, nodeId]
      : [nodeId];
  return { selection: next, dragNodeIds: next, selectionBefore: [...selection] };
}

export function blankCanvasPointerSelection(
  selection: readonly string[],
  additive: boolean,
): { selection: string[]; selectionBefore: string[] } {
  return { selection: additive ? [...selection] : [], selectionBefore: [...selection] };
}

export const cancelledPointerSelection = (selectionBefore: readonly string[]): string[] => [...selectionBefore];
