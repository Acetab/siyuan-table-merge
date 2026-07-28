export interface TableRow {
  rawLine: string;
  cells: string[];
}

export interface MarkdownTable {
  header: TableRow;
  separator: TableRow;
  rows: TableRow[];
  startLine: number;
  endLine: number;
}

export interface ParsedMarkdown {
  original: string;
  lines: string[];
  newline: "\n" | "\r\n";
  trailingNewline: boolean;
  tables: MarkdownTable[];
}

export class TableParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableParseError";
  }
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

export function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  const finalIndex = body.length - 1;
  if (finalIndex >= 0 && body[finalIndex] === "|" && !isEscaped(body, finalIndex)) {
    body = body.slice(0, -1);
  }

  const cells: string[] = [];
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "|" && !isEscaped(body, index)) {
      cells.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  cells.push(body.slice(start).trim());
  return cells;
}

function hasUnescapedPipe(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|" && !isEscaped(line, index)) {
      return true;
    }
  }
  return false;
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

export function isKramdownIalLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("{:") && trimmed.endsWith("}");
}

function toRow(rawLine: string): TableRow {
  return {rawLine, cells: splitTableRow(rawLine)};
}

export function parseMarkdown(input: string): ParsedMarkdown {
  const newline: "\n" | "\r\n" = input.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = input.endsWith("\n");
  const normalized = input.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (trailingNewline) {
    lines.pop();
  }

  const tables: MarkdownTable[] = [];
  let index = 0;
  while (index + 1 < lines.length) {
    if (!hasUnescapedPipe(lines[index]) || !hasUnescapedPipe(lines[index + 1])) {
      index += 1;
      continue;
    }

    const header = toRow(lines[index]);
    const separator = toRow(lines[index + 1]);
    if (header.cells.length < 1 || separator.cells.length !== header.cells.length || !isSeparator(separator.cells)) {
      index += 1;
      continue;
    }

    const rows: TableRow[] = [];
    let cursor = index + 2;
    while (
      cursor < lines.length
      && !isKramdownIalLine(lines[cursor])
      && hasUnescapedPipe(lines[cursor])
    ) {
      const row = toRow(lines[cursor]);
      if (row.cells.length !== header.cells.length) {
        break;
      }
      rows.push(row);
      cursor += 1;
    }

    tables.push({
      header,
      separator,
      rows,
      startLine: index,
      endLine: cursor - 1,
    });
    index = cursor;
  }

  return {original: input, lines, newline, trailingNewline, tables};
}

export function requireSingleTable(input: string, label: string): {document: ParsedMarkdown; table: MarkdownTable} {
  const document = parseMarkdown(input);
  if (document.tables.length !== 1) {
    throw new TableParseError(`${label}必须且只能包含一个 Markdown 表格，当前识别到 ${document.tables.length} 个。`);
  }
  return {document, table: document.tables[0]};
}

export function normalizeHeader(table: MarkdownTable): string[] {
  return table.header.cells.map((cell) => cell.trim());
}

export function sameHeader(left: MarkdownTable, right: MarkdownTable): boolean {
  const leftHeader = normalizeHeader(left);
  const rightHeader = normalizeHeader(right);
  return leftHeader.length === rightHeader.length
    && leftHeader.every((cell, index) => cell === rightHeader[index]);
}

export function renderWithRows(document: ParsedMarkdown, table: MarkdownTable, rows: TableRow[]): string {
  const replacement = [
    table.header.rawLine,
    table.separator.rawLine,
    ...rows.map((row) => row.rawLine),
  ];
  const lines = [
    ...document.lines.slice(0, table.startLine),
    ...replacement,
    ...document.lines.slice(table.endLine + 1),
  ];
  const rendered = lines.join(document.newline);
  return document.trailingNewline ? `${rendered}${document.newline}` : rendered;
}

export function canonicalRow(row: TableRow): string {
  return row.cells.map((cell) => cell.trim()).join("\u001f");
}
