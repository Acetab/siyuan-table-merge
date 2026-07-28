export interface TableSelectionEvidence {
  explicitBlockIds: string[];
  activeEditorIds: string[];
  rangeTableId?: string;
  lastInteractedTableId?: string;
}

export type TableSelectionResolution =
  | {kind: "one"; id: string}
  | {kind: "none"}
  | {kind: "multiple"; ids: string[]};

function unique(ids: readonly string[]): string[] {
  return ids.filter((id, index) => id.length > 0 && ids.indexOf(id) === index);
}

export function resolveTableSelection(evidence: TableSelectionEvidence): TableSelectionResolution {
  const explicit = unique(evidence.explicitBlockIds);
  if (explicit.length === 1) {
    return {kind: "one", id: explicit[0]};
  }
  if (explicit.length > 1) {
    return {kind: "multiple", ids: explicit};
  }

  if (evidence.rangeTableId) {
    return {kind: "one", id: evidence.rangeTableId};
  }

  const active = unique(evidence.activeEditorIds);
  if (evidence.lastInteractedTableId && active.includes(evidence.lastInteractedTableId)) {
    return {kind: "one", id: evidence.lastInteractedTableId};
  }
  if (active.length === 1) {
    return {kind: "one", id: active[0]};
  }
  if (active.length > 1) {
    return {kind: "multiple", ids: active};
  }

  if (evidence.lastInteractedTableId) {
    return {kind: "one", id: evidence.lastInteractedTableId};
  }
  return {kind: "none"};
}
