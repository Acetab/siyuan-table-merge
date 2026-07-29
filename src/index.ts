import {Dialog, fetchSyncPost, getActiveEditor, Plugin, showMessage} from "siyuan";
import {
  ConflictChoice,
  InputTableCandidate,
  MergeConflict,
  MergeNotice,
  MergeResult,
} from "./core/merge";
import {
  BackupStore,
  commitPreview,
  createPreviewFromInspection,
  InputInspection,
  inspectPreviewInput,
  KernelApi,
  MergePreview,
} from "./core/safe-write";
import {resolveTableSelection, TableSelectionResolution} from "./core/selection";
import {
  automaticHeaderMapping,
  columnCountMismatchMessage,
  parseSelectableInputRows,
  renderClipboardRows,
  renderMappedRowsForTarget,
  SelectableInputRows,
} from "./core/clipboard-input";
import {MarkdownTable, requireSingleTable, TableRow} from "./core/table";

const TABLE_SELECTOR = '.protyle-wysiwyg--select[data-node-id][data-type="NodeTable"]';
const TABLE_BLOCK_SELECTOR = '[data-node-id][data-type="NodeTable"]';

function selectedTableBlockIds(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABLE_SELECTOR))
    .map((element) => element.dataset.nodeId ?? "")
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
}

function tableIdFromNode(node: Node | null, root: HTMLElement | null): string | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  const table = element?.closest<HTMLElement>(TABLE_BLOCK_SELECTOR);
  if (!table || (root && !root.contains(table))) {
    return undefined;
  }
  return table.dataset.nodeId || undefined;
}

interface ClipboardTable {
  rows: string[][];
}

// Retained only for the legacy, unreachable row-picker controller below.
// The active plugin flow now opens the target-table paste dialog directly.
interface TransferBuffer {
  sourceBlockId: string;
  sourceHeader: string[];
  rows: TableRow[];
}

function clipboardInlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\|/gu, "\\|");
  }
  if (!(node instanceof Element)) {
    return "";
  }
  if (node.tagName === "BR") {
    return " ";
  }
  const content = Array.from(node.childNodes).map(clipboardInlineMarkdown).join("");
  const siyuanHref = node.getAttribute("data-type") === "a"
    ? node.getAttribute("data-href")
    : null;
  if (node instanceof HTMLAnchorElement || siyuanHref) {
    const label = content.trim().replace(/([[\]])/gu, "\\$1");
    const href = (siyuanHref ?? (node instanceof HTMLAnchorElement ? node.href : "")).trim()
      .replace(/\s/gu, "%20")
      .replace(/\|/gu, "%7C")
      .replace(/\(/gu, "%28")
      .replace(/\)/gu, "%29");
    return href ? `[${label || href}](${href})` : label;
  }
  return content;
}

function clipboardCellMarkdown(cell: Element): string {
  return Array.from(cell.childNodes)
    .map(clipboardInlineMarkdown)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function tableFromClipboardHtml(html: string): ClipboardTable | null {
  if (!html.trim()) {
    return null;
  }
  const document = new DOMParser().parseFromString(html, "text/html");
  const table = document.querySelector("table");
  if (!table) {
    return null;
  }
  const rows = Array.from(table.querySelectorAll("tr"))
    .map((row) => {
      return Array.from(row.children)
        .filter((cell) => cell.matches("th,td"))
        .map(clipboardCellMarkdown);
    })
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) {
    return null;
  }
  // SiYuan wraps copied row selections in a temporary HTML table and may mark
  // its first selected row as <th>/<thead>. That markup does not prove that the
  // row was the source table's real header, so every rich-clipboard row stays
  // a data row and must pass the explicit column-mapping step.
  return {rows};
}

function assertKernelSuccess(response: {code?: number; msg?: string}, action: string): void {
  if (typeof response.code !== "number" || response.code !== 0) {
    throw new Error(`${action}失败：Kernel API code=${String(response.code)} ${response.msg ?? ""}`.trim());
  }
}

function compactCellText(value: string): string {
  return value.replace(
    /\[([^\]]*)\]\((https?:\/\/[^\s)]+)[^)]*\)/gu,
    (_match, label: string, url: string) => {
      try {
        const parsed = new URL(url);
        const tail = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
        const shortTail = tail.length > 12 ? `${tail.slice(0, 12)}…` : tail;
        return `${label || "链接"} · ${parsed.hostname}${shortTail ? `/${shortTail}` : ""}`;
      } catch {
        return label || "链接";
      }
    },
  );
}

class SiyuanKernelApi implements KernelApi {
  async getBlockKramdown(blockId: string): Promise<string> {
    const response = await fetchSyncPost("/api/block/getBlockKramdown", {id: blockId});
    assertKernelSuccess(response, "读取目标块");
    const data = response.data as {kramdown?: unknown} | null;
    if (!data || typeof data.kramdown !== "string") {
      throw new Error("读取目标块失败：Kernel API 未返回 kramdown 字符串。");
    }
    return data.kramdown;
  }

  async updateBlock(blockId: string, markdown: string): Promise<void> {
    const response = await fetchSyncPost("/api/block/updateBlock", {
      id: blockId,
      dataType: "markdown",
      data: markdown,
    });
    assertKernelSuccess(response, "更新目标块");
  }
}

class PluginBackupStore implements BackupStore {
  constructor(private readonly plugin: Plugin) {}

  async saveBackup(blockId: string, markdown: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `backup-${blockId}-${timestamp}.json`;
    const response = await this.plugin.saveData(name, {
      blockId,
      createdAt: new Date().toISOString(),
      kramdown: markdown,
    });
    if (response && typeof response === "object" && "code" in response) {
      assertKernelSuccess(response as {code?: number; msg?: string}, "保存原表备份");
    }
    return name;
  }
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function rowText(row: {cells: string[]}): string {
  return row.cells.map(compactCellText).join(" | ");
}

function appendListSection(container: HTMLElement, title: string, rows: {cells: string[]}[]): void {
  if (rows.length === 0) {
    return;
  }
  const section = createElement("details", "tm-details");
  section.open = true;
  section.append(createElement("summary", "", `${title}（${rows.length}）`));
  const list = createElement("ol");
  for (const row of rows) {
    list.append(createElement("li", "tm-code", rowText(row)));
  }
  section.append(list);
  container.append(section);
}

function appendNoticeSection(container: HTMLElement, notices: MergeNotice[]): void {
  if (notices.length === 0) {
    return;
  }
  const section = createElement("details", "tm-details");
  section.open = true;
  section.append(createElement("summary", "", `同名或疑似同名、不同链接（保留并提示）（${notices.length}）`));
  const list = createElement("ol");
  for (const notice of notices) {
    const kind = notice.match === "exact" ? "同名" : "疑似同名";
    list.append(createElement("li", "tm-code", `[${kind}：${notice.name}] ${rowText(notice.incoming)}`));
  }
  section.append(list);
  container.append(section);
}

function appendConflict(
  container: HTMLElement,
  conflict: MergeConflict,
  choices: Record<string, ConflictChoice>,
  onChange: () => void,
): void {
  const card = createElement("fieldset", "tm-conflict");
  card.append(createElement("legend", "", `${conflict.id} · ${conflict.keys.join(", ")}`));
  const diffTable = createElement("table", "tm-conflict-table");
  const head = createElement("tr");
  for (const heading of ["字段", "目标表格当前值", "复制进来的值"]) {
    head.append(createElement("th", "", heading));
  }
  diffTable.append(head);
  for (const difference of conflict.differences) {
    const row = createElement("tr");
    row.append(
      createElement("th", "", difference.header || `第 ${difference.column + 1} 列`),
      createElement("td", "tm-code", compactCellText(difference.original)),
      createElement("td", "tm-code", compactCellText(difference.incoming)),
    );
    diffTable.append(row);
  }
  card.append(diffTable);

  const originalLabel = createElement("label", "tm-choice");
  const originalInput = createElement("input");
  originalInput.type = "radio";
  originalInput.name = conflict.id;
  originalInput.value = "original";
  originalInput.addEventListener("change", () => {
    choices[conflict.id] = "original";
    onChange();
  });
  originalLabel.append(originalInput, document.createTextNode(" 保留原行"));

  const incomingLabel = createElement("label", "tm-choice");
  const incomingInput = createElement("input");
  incomingInput.type = "radio";
  incomingInput.name = conflict.id;
  incomingInput.value = "incoming";
  incomingInput.addEventListener("change", () => {
    choices[conflict.id] = "incoming";
    onChange();
  });
  incomingLabel.append(incomingInput, document.createTextNode(" 使用输入行"));
  card.append(originalLabel, incomingLabel);

  if (conflict.mergedSource) {
    const sourceLabel = createElement("label", "tm-choice");
    const sourceInput = createElement("input");
    sourceInput.type = "radio";
    sourceInput.name = conflict.id;
    sourceInput.value = "merge-source";
    sourceInput.addEventListener("change", () => {
      choices[conflict.id] = "merge-source";
      onChange();
    });
    sourceLabel.append(
      sourceInput,
      document.createTextNode(` 保留目标行，仅追加来源字段 → ${rowText(conflict.mergedSource)}`),
    );
    card.append(sourceLabel);
  }
  container.append(card);
}

function appendInputTableCandidate(
  container: HTMLElement,
  candidate: InputTableCandidate,
  sourceLabel: string,
  onChange: () => void,
): void {
  const card = createElement("label", "tm-table-card");
  const heading = createElement("div", "tm-table-heading");
  const checkbox = createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "tm-table-choice";
  checkbox.dataset.tableIndex = String(candidate.index);
  checkbox.disabled = !candidate.matchesTarget;
  checkbox.addEventListener("change", onChange);
  heading.append(
    checkbox,
    document.createTextNode(
      ` ${sourceLabel}｜${candidate.headingPath.length > 0 ? candidate.headingPath.join(" › ") : "未找到所属标题"}｜表格 ${candidate.index + 1}｜第 ${candidate.startLine}–${candidate.endLine} 行｜${candidate.rowCount} 行数据`,
    ),
  );
  card.append(heading);
  card.append(createElement(
    "div",
    candidate.matchesTarget ? "tm-match" : "tm-mismatch",
    candidate.matchesTarget
      ? `表头匹配：${candidate.header.join(" ｜ ")}`
      : `不可选择，表头不匹配：${candidate.header.join(" ｜ ")}`,
  ));
  const preview = createElement("div", "tm-code tm-table-preview");
  preview.textContent = candidate.previewRows.length > 0
    ? candidate.previewRows.map(rowText).join("\n")
    : "（空表格）";
  card.append(preview);
  container.append(card);
}

function appendColumnMapping(
  container: HTMLElement,
  targetTable: MarkdownTable,
  rows: readonly (readonly string[])[],
  onChange: () => void,
  sourceHeader?: readonly string[],
  suggestedMapping?: readonly number[],
): void {
  const card = createElement("div", "tm-mapping-card");
  card.append(createElement(
    "div",
    "tm-table-heading",
    sourceHeader
      ? "源、目标表头不同：请逐列确认写入位置"
      : "无源表头：请逐列确认复制内容应写入哪个目标列",
  ));
  card.append(createElement(
    "div",
    "tm-muted",
    "默认按原顺序选择，但不会自动确认。调整任意映射后需要重新勾选确认。",
  ));
  rows[0].forEach((_cell, sourceIndex) => {
    const row = createElement("label", "tm-mapping-row");
    const samples = rows
      .slice(0, 2)
      .map((cells) => cells[sourceIndex] || "（空）")
      .join(" / ");
    row.append(createElement(
      "span",
      "tm-code",
      `${sourceHeader?.[sourceIndex]?.trim() || `源第 ${sourceIndex + 1} 列`}（示例：${compactCellText(samples)}）→`,
    ));
    const select = createElement("select", "b3-select tm-column-map");
    select.dataset.sourceIndex = String(sourceIndex);
    targetTable.header.cells.forEach((header, targetIndex) => {
      const option = createElement("option", "", `${targetIndex + 1}. ${header.trim() || "（空表头）"}`);
      option.value = String(targetIndex);
      option.selected = (suggestedMapping?.[sourceIndex] ?? sourceIndex) === targetIndex;
      select.append(option);
    });
    row.append(select);
    card.append(row);
  });
  const confirmLabel = createElement("label", "tm-mapping-confirm-label");
  const confirm = createElement("input");
  confirm.type = "checkbox";
  confirm.className = "tm-mapping-confirm";
  confirmLabel.append(
    confirm,
    document.createTextNode(" 我已核对上述每个源列与目标列的对应关系"),
  );
  card.querySelectorAll<HTMLSelectElement>(".tm-column-map").forEach((select) => {
    select.addEventListener("change", () => {
      confirm.checked = false;
      onChange();
    });
  });
  card.append(confirmLabel);
  container.replaceChildren(card);
}

function summaryText(blockId: string, result: MergeResult): string {
  return [
    `目标块 ID：${blockId}`,
    `原行数：${result.originalRows.length}`,
    `新增数：${result.additions.length}`,
    `重复数：${result.duplicates.length}`,
    `冲突数：${result.conflicts.length}`,
    `合并后行数：${result.mergedRows.length}`,
  ].join("　");
}

class MergeDialogController {
  private readonly api = new SiyuanKernelApi();
  private readonly backups: BackupStore;
  private preview: MergePreview | null = null;
  private inspection: InputInspection | null = null;
  private choices: Record<string, ConflictChoice> = {};
  private inputSourceLabel = "粘贴内容";

  constructor(
    private readonly plugin: Plugin,
    private readonly blockId: string,
    private readonly onDestroy: () => void,
  ) {
    this.backups = new PluginBackupStore(plugin);
  }

  open(): Dialog {
    const dialog = new Dialog({
      title: "合并 Markdown 表格",
      width: "min(1280px, 96vw)",
      height: "min(880px, 92vh)",
      destroyCallback: this.onDestroy,
      content: `
        <div class="tm-root">
          <style>
            .tm-root{padding:16px;display:flex;flex-direction:column;gap:12px;height:100%;box-sizing:border-box;overflow:auto}
            .tm-target{font-weight:600}.tm-input{width:100%;min-height:180px;resize:vertical;box-sizing:border-box}
            .tm-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;position:sticky;bottom:-16px;z-index:2;padding:10px 0;background:var(--b3-theme-background)}
            .tm-summary{line-height:1.8;position:sticky;top:-16px;z-index:1;padding:6px 0;background:var(--b3-theme-background)}
            .tm-diffs{display:grid;gap:8px}.tm-details,.tm-conflict{border:1px solid var(--b3-border-color);border-radius:6px;padding:8px}
            .tm-code{font-family:var(--b3-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere}
            .tm-tables{display:grid;gap:8px}.tm-table-card{display:block;border:1px solid var(--b3-border-color);border-radius:6px;padding:10px}
            .tm-table-heading{font-weight:600}.tm-match{color:var(--b3-theme-primary);margin:5px 0}
            .tm-mismatch{color:var(--b3-theme-error);margin:5px 0}.tm-table-preview{padding:6px;background:var(--b3-theme-surface)}
            .tm-choice{display:inline-flex;align-items:center;margin-right:18px}.tm-muted{color:var(--b3-theme-on-surface)}
            .tm-mapping-card{display:grid;gap:8px;border:1px solid var(--b3-theme-warning);border-radius:6px;padding:10px}
            .tm-mapping-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,0.7fr);gap:10px;align-items:center}
            .tm-mapping-confirm-label{font-weight:600;margin-top:4px}
            .tm-conflict-table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:10px}
            .tm-conflict-table th,.tm-conflict-table td{border:1px solid var(--b3-border-color);padding:7px;text-align:left;vertical-align:top}
            .tm-conflict-table th:first-child{width:14%}.tm-conflict-table td{overflow-wrap:anywhere}
            .tm-status{min-height:1.5em}.tm-status[data-kind="error"]{color:var(--b3-theme-error)}
            .tm-status[data-kind="success"]{color:var(--b3-theme-primary)}
            .tm-row-selection{display:grid;gap:8px;border:1px solid var(--b3-border-color);border-radius:6px;padding:10px}
            .tm-row-guide{font-weight:700}.tm-row-toolbar{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
            .tm-row-option{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-weight:600}
            .tm-row-table-wrap{overflow:auto;max-height:360px;border:1px solid var(--b3-border-color);border-radius:6px}
            .tm-row-table{width:100%;border-collapse:collapse;table-layout:auto}
            .tm-row-table thead{position:sticky;top:0;z-index:1;background:var(--b3-theme-surface)}
            .tm-row-table th,.tm-row-table td{border-bottom:1px solid var(--b3-border-color);border-right:1px solid var(--b3-border-color);padding:9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
            .tm-row-table th:last-child,.tm-row-table td:last-child{border-right:0}
            .tm-row-table tbody tr{cursor:pointer}.tm-row-table tbody tr:hover{background:var(--b3-list-hover)}
            .tm-row-check-cell{width:72px;text-align:center!important}.tm-row-index{width:54px;text-align:center!important}
          </style>
          <div class="tm-target"></div>
          <textarea class="b3-text-field tm-input" placeholder="粘贴完整 Markdown 表格，或直接粘贴复制的表格行"></textarea>
          <section class="tm-row-selection" hidden>
            <div class="tm-row-guide">粘贴内容：选择需要合并的数据行</div>
            <div class="tm-row-toolbar">
              <label class="tm-row-option">
                <input class="tm-first-row-header" type="checkbox" checked>
                <span>第一行作为表头</span>
              </label>
              <label class="tm-row-option">
                <input class="tm-row-master" type="checkbox">
                <span>全选全部数据行</span>
              </label>
              <span class="tm-row-count"></span>
            </div>
            <div class="tm-row-table-wrap">
              <table class="tm-row-table">
                <thead></thead>
                <tbody></tbody>
              </table>
            </div>
          </section>
          <div class="tm-mapping"></div>
          <div class="tm-tables"></div>
          <div class="tm-actions">
            <input class="tm-file" type="file" accept=".md,text/markdown,text/plain">
            <button class="b3-button tm-preview">查看差异</button>
            <button class="b3-button b3-button--primary tm-commit" disabled>最终确认并写入</button>
          </div>
          <div class="tm-status" aria-live="polite"></div>
          <div class="tm-summary"></div>
          <div class="tm-diffs"></div>
        </div>`,
    });

    const root = dialog.element.querySelector<HTMLElement>(".tm-root");
    if (!root) {
      throw new Error("无法初始化合并器界面。");
    }
    const target = root.querySelector<HTMLElement>(".tm-target")!;
    const textarea = root.querySelector<HTMLTextAreaElement>(".tm-input")!;
    const file = root.querySelector<HTMLInputElement>(".tm-file")!;
    const rowSelection = root.querySelector<HTMLElement>(".tm-row-selection")!;
    const firstRowHeader = root.querySelector<HTMLInputElement>(".tm-first-row-header")!;
    const rowMaster = root.querySelector<HTMLInputElement>(".tm-row-master")!;
    const rowCount = root.querySelector<HTMLElement>(".tm-row-count")!;
    const rowHead = root.querySelector<HTMLTableSectionElement>(".tm-row-table thead")!;
    const rowBody = root.querySelector<HTMLTableSectionElement>(".tm-row-table tbody")!;
    const mapping = root.querySelector<HTMLElement>(".tm-mapping")!;
    const tables = root.querySelector<HTMLElement>(".tm-tables")!;
    const previewButton = root.querySelector<HTMLButtonElement>(".tm-preview")!;
    const commitButton = root.querySelector<HTMLButtonElement>(".tm-commit")!;
    const status = root.querySelector<HTMLElement>(".tm-status")!;
    const summary = root.querySelector<HTMLElement>(".tm-summary")!;
    const diffs = root.querySelector<HTMLElement>(".tm-diffs")!;
    target.textContent = `目标表格块：${this.blockId}`;
    let rowOnlyRows: string[][] | null = null;
    let rowOnlyTarget: MarkdownTable | null = null;
    let selectableInput: SelectableInputRows | null = null;

    const setStatus = (message: string, kind: "info" | "error" | "success" = "info") => {
      status.textContent = message;
      status.dataset.kind = kind;
    };
    const refreshCommitState = () => {
      const allResolved = this.preview?.result.conflicts.every((conflict) => Boolean(this.choices[conflict.id])) ?? false;
      commitButton.disabled = !this.preview || !allResolved;
    };
    const resetInputState = (message: string) => {
      this.preview = null;
      this.inspection = null;
      this.choices = {};
      rowOnlyRows = null;
      rowOnlyTarget = null;
      mapping.replaceChildren();
      tables.replaceChildren();
      summary.textContent = "";
      diffs.replaceChildren();
      previewButton.textContent = "查看差异";
      setStatus(message);
      refreshCommitState();
    };
    const refreshRowChecks = () => {
      const checks = Array.from(rowBody.querySelectorAll<HTMLInputElement>(".tm-row-check"));
      const selectedCount = checks.filter((checkbox) => checkbox.checked).length;
      rowMaster.checked = checks.length > 0 && selectedCount === checks.length;
      rowMaster.indeterminate = selectedCount > 0 && selectedCount < checks.length;
      rowCount.textContent = `已选择 ${selectedCount} / ${checks.length} 行`;
      previewButton.textContent = "使用所选行生成预览";
    };
    const invalidateRowChoice = () => {
      this.preview = null;
      this.inspection = null;
      this.choices = {};
      rowOnlyRows = null;
      rowOnlyTarget = null;
      mapping.replaceChildren();
      tables.replaceChildren();
      summary.textContent = "";
      diffs.replaceChildren();
      setStatus("数据行选择已变化，请使用所选行重新生成预览。");
      refreshRowChecks();
      refreshCommitState();
    };
    const renderRowSelection = () => {
      selectableInput = null;
      rowHead.replaceChildren();
      rowBody.replaceChildren();
      rowSelection.hidden = true;
      if (!textarea.value.trim()) {
        return;
      }
      try {
        const parsed = parseSelectableInputRows(textarea.value, firstRowHeader.checked);
        if (!parsed) {
          previewButton.textContent = "扫描表格";
          return;
        }
        selectableInput = parsed;
        const singleRowAutoData = firstRowHeader.checked
          && !parsed.sourceHeader
          && parsed.rows.length === 1;
        if (singleRowAutoData) {
          firstRowHeader.checked = false;
        }
        const columnCount = parsed.sourceHeader?.length ?? parsed.rows[0]?.length ?? 0;
        const heading = createElement("tr");
        heading.append(
          createElement("th", "tm-row-check-cell", "选择"),
          createElement("th", "tm-row-index", "行号"),
        );
        for (let index = 0; index < columnCount; index += 1) {
          heading.append(createElement(
            "th",
            "",
            parsed.sourceHeader?.[index]?.trim() || `第 ${index + 1} 列`,
          ));
        }
        rowHead.append(heading);
        parsed.rows.forEach((cells, index) => {
          const tableRow = createElement("tr");
          const checkbox = createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "tm-row-check";
          checkbox.dataset.rowIndex = String(index);
          checkbox.checked = true;
          checkbox.addEventListener("change", invalidateRowChoice);
          const checkCell = createElement("td", "tm-row-check-cell");
          checkCell.append(checkbox);
          tableRow.append(
            checkCell,
            createElement("td", "tm-row-index", String(index + 1)),
          );
          cells.forEach((cell) => {
            tableRow.append(createElement("td", "tm-code", compactCellText(cell)));
          });
          tableRow.addEventListener("click", (event) => {
            if (event.target === checkbox) {
              return;
            }
            checkbox.checked = !checkbox.checked;
            invalidateRowChoice();
          });
          rowBody.append(tableRow);
        });
        rowSelection.hidden = false;
        refreshRowChecks();
        setStatus(
          singleRowAutoData
            ? "只识别到一行，已自动将它作为数据行；请核对后生成预览。"
            : firstRowHeader.checked
            ? "已把第一行作为表头，并默认全选第 2 行及以后；可取消不需要的行。"
            : "第一行也作为数据，当前已默认全选全部行。",
          "success",
        );
      } catch (error) {
        previewButton.textContent = "查看差异";
        setStatus(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const invalidateSelectedTables = () => {
      this.preview = null;
      this.choices = {};
      summary.textContent = "";
      diffs.replaceChildren();
      setStatus("表格选择已变化，请使用所选表格生成预览。");
      refreshCommitState();
    };
    const renderPreview = (preview: MergePreview) => {
      this.preview = preview;
      this.choices = {};
      summary.textContent = summaryText(this.blockId, preview.result);
      diffs.replaceChildren();
      appendListSection(diffs, "新增行", preview.result.additions);
      appendListSection(diffs, "完全重复（将跳过）", preview.result.duplicates);
      appendNoticeSection(diffs, preview.result.notices);
      for (const conflict of preview.result.conflicts) {
        appendConflict(diffs, conflict, this.choices, refreshCommitState);
      }
      setStatus(
        preview.result.conflicts.length > 0
          ? "预览完成。请逐项选择所有冲突的处理方式。"
          : "预览完成；未发现冲突。请核对后最终确认。",
        "success",
      );
      refreshCommitState();
    };
    const inspectAndRender = async (inputMarkdown: string, automaticMessage?: string) => {
      this.inspection = await inspectPreviewInput(this.api, this.blockId, inputMarkdown);
      mapping.replaceChildren();
      tables.replaceChildren();
      for (const candidate of this.inspection.candidates) {
        appendInputTableCandidate(
          tables,
          candidate,
          this.inputSourceLabel,
          invalidateSelectedTables,
        );
      }
      const matching = this.inspection.candidates.filter((candidate) => candidate.matchesTarget);
      if (this.inspection.candidates.length === 1 && matching.length === 1) {
        tables.replaceChildren();
        renderPreview(createPreviewFromInspection(this.inspection, [matching[0].index]));
        previewButton.textContent = selectableInput ? "重新使用所选行生成预览" : "重新生成预览";
        if (automaticMessage) {
          setStatus(
            this.preview?.result.conflicts.length
              ? `${automaticMessage} 请处理下方冲突。`
              : `${automaticMessage} 请核对后最终确认。`,
            "success",
          );
        }
        return;
      }
      previewButton.textContent = "使用所选表格生成预览";
      setStatus(
        matching.length === 0
          ? `识别到 ${this.inspection.candidates.length} 个表格，但没有与目标表头匹配的表格。`
          : `识别到 ${this.inspection.candidates.length} 个表格，其中 ${matching.length} 个表头匹配；请明确勾选要合并的表格。`,
        matching.length === 0 ? "error" : "info",
      );
    };

    file.addEventListener("change", async () => {
      const selected = file.files?.[0];
      if (!selected) {
        return;
      }
      if (!selected.name.toLowerCase().endsWith(".md")) {
        setStatus("只接受本地 .md 文件。", "error");
        file.value = "";
        return;
      }
      textarea.value = await selected.text();
      this.inputSourceLabel = selected.name;
      resetInputState(`已读取文件：${selected.name}。`);
      renderRowSelection();
    });

    textarea.addEventListener("input", () => {
      this.inputSourceLabel = "粘贴内容";
      resetInputState("输入已变化。");
      renderRowSelection();
    });

    firstRowHeader.addEventListener("change", () => {
      resetInputState("表头设置已变化。");
      renderRowSelection();
    });

    rowMaster.addEventListener("change", () => {
      rowBody.querySelectorAll<HTMLInputElement>(".tm-row-check").forEach((checkbox) => {
        checkbox.checked = rowMaster.checked;
      });
      invalidateRowChoice();
    });

    textarea.addEventListener("paste", (event) => {
      const clipboardTable = tableFromClipboardHtml(event.clipboardData?.getData("text/html") ?? "");
      if (!clipboardTable) {
        return;
      }
      const plainText = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      void (async () => {
        try {
          const markdown = renderClipboardRows(clipboardTable.rows);
          textarea.setRangeText(
            markdown,
            textarea.selectionStart,
            textarea.selectionEnd,
            "end",
          );
          textarea.dispatchEvent(new Event("input", {bubbles: true}));
          setStatus(
            "已从思源剪贴板恢复表格内容和超链接；默认把第一行作为表头，并全选其余数据行。",
            "success",
          );
        } catch (error) {
          textarea.setRangeText(
            plainText,
            textarea.selectionStart,
            textarea.selectionEnd,
            "end",
          );
          textarea.dispatchEvent(new Event("input", {bubbles: true}));
          setStatus(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      })();
    });

    previewButton.addEventListener("click", async () => {
      if (!textarea.value.trim()) {
        setStatus("请先粘贴 Markdown 或选择本地 .md 文件。", "error");
        return;
      }
      previewButton.disabled = true;
      commitButton.disabled = true;
      setStatus("正在读取目标表格并扫描输入内容……");
      try {
        if (selectableInput && this.inspection) {
          this.inspection = null;
          rowOnlyRows = null;
          rowOnlyTarget = null;
          mapping.replaceChildren();
        }
        if (!this.inspection) {
          let inputMarkdown = textarea.value;
          if (!rowOnlyRows) {
            if (selectableInput) {
              const selectedIndexes = Array.from(
                rowBody.querySelectorAll<HTMLInputElement>(".tm-row-check:checked"),
              ).map((checkbox) => Number(checkbox.dataset.rowIndex));
              if (selectedIndexes.length === 0) {
                throw new Error("请至少选择一行数据。");
              }
              const selectedRows = selectedIndexes.map((index) => selectableInput!.rows[index]);
              const targetMarkdown = await this.api.getBlockKramdown(this.blockId);
              const targetTable = requireSingleTable(targetMarkdown, "目标块").table;
              if (selectedRows[0].length !== targetTable.header.cells.length) {
                throw new Error(
                  columnCountMismatchMessage(
                    selectedRows[0].length,
                    targetTable.header.cells,
                    selectableInput.sourceHeader,
                  ),
                );
              }
              const automaticMapping = selectableInput.sourceHeader
                ? automaticHeaderMapping(selectableInput.sourceHeader, targetTable.header.cells)
                : null;
              if (automaticMapping) {
                const reordered = automaticMapping.some(
                  (targetIndex, sourceIndex) => targetIndex !== sourceIndex,
                );
                await inspectAndRender(
                  renderMappedRowsForTarget(targetTable, selectedRows, automaticMapping),
                  reordered
                    ? "源、目标表头名称相同但顺序不同，已按名称自动调整列顺序。"
                    : "源、目标表头完全一致，已自动生成预览。",
                );
                return;
              }
              rowOnlyRows = selectedRows;
              rowOnlyTarget = targetTable;
              appendColumnMapping(mapping, targetTable, selectedRows, () => {
                setStatus("列映射已变化，请重新核对并勾选确认。");
              }, selectableInput.sourceHeader);
              previewButton.textContent = "确认映射并生成预览";
              setStatus(
                selectableInput.sourceHeader
                  ? "源、目标表头不同。请核对每一列的目标位置并勾选确认。"
                  : "没有源表头。请核对每一列的目标位置并勾选确认。",
              );
              return;
            }
          } else {
            const confirmed = mapping.querySelector<HTMLInputElement>(".tm-mapping-confirm");
            if (!confirmed?.checked || !rowOnlyTarget) {
              throw new Error("请先核对列映射并勾选确认。");
            }
            const sourceToTarget = Array.from(
              mapping.querySelectorAll<HTMLSelectElement>(".tm-column-map"),
            )
              .sort((left, right) => Number(left.dataset.sourceIndex) - Number(right.dataset.sourceIndex))
              .map((select) => Number(select.value));
            inputMarkdown = renderMappedRowsForTarget(
              rowOnlyTarget,
              rowOnlyRows,
              sourceToTarget,
            );
            this.inputSourceLabel = "粘贴数据行（已确认列映射）";
          }
          await inspectAndRender(inputMarkdown);
          return;
        }

        const selectedIndexes = Array.from(
          tables.querySelectorAll<HTMLInputElement>(".tm-table-choice:checked"),
        ).map((checkbox) => Number(checkbox.dataset.tableIndex));
        renderPreview(createPreviewFromInspection(this.inspection, selectedIndexes));
      } catch (error) {
        this.preview = null;
        summary.textContent = "";
        diffs.replaceChildren();
        setStatus(error instanceof Error ? error.message : String(error), "error");
      } finally {
        previewButton.disabled = false;
      }
    });

    commitButton.addEventListener("click", async () => {
      if (!this.preview) {
        setStatus("预览已失效，请重新预览。", "error");
        return;
      }
      commitButton.disabled = true;
      previewButton.disabled = true;
      setStatus("正在二次核对、备份、写入并验证……");
      try {
        const receipt = await commitPreview(this.api, this.backups, this.preview, this.choices);
        setStatus(
          `写入并验证成功：${receipt.verifiedRowCount} 行、${receipt.verifiedLinkCount} 个链接；备份 ${receipt.backupName}`,
          "success",
        );
        showMessage("Markdown 表格合并并验证成功。", 5000);
        this.preview = null;
        this.inspection = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message, "error");
        showMessage(message, 7000, "error");
        refreshCommitState();
      } finally {
        previewButton.disabled = false;
      }
    });

    return dialog;
  }
}

function selectedDataRowIndexes(
  root: HTMLElement | null,
  blockId: string,
  rowCount: number,
): number[] {
  if (!root || rowCount === 0) {
    return [];
  }
  const block = Array.from(root.querySelectorAll<HTMLElement>(TABLE_BLOCK_SELECTOR))
    .find((element) => element.dataset.nodeId === blockId);
  if (!block) {
    return [];
  }
  const allRows = Array.from(block.querySelectorAll<HTMLTableRowElement>("tr"));
  const dataRows = allRows.length > rowCount ? allRows.slice(-rowCount) : allRows;
  const selected = new Set<number>();
  block.querySelectorAll<HTMLElement>(
    "td.protyle-wysiwyg--select,th.protyle-wysiwyg--select,td.b3-table__select,th.b3-table__select",
  ).forEach((cell) => {
    const row = cell.closest("tr");
    const index = row ? dataRows.indexOf(row) : -1;
    if (index >= 0) {
      selected.add(index);
    }
  });
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    dataRows.forEach((row, index) => {
      try {
        if (range.intersectsNode(row)) {
          selected.add(index);
        }
      } catch {
        // The row may have been detached during a SiYuan rerender.
      }
    });
  }
  return [...selected].sort((left, right) => left - right);
}

class RowPickerDialogController {
  private readonly api = new SiyuanKernelApi();

  constructor(
    private readonly blockId: string,
    private readonly activeEditorRoot: HTMLElement | null,
    private readonly onSave: (buffer: TransferBuffer) => void,
    private readonly onAdvanced: () => void,
    private readonly onDestroy: () => void,
  ) {}

  open(): Dialog {
    const dialog = new Dialog({
      title: "快速搬行 · 第 1 步：选择源表数据行",
      width: "min(1180px, 95vw)",
      height: "min(820px, 90vh)",
      destroyCallback: this.onDestroy,
      content: `
        <div class="tm-picker-root">
          <style>
            .tm-picker-root{padding:16px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}
            .tm-picker-guide{display:grid;gap:4px;border-left:4px solid var(--b3-theme-primary);background:var(--b3-theme-surface);padding:10px 12px;border-radius:4px}
            .tm-picker-title{font-weight:700}.tm-picker-status{min-height:1.5em;color:var(--b3-theme-on-surface)}
            .tm-picker-toolbar{display:flex;gap:18px;align-items:center;flex-wrap:wrap;font-weight:600}
            .tm-picker-select-all{display:inline-flex;align-items:center;gap:7px;cursor:pointer}
            .tm-picker-table-wrap{overflow:auto;flex:1;border:1px solid var(--b3-border-color);border-radius:6px}
            .tm-picker-table{width:100%;border-collapse:collapse;table-layout:auto}
            .tm-picker-table thead{position:sticky;top:0;z-index:1;background:var(--b3-theme-surface)}
            .tm-picker-table th,.tm-picker-table td{border-bottom:1px solid var(--b3-border-color);border-right:1px solid var(--b3-border-color);padding:9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
            .tm-picker-table th:last-child,.tm-picker-table td:last-child{border-right:0}
            .tm-picker-table tbody tr{cursor:pointer}.tm-picker-table tbody tr:hover{background:var(--b3-list-hover)}
            .tm-picker-table .tm-picker-check-cell{width:72px;text-align:center}.tm-picker-table .tm-picker-index{width:54px;text-align:center}
            .tm-picker-code{font-family:var(--b3-font-family-code)}
            .tm-picker-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;position:sticky;bottom:0;background:var(--b3-theme-background);padding-top:8px}
            .tm-picker-advanced{margin-left:auto}
          </style>
          <div class="tm-picker-guide">
            <div class="tm-picker-title">第 1 步：勾选需要搬运的数据行</div>
            <div>保存后，请回到思源选中目标表格，再点击一次顶栏表格合并图标。</div>
          </div>
          <div class="tm-picker-status">正在读取源表格……</div>
          <div class="tm-picker-toolbar">
            <label class="tm-picker-select-all">
              <input class="tm-picker-master" type="checkbox">
              <span>全选全部数据行</span>
            </label>
            <span class="tm-picker-count">已选择 0 行</span>
            <span>源表格块：${this.blockId}</span>
          </div>
          <div class="tm-picker-table-wrap">
            <table class="tm-picker-table">
              <thead></thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="tm-picker-actions">
            <button class="b3-button b3-button--primary tm-picker-save" disabled>复制所选行并进入下一步</button>
            <button class="b3-button tm-picker-advanced">高级导入 Markdown</button>
          </div>
        </div>`,
    });
    const root = dialog.element.querySelector<HTMLElement>(".tm-picker-root")!;
    const status = root.querySelector<HTMLElement>(".tm-picker-status")!;
    const tableHead = root.querySelector<HTMLTableSectionElement>(".tm-picker-table thead")!;
    const tableBody = root.querySelector<HTMLTableSectionElement>(".tm-picker-table tbody")!;
    const master = root.querySelector<HTMLInputElement>(".tm-picker-master")!;
    const countLabel = root.querySelector<HTMLElement>(".tm-picker-count")!;
    const save = root.querySelector<HTMLButtonElement>(".tm-picker-save")!;
    const advanced = root.querySelector<HTMLButtonElement>(".tm-picker-advanced")!;
    let sourceTable: MarkdownTable | null = null;

    const refresh = () => {
      const all = Array.from(tableBody.querySelectorAll<HTMLInputElement>(".tm-picker-check"));
      const count = all.filter((input) => input.checked).length;
      save.disabled = count === 0;
      save.textContent = count > 0
        ? `复制所选 ${count} 行并进入下一步`
        : "复制所选行并进入下一步";
      countLabel.textContent = `已选择 ${count} / ${all.length} 行`;
      master.checked = all.length > 0 && count === all.length;
      master.indeterminate = count > 0 && count < all.length;
    };
    const setChecks = (checked: boolean) => {
      tableBody.querySelectorAll<HTMLInputElement>(".tm-picker-check").forEach((input) => {
        input.checked = checked;
      });
      refresh();
    };
    master.addEventListener("change", () => setChecks(master.checked));
    advanced.addEventListener("click", () => {
      dialog.destroy();
      this.onAdvanced();
    });
    save.addEventListener("click", () => {
      if (!sourceTable) {
        return;
      }
      const indexes = Array.from(
        tableBody.querySelectorAll<HTMLInputElement>(".tm-picker-check:checked"),
      ).map((input) => Number(input.dataset.rowIndex));
      this.onSave({
        sourceBlockId: this.blockId,
        sourceHeader: sourceTable.header.cells.map((cell) => cell.trim()),
        rows: indexes.map((index) => sourceTable!.rows[index]),
      });
      dialog.destroy();
    });

    void (async () => {
      try {
        const markdown = await this.api.getBlockKramdown(this.blockId);
        sourceTable = requireSingleTable(markdown, "源表格块").table;
        const headerRow = createElement("tr");
        headerRow.append(
          createElement("th", "tm-picker-check-cell", "选择"),
          createElement("th", "tm-picker-index", "行号"),
        );
        sourceTable.header.cells.forEach((header) => {
          headerRow.append(createElement("th", "", header.trim() || "（空表头）"));
        });
        tableHead.append(headerRow);
        const preselected = new Set(
          selectedDataRowIndexes(this.activeEditorRoot, this.blockId, sourceTable.rows.length),
        );
        sourceTable.rows.forEach((row, index) => {
          const tableRow = createElement("tr");
          const checkbox = createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "tm-picker-check";
          checkbox.dataset.rowIndex = String(index);
          checkbox.checked = preselected.has(index);
          checkbox.addEventListener("change", refresh);
          const checkCell = createElement("td", "tm-picker-check-cell");
          checkCell.append(checkbox);
          tableRow.append(
            checkCell,
            createElement("td", "tm-picker-index", String(index + 1)),
          );
          row.cells.forEach((cell) => {
            tableRow.append(createElement("td", "tm-picker-code", compactCellText(cell)));
          });
          tableRow.addEventListener("click", (event) => {
            if (event.target === checkbox) {
              return;
            }
            checkbox.checked = !checkbox.checked;
            refresh();
          });
          tableBody.append(tableRow);
        });
        status.textContent = preselected.size > 0
          ? `已根据当前编辑器选区预选 ${preselected.size} 行，请核对。`
          : "未可靠识别编辑器行选区，请在下方勾选需要搬运的数据行。";
        refresh();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    })();
    return dialog;
  }
}

export default class TableMergePlugin extends Plugin {
  private topBar: HTMLElement | null = null;
  private activeMergeDialog: Dialog | null = null;
  private explicitBlockIds: string[] = [];
  private lastInteractedTableId: string | undefined;

  private activeEditorRoot(): HTMLElement | null {
    try {
      const editor = getActiveEditor();
      return editor?.protyle?.contentElement ?? editor?.protyle?.element ?? null;
    } catch {
      return null;
    }
  }

  private resolveSelection(): TableSelectionResolution {
    const root = this.activeEditorRoot();
    const browserSelection = window.getSelection();
    return resolveTableSelection({
      explicitBlockIds: this.explicitBlockIds,
      activeEditorIds: root ? selectedTableBlockIds(root) : [],
      rangeTableId: tableIdFromNode(browserSelection?.anchorNode ?? null, root),
      lastInteractedTableId: this.lastInteractedTableId,
    });
  }

  private readonly handleBlockIcon = (event: CustomEvent<{blockElements: HTMLElement[]}>) => {
    this.explicitBlockIds = event.detail.blockElements
      .filter((element) => element.matches(TABLE_BLOCK_SELECTOR))
      .map((element) => element.dataset.nodeId ?? "")
      .filter(Boolean);
    this.lastInteractedTableId = this.explicitBlockIds.length === 1
      ? this.explicitBlockIds[0]
      : undefined;
    this.updateAvailability();
  };

  private readonly handleEditorClick = (event: CustomEvent<{event: MouseEvent}>) => {
    const root = this.activeEditorRoot();
    const target = event.detail.event.target;
    this.lastInteractedTableId = target instanceof Node
      ? tableIdFromNode(target, root)
      : undefined;
    this.explicitBlockIds = [];
    this.updateAvailability();
  };

  private readonly handleEditorSwitch = () => {
    this.explicitBlockIds = [];
    this.lastInteractedTableId = undefined;
    this.updateAvailability();
  };

  private readonly updateAvailability = () => {
    if (!this.topBar) {
      return;
    }
    const available = this.resolveSelection().kind === "one";
    this.topBar.setAttribute("aria-disabled", String(!available));
    this.topBar.classList.toggle("b3-tooltips__disabled", !available);
    this.topBar.setAttribute(
      "aria-label",
      available
        ? "向当前表格粘贴并选择要合并的数据行"
        : "请先明确选中一个表格块",
    );
  };

  private openMerge(blockId: string): void {
    const controller = new MergeDialogController(this, blockId, () => {
      this.activeMergeDialog = null;
    });
    this.activeMergeDialog = controller.open();
  }

  onload(): void {
    this.topBar = this.addTopBar({
      icon: "iconTable",
      title: "合并 Markdown 表格",
      position: "right",
      callback: () => {
        if (this.activeMergeDialog) {
          showMessage("合并器窗口已经打开，请在当前窗口完成或关闭后再打开。", 5000, "error");
          return;
        }
        const selection = this.resolveSelection();
        if (selection.kind !== "one") {
          showMessage(
            selection.kind === "none"
              ? "请先在思源中明确选中一个表格块。"
              : "一次只能选择一个表格块。",
            5000,
            "error",
          );
          return;
        }
        this.openMerge(selection.id);
      },
    });
    this.eventBus.on("click-blockicon", this.handleBlockIcon);
    this.eventBus.on("click-editorcontent", this.handleEditorClick);
    this.eventBus.on("switch-protyle", this.handleEditorSwitch);
    document.addEventListener("selectionchange", this.updateAvailability);
    document.addEventListener("pointerup", this.updateAvailability);
    this.updateAvailability();
  }

  onunload(): void {
    this.activeMergeDialog?.destroy();
    this.activeMergeDialog = null;
    this.eventBus.off("click-blockicon", this.handleBlockIcon);
    this.eventBus.off("click-editorcontent", this.handleEditorClick);
    this.eventBus.off("switch-protyle", this.handleEditorSwitch);
    document.removeEventListener("selectionchange", this.updateAvailability);
    document.removeEventListener("pointerup", this.updateAvailability);
  }
}
