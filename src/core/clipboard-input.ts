import {MarkdownTable, parseMarkdown, splitTableRow, TableParseError} from "./table";

function normalizedHeaderCell(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

export function automaticHeaderMapping(
  source: readonly string[],
  target: readonly string[],
): number[] | null {
  if (source.length !== target.length) {
    return null;
  }
  const normalizedTarget = target.map(normalizedHeaderCell);
  if (new Set(normalizedTarget).size !== normalizedTarget.length) {
    return null;
  }
  const mapping = source.map((header) => normalizedTarget.indexOf(normalizedHeaderCell(header)));
  return mapping.every((index) => index >= 0) && new Set(mapping).size === target.length
    ? mapping
    : null;
}

function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const renderRow = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [
    renderRow(header),
    renderRow(header.map(() => "---")),
    ...rows.map(renderRow),
  ].join("\n");
}

function requireConsistentWidth(
  rows: readonly (readonly string[])[],
  label: string,
): number {
  if (rows.length === 0) {
    throw new TableParseError(`${label}中没有可用的数据行。`);
  }
  const expected = rows[0].length;
  const mismatched = rows.findIndex((cells) => cells.length !== expected);
  if (mismatched >= 0) {
    throw new TableParseError(
      `${label}第 ${mismatched + 1} 行有 ${rows[mismatched].length} 列，与首行 ${expected} 列不一致。`,
    );
  }
  return expected;
}

export function renderClipboardRows(
  rows: readonly (readonly string[])[],
): string {
  requireConsistentWidth(rows, "剪贴板");
  return rows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

export function renderClipboardTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (header.length === 0 || rows.length === 0) {
    throw new TableParseError("剪贴板表格缺少表头或数据行。");
  }
  if (requireConsistentWidth(rows, "剪贴板表格") !== header.length) {
    throw new TableParseError("剪贴板表格的数据行与表头列数不一致。");
  }
  return renderTable(header, rows);
}

export function parseRowOnlyInput(
  input: string,
): string[][] | null {
  if (parseMarkdown(input).tables.length > 0) {
    return null;
  }

  const lines = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new TableParseError("输入内容中没有识别到 Markdown 表格或数据行。");
  }

  const allTsv = lines.every((line) => line.includes("\t"));
  const allPipeRows = lines.every((line) => line.includes("|"));
  if (!allTsv && !allPipeRows) {
    throw new TableParseError(
      "输入内容中没有完整 Markdown 表格；仅数据行模式需要使用竖线或 Tab 分隔各列。",
    );
  }

  const rows = lines.map((line) => allTsv
    ? line.split("\t").map((cell) => cell.trim())
    : splitTableRow(line));
  requireConsistentWidth(rows, "输入内容");
  return rows;
}

export interface SelectableInputRows {
  sourceHeader?: string[];
  rows: string[][];
}

export function columnCountMismatchMessage(
  sourceWidth: number,
  targetHeader: readonly string[],
  sourceHeader?: readonly string[],
): string {
  const targetWidth = targetHeader.length;
  const difference = sourceWidth - targetWidth;
  const relation = difference < 0
    ? `比目标少 ${Math.abs(difference)} 列`
    : `比目标多 ${difference} 列`;
  const sourceDescription = sourceHeader
    ? `复制内容表头：${sourceHeader.map((cell) => cell.trim() || "（空）").join(" ｜ ")}。`
    : "";
  return [
    `复制内容识别到 ${sourceWidth} 个数据列，目标表格有 ${targetWidth} 个数据列（${relation}）。`,
    sourceDescription,
    `目标表头：${targetHeader.map((cell) => cell.trim() || "（空）").join(" ｜ ")}。`,
    "界面中的“选择”和“行号”是辅助列，不计入数据列数；当前仅支持一一对应映射。",
  ].filter(Boolean).join(" ");
}

export function parseSelectableInputRows(
  input: string,
  firstRowIsHeader: boolean,
): SelectableInputRows | null {
  const parsed = parseMarkdown(input);
  if (parsed.tables.length > 1) {
    return null;
  }
  if (parsed.tables.length === 1) {
    const table = parsed.tables[0];
    return firstRowIsHeader
      ? {
        sourceHeader: [...table.header.cells],
        rows: table.rows.map((row) => [...row.cells]),
      }
      : {
        rows: [
          [...table.header.cells],
          ...table.rows.map((row) => [...row.cells]),
        ],
      };
  }

  const rows = parseRowOnlyInput(input);
  if (!rows) {
    return null;
  }
  if (!firstRowIsHeader) {
    return {rows};
  }
  if (rows.length < 2) {
    // A lone pipe/TSV row cannot provide both a header and data. It is much
    // more likely to be a copied data row, so keep it selectable instead of
    // falling through to the unrelated full-Markdown-table error path.
    return {rows};
  }
  return {
    sourceHeader: [...rows[0]],
    rows: rows.slice(1).map((cells) => [...cells]),
  };
}

export function renderMappedRowsForTarget(
  target: MarkdownTable,
  rows: readonly (readonly string[])[],
  sourceToTarget: readonly number[],
): string {
  const sourceWidth = requireConsistentWidth(rows, "输入内容");
  const targetWidth = target.header.cells.length;
  if (sourceWidth !== targetWidth) {
    throw new TableParseError(columnCountMismatchMessage(sourceWidth, target.header.cells));
  }
  if (sourceToTarget.length !== sourceWidth) {
    throw new TableParseError("列映射不完整，请为每个源列选择一个目标列。");
  }
  const selected = new Set(sourceToTarget);
  if (
    selected.size !== targetWidth
    || sourceToTarget.some((index) => !Number.isInteger(index) || index < 0 || index >= targetWidth)
  ) {
    throw new TableParseError("列映射必须一一对应，不能遗漏目标列或重复映射。");
  }

  const mappedRows = rows.map((sourceCells) => {
    const targetCells = Array<string>(targetWidth);
    sourceCells.forEach((cell, sourceIndex) => {
      targetCells[sourceToTarget[sourceIndex]] = cell;
    });
    return targetCells;
  });
  return renderTable(target.header.cells, mappedRows);
}
