import {
  canonicalRow,
  MarkdownTable,
  parseMarkdown,
  sameHeader,
  TableParseError,
  TableRow,
} from "./table";

export interface LinkReference {
  label: string;
  url: string;
  key: string;
}

export interface CellDifference {
  column: number;
  header: string;
  original: string;
  incoming: string;
}

export interface MergeConflict {
  id: string;
  keys: string[];
  existingIndex: number;
  existing: TableRow;
  incoming: TableRow;
  differences: CellDifference[];
  mergedSource?: TableRow;
}

export interface MergeNotice {
  type: "same-name-different-link";
  name: string;
  match: "exact" | "normalized";
  incoming: TableRow;
}

export interface MergeResult {
  originalRows: TableRow[];
  mergedRows: TableRow[];
  additions: TableRow[];
  duplicates: TableRow[];
  conflicts: MergeConflict[];
  notices: MergeNotice[];
  inputRowCount: number;
}

export interface InputTableCandidate {
  index: number;
  startLine: number;
  endLine: number;
  rowCount: number;
  header: string[];
  headingPath: string[];
  matchesTarget: boolean;
  previewRows: TableRow[];
}

export type ConflictChoice = "original" | "incoming" | "merge-source";

function linkKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const shareMatch = parsed.pathname.match(/\/s\/([^/?#]+)/);
    if (shareMatch && (host === "pan.baidu.com" || host.endsWith(".pan.baidu.com"))) {
      return `baidu:${shareMatch[1]}`;
    }
    if (shareMatch && (host === "pan.quark.cn" || host.endsWith(".pan.quark.cn"))) {
      return `quark:${shareMatch[1]}`;
    }
  } catch {
    // Keep the full original URL as its identity if URL parsing rejects it.
  }
  return `url:${url}`;
}

function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,;!?，。；！？]+$/u, "");
}

export function extractLinkReferences(row: TableRow): LinkReference[] {
  const references: LinkReference[] = [];
  const seen = new Set<string>();
  const markdownRanges: Array<[number, number]> = [];
  const markdownPattern = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/gu;

  for (const cell of row.cells) {
    markdownPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = markdownPattern.exec(cell)) !== null) {
      const url = trimUrlPunctuation(match[2]);
      const identity = `${match[1]}\u0000${url}`;
      if (!seen.has(identity)) {
        references.push({label: match[1], url, key: linkKey(url)});
        seen.add(identity);
      }
      markdownRanges.push([match.index, match.index + match[0].length]);
    }

    const barePattern = /https?:\/\/[^\s<>\]]+/gu;
    while ((match = barePattern.exec(cell)) !== null) {
      const insideMarkdown = markdownRanges.some(([start, end]) => match!.index >= start && match!.index < end);
      if (insideMarkdown) {
        continue;
      }
      const url = trimUrlPunctuation(match[0].replace(/[)]+$/u, ""));
      const identity = `\u0000${url}`;
      if (!seen.has(identity)) {
        references.push({label: "", url, key: linkKey(url)});
        seen.add(identity);
      }
    }
    markdownRanges.length = 0;
  }
  return references;
}

export function extractLinkKeys(row: TableRow): string[] {
  return [...new Set(extractLinkReferences(row).map((reference) => reference.key))];
}

export function extractUrls(row: TableRow): string[] {
  return [...new Set(extractLinkReferences(row).map((reference) => reference.url))];
}

function rowIdentityKeys(row: TableRow): string[] {
  const keys = extractLinkKeys(row);
  return keys.length > 0 ? keys : [`row:${canonicalRow(row)}`];
}

function differences(header: MarkdownTable, original: TableRow, incoming: TableRow): CellDifference[] {
  const result: CellDifference[] = [];
  for (let index = 0; index < header.header.cells.length; index += 1) {
    const originalCell = original.cells[index]?.trim() ?? "";
    const incomingCell = incoming.cells[index]?.trim() ?? "";
    if (originalCell !== incomingCell) {
      result.push({
        column: index,
        header: header.header.cells[index].trim(),
        original: originalCell,
        incoming: incomingCell,
      });
    }
  }
  return result;
}

function headingPathAtLine(lines: readonly string[], lineIndex: number): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (let index = 0; index < lineIndex; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (!match) {
      continue;
    }
    const level = match[1].length;
    headings.length = level - 1;
    headings[level - 1] = match[2].trim();
  }
  return headings.filter(Boolean);
}

function displayNoticeName(label: string): string {
  return label
    .normalize("NFKC")
    .replace(
      /\s*[(（]\s*(?:百度|夸克)\s*[·•]\s*(?:…|\.\.\.)?[\p{L}\p{N}_-]+\s*[)）]\s*$/u,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeNoticeName(label: string): string {
  return displayNoticeName(label).toLocaleLowerCase("zh-CN");
}

function replaceCell(row: TableRow, column: number, value: string): TableRow {
  const cells = [...row.cells];
  cells[column] = value;

  const raw = row.rawLine;
  const leadingWhitespace = raw.match(/^\s*/u)?.[0].length ?? 0;
  const trailingWhitespace = raw.match(/\s*$/u)?.[0].length ?? 0;
  let bodyStart = leadingWhitespace;
  let bodyEnd = raw.length - trailingWhitespace;
  if (raw[bodyStart] === "|") {
    bodyStart += 1;
  }
  if (bodyEnd > bodyStart && raw[bodyEnd - 1] === "|") {
    bodyEnd -= 1;
  }

  const spans: Array<[number, number]> = [];
  let start = bodyStart;
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    if (raw[index] !== "|") {
      continue;
    }
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= bodyStart && raw[cursor] === "\\"; cursor -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) {
      spans.push([start, index]);
      start = index + 1;
    }
  }
  spans.push([start, bodyEnd]);
  const span = spans[column];
  if (!span) {
    return {cells, rawLine: `| ${cells.join(" | ")} |`};
  }

  const original = raw.slice(span[0], span[1]);
  const leftPadding = original.match(/^\s*/u)?.[0] ?? "";
  const rightPadding = original.match(/\s*$/u)?.[0] ?? "";
  return {
    cells,
    rawLine: `${raw.slice(0, span[0])}${leftPadding}${value}${rightPadding}${raw.slice(span[1])}`,
  };
}

function mergeSourceValues(original: string, incoming: string): string {
  const left = original.trim();
  const right = incoming.trim();
  if (!left) {
    return right;
  }
  if (!right || left === right) {
    return left;
  }
  if (left.includes(right)) {
    return left;
  }
  if (right.includes(left)) {
    return right;
  }
  return `${left}；${right}`;
}

function mergedSourceRow(
  header: MarkdownTable,
  original: TableRow,
  incoming: TableRow,
): TableRow | undefined {
  const sourceIndex = header.header.cells.findIndex((cell) => cell.trim() === "来源");
  if (sourceIndex < 0) {
    return undefined;
  }
  const merged = mergeSourceValues(
    original.cells[sourceIndex] ?? "",
    incoming.cells[sourceIndex] ?? "",
  );
  if (merged === (original.cells[sourceIndex] ?? "").trim()) {
    return undefined;
  }
  return replaceCell(original, sourceIndex, merged);
}

export function inspectInputTables(target: MarkdownTable, input: string): InputTableCandidate[] {
  const parsed = parseMarkdown(input);
  if (parsed.tables.length === 0) {
    throw new TableParseError("输入内容中没有识别到 Markdown 表格。");
  }
  return parsed.tables.map((table, index) => ({
    index,
    startLine: table.startLine + 1,
    endLine: table.endLine + 1,
    rowCount: table.rows.length,
    header: table.header.cells.map((cell) => cell.trim()),
    headingPath: headingPathAtLine(parsed.lines, table.startLine),
    matchesTarget: sameHeader(target, table),
    previewRows: table.rows.slice(0, 2),
  }));
}

function collectInputTables(
  input: string,
  target: MarkdownTable,
  selectedTableIndexes?: readonly number[],
): MarkdownTable[] {
  const parsed = parseMarkdown(input);
  if (parsed.tables.length === 0) {
    throw new TableParseError("输入内容中没有识别到 Markdown 表格。");
  }

  if (selectedTableIndexes === undefined) {
    for (const table of parsed.tables) {
      if (!sameHeader(target, table)) {
        throw new TableParseError("输入表格与目标表格的表头不一致，已禁止合并。");
      }
    }
    return parsed.tables;
  }

  const selected = new Set(selectedTableIndexes);
  if (selected.size === 0) {
    throw new TableParseError("尚未选择要合并的输入表格。");
  }
  for (const index of selected) {
    if (!Number.isInteger(index) || index < 0 || index >= parsed.tables.length) {
      throw new TableParseError(`输入表格序号 ${index + 1} 无效，请重新扫描文件。`);
    }
  }
  const tables = parsed.tables.filter((_table, index) => selected.has(index));
  for (const table of tables) {
    if (!sameHeader(target, table)) {
      throw new TableParseError("输入表格与目标表格的表头不一致，已禁止合并。");
    }
  }
  return tables;
}

export function mergeTables(
  target: MarkdownTable,
  input: string,
  selectedTableIndexes?: readonly number[],
): MergeResult {
  const inputTables = collectInputTables(input, target, selectedTableIndexes);
  const workingRows = [...target.rows];
  const additions: TableRow[] = [];
  const duplicates: TableRow[] = [];
  const conflicts: MergeConflict[] = [];
  const notices: MergeNotice[] = [];
  const keyToIndex = new Map<string, number>();

  workingRows.forEach((row, index) => {
    for (const key of rowIdentityKeys(row)) {
      if (!keyToIndex.has(key)) {
        keyToIndex.set(key, index);
      }
    }
  });

  const incomingRows = inputTables.flatMap((table) => table.rows);
  for (const incoming of incomingRows) {
    const keys = rowIdentityKeys(incoming);
    const existingIndex = keys.map((key) => keyToIndex.get(key)).find((value) => value !== undefined);

    if (existingIndex !== undefined) {
      const existing = workingRows[existingIndex];
      if (canonicalRow(existing) === canonicalRow(incoming)) {
        duplicates.push(incoming);
      } else {
        conflicts.push({
          id: `conflict-${conflicts.length + 1}`,
          keys: keys.filter((key) => keyToIndex.get(key) === existingIndex),
          existingIndex,
          existing,
          incoming,
          differences: differences(target, existing, incoming),
          mergedSource: mergedSourceRow(target, existing, incoming),
        });
      }
      continue;
    }

    const incomingLabels = new Set(
      extractLinkReferences(incoming)
        .map((reference) => reference.label.trim())
        .filter(Boolean),
    );
    if (incomingLabels.size > 0) {
      const existingLabels = workingRows
        .flatMap((row) => extractLinkReferences(row))
        .map((reference) => reference.label.trim())
        .filter(Boolean);
      const exactName = existingLabels.find((label) => incomingLabels.has(label));
      const normalizedIncoming = new Set([...incomingLabels].map(normalizeNoticeName).filter(Boolean));
      const normalizedName = existingLabels.find(
        (label) => normalizedIncoming.has(normalizeNoticeName(label)),
      );
      if (exactName || normalizedName) {
        notices.push({
          type: "same-name-different-link",
          name: exactName ?? displayNoticeName(normalizedName!),
          match: exactName ? "exact" : "normalized",
          incoming,
        });
      }
    }

    const newIndex = workingRows.length;
    workingRows.push(incoming);
    additions.push(incoming);
    for (const key of keys) {
      keyToIndex.set(key, newIndex);
    }
  }

  return {
    originalRows: [...target.rows],
    mergedRows: workingRows,
    additions,
    duplicates,
    conflicts,
    notices,
    inputRowCount: incomingRows.length,
  };
}

export function applyConflictChoices(
  result: MergeResult,
  choices: Readonly<Record<string, ConflictChoice>>,
): TableRow[] {
  const unresolved = result.conflicts.filter((conflict) => !choices[conflict.id]);
  if (unresolved.length > 0) {
    throw new Error(`仍有 ${unresolved.length} 个冲突未选择处理方式。`);
  }

  const rows = [...result.mergedRows];
  for (const conflict of result.conflicts) {
    if (choices[conflict.id] === "incoming") {
      rows[conflict.existingIndex] = conflict.incoming;
    } else if (choices[conflict.id] === "merge-source") {
      if (!conflict.mergedSource) {
        throw new Error(`${conflict.id} 不支持合并来源。`);
      }
      rows[conflict.existingIndex] = conflict.mergedSource;
    }
  }
  return rows;
}

export function linkMultiset(rows: TableRow[]): string[] {
  return rows.flatMap(extractUrls).sort();
}
