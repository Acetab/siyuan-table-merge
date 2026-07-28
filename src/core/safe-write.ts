import {
  applyConflictChoices,
  ConflictChoice,
  InputTableCandidate,
  inspectInputTables,
  linkMultiset,
  MergeResult,
  mergeTables,
} from "./merge";
import {
  canonicalRow,
  MarkdownTable,
  renderWithRows,
  requireSingleTable,
  sameHeader,
  TableRow,
} from "./table";

export interface KernelApi {
  getBlockKramdown(blockId: string): Promise<string>;
  updateBlock(blockId: string, markdown: string): Promise<void>;
}

export interface BackupStore {
  saveBackup(blockId: string, markdown: string): Promise<string>;
}

export interface MergePreview {
  blockId: string;
  sourceMarkdown: string;
  sourceTableDigest: string;
  sourceTable: MarkdownTable;
  result: MergeResult;
}

export interface InputInspection {
  blockId: string;
  inputMarkdown: string;
  sourceMarkdown: string;
  sourceTableDigest: string;
  sourceTable: MarkdownTable;
  candidates: InputTableCandidate[];
}

export interface WriteReceipt {
  backupName: string;
  verifiedRowCount: number;
  verifiedLinkCount: number;
}

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

export async function digestText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tableContentSnapshot(table: MarkdownTable): string {
  return JSON.stringify({
    header: table.header.cells.map((cell) => cell.trim()),
    rows: table.rows.map((row) => row.cells.map((cell) => cell.trim())),
  });
}

async function digestTableContent(table: MarkdownTable): Promise<string> {
  return digestText(tableContentSnapshot(table));
}

export async function createPreview(
  api: KernelApi,
  blockId: string,
  inputMarkdown: string,
  selectedTableIndexes?: readonly number[],
): Promise<MergePreview> {
  const inspection = await inspectPreviewInput(api, blockId, inputMarkdown);
  return createPreviewFromInspection(inspection, selectedTableIndexes);
}

export async function inspectPreviewInput(
  api: KernelApi,
  blockId: string,
  inputMarkdown: string,
): Promise<InputInspection> {
  const sourceMarkdown = await api.getBlockKramdown(blockId);
  const {table} = requireSingleTable(sourceMarkdown, "目标块");
  return {
    blockId,
    inputMarkdown,
    sourceMarkdown,
    sourceTableDigest: await digestTableContent(table),
    sourceTable: table,
    candidates: inspectInputTables(table, inputMarkdown),
  };
}

export function createPreviewFromInspection(
  inspection: InputInspection,
  selectedTableIndexes?: readonly number[],
): MergePreview {
  return {
    blockId: inspection.blockId,
    sourceMarkdown: inspection.sourceMarkdown,
    sourceTableDigest: inspection.sourceTableDigest,
    sourceTable: inspection.sourceTable,
    result: mergeTables(
      inspection.sourceTable,
      inspection.inputMarkdown,
      selectedTableIndexes,
    ),
  };
}

function verifyRows(expected: TableRow[], actual: TableRow[]): void {
  if (actual.length !== expected.length) {
    throw new SafetyError(`写入后行数校验失败：预期 ${expected.length}，实际 ${actual.length}。备份已保留。`);
  }
  const expectedRows = expected.map(canonicalRow);
  const actualRows = actual.map(canonicalRow);
  if (!expectedRows.every((row, index) => row === actualRows[index])) {
    throw new SafetyError("写入后内容校验失败：表格行与预期不一致。备份已保留。");
  }
  const expectedLinks = linkMultiset(expected);
  const actualLinks = linkMultiset(actual);
  if (expectedLinks.length !== actualLinks.length
    || !expectedLinks.every((url, index) => url === actualLinks[index])) {
    throw new SafetyError("写入后链接集合校验失败。备份已保留。");
  }
}

const activeBlockWrites = new Set<string>();

function rebaseRowsOnLatest(
  result: MergeResult,
  latestRows: TableRow[],
  choices: Readonly<Record<string, ConflictChoice>>,
): TableRow[] {
  applyConflictChoices(result, choices);
  const rows = [...latestRows, ...result.additions];
  for (const conflict of result.conflicts) {
    if (choices[conflict.id] === "incoming") {
      rows[conflict.existingIndex] = conflict.incoming;
    } else if (choices[conflict.id] === "merge-source") {
      if (!conflict.mergedSource) {
        throw new SafetyError(`${conflict.id} 不支持合并来源。`);
      }
      rows[conflict.existingIndex] = conflict.mergedSource;
    }
  }
  return rows;
}

async function commitPreviewUnlocked(
  api: KernelApi,
  backups: BackupStore,
  preview: MergePreview,
  choices: Readonly<Record<string, ConflictChoice>>,
): Promise<WriteReceipt> {
  const latestMarkdown = await api.getBlockKramdown(preview.blockId);
  const latestParsed = requireSingleTable(latestMarkdown, "写入前的目标块");
  const latestDigest = await digestTableContent(latestParsed.table);
  if (latestDigest !== preview.sourceTableDigest) {
    throw new SafetyError("目标表格内容在预览后发生变化，已中止写入；请重新预览。");
  }

  const resolvedRows = rebaseRowsOnLatest(preview.result, latestParsed.table.rows, choices);
  const backupName = await backups.saveBackup(preview.blockId, latestMarkdown);
  const expectedMarkdown = renderWithRows(latestParsed.document, latestParsed.table, resolvedRows);
  await api.updateBlock(preview.blockId, expectedMarkdown);

  const writtenMarkdown = await api.getBlockKramdown(preview.blockId);
  const written = requireSingleTable(writtenMarkdown, "写入后的目标块").table;
  if (!sameHeader(preview.sourceTable, written)) {
    throw new SafetyError("写入后表头校验失败。备份已保留。");
  }
  verifyRows(resolvedRows, written.rows);

  return {
    backupName,
    verifiedRowCount: written.rows.length,
    verifiedLinkCount: linkMultiset(written.rows).length,
  };
}

export async function commitPreview(
  api: KernelApi,
  backups: BackupStore,
  preview: MergePreview,
  choices: Readonly<Record<string, ConflictChoice>>,
): Promise<WriteReceipt> {
  if (activeBlockWrites.has(preview.blockId)) {
    throw new SafetyError("该表格已有写入正在进行，请等待当前操作完成，不要重复确认。");
  }
  activeBlockWrites.add(preview.blockId);
  try {
    return await commitPreviewUnlocked(api, backups, preview, choices);
  } finally {
    activeBlockWrites.delete(preview.blockId);
  }
}
