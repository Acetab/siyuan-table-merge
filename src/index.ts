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

function assertKernelSuccess(response: {code?: number; msg?: string}, action: string): void {
  if (typeof response.code !== "number" || response.code !== 0) {
    throw new Error(`${action}失败：Kernel API code=${String(response.code)} ${response.msg ?? ""}`.trim());
  }
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
  return row.cells.join(" | ");
}

function appendListSection(container: HTMLElement, title: string, rows: {cells: string[]}[]): void {
  const section = createElement("details", "tm-details");
  section.open = rows.length > 0;
  section.append(createElement("summary", "", `${title}（${rows.length}）`));
  const list = createElement("ol");
  for (const row of rows) {
    list.append(createElement("li", "tm-code", rowText(row)));
  }
  if (rows.length === 0) {
    list.append(createElement("li", "tm-muted", "无"));
  }
  section.append(list);
  container.append(section);
}

function appendNoticeSection(container: HTMLElement, notices: MergeNotice[]): void {
  const section = createElement("details", "tm-details");
  section.open = notices.length > 0;
  section.append(createElement("summary", "", `同名或疑似同名、不同链接（保留并提示）（${notices.length}）`));
  const list = createElement("ol");
  for (const notice of notices) {
    const kind = notice.match === "exact" ? "同名" : "疑似同名";
    list.append(createElement("li", "tm-code", `[${kind}：${notice.name}] ${rowText(notice.incoming)}`));
  }
  if (notices.length === 0) {
    list.append(createElement("li", "tm-muted", "无"));
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
  const diffList = createElement("ul");
  for (const difference of conflict.differences) {
    diffList.append(createElement(
      "li",
      "tm-code",
      `${difference.header || `第 ${difference.column + 1} 列`}：原「${difference.original}」→ 新「${difference.incoming}」`,
    ));
  }
  card.append(diffList);

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
      document.createTextNode(` 保留原行，仅合并来源 → ${rowText(conflict.mergedSource)}`),
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
      width: "min(900px, 92vw)",
      height: "min(760px, 90vh)",
      destroyCallback: this.onDestroy,
      content: `
        <div class="tm-root">
          <style>
            .tm-root{padding:16px;display:flex;flex-direction:column;gap:12px;height:100%;box-sizing:border-box;overflow:auto}
            .tm-target{font-weight:600}.tm-input{width:100%;min-height:180px;resize:vertical;box-sizing:border-box}
            .tm-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tm-summary{line-height:1.8}
            .tm-diffs{display:grid;gap:8px}.tm-details,.tm-conflict{border:1px solid var(--b3-border-color);border-radius:6px;padding:8px}
            .tm-code{font-family:var(--b3-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere}
            .tm-tables{display:grid;gap:8px}.tm-table-card{display:block;border:1px solid var(--b3-border-color);border-radius:6px;padding:10px}
            .tm-table-heading{font-weight:600}.tm-match{color:var(--b3-theme-primary);margin:5px 0}
            .tm-mismatch{color:var(--b3-theme-error);margin:5px 0}.tm-table-preview{padding:6px;background:var(--b3-theme-surface)}
            .tm-choice{display:inline-flex;align-items:center;margin-right:18px}.tm-muted{color:var(--b3-theme-on-surface)}
            .tm-status{min-height:1.5em}.tm-status[data-kind="error"]{color:var(--b3-theme-error)}
            .tm-status[data-kind="success"]{color:var(--b3-theme-primary)}
          </style>
          <div class="tm-target"></div>
          <textarea class="b3-text-field tm-input" placeholder="粘贴人工复核后的 Markdown 表格"></textarea>
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
    const tables = root.querySelector<HTMLElement>(".tm-tables")!;
    const previewButton = root.querySelector<HTMLButtonElement>(".tm-preview")!;
    const commitButton = root.querySelector<HTMLButtonElement>(".tm-commit")!;
    const status = root.querySelector<HTMLElement>(".tm-status")!;
    const summary = root.querySelector<HTMLElement>(".tm-summary")!;
    const diffs = root.querySelector<HTMLElement>(".tm-diffs")!;
    target.textContent = `目标表格块：${this.blockId}`;

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
      tables.replaceChildren();
      summary.textContent = "";
      diffs.replaceChildren();
      previewButton.textContent = "查看差异";
      setStatus(message);
      refreshCommitState();
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
      resetInputState(`已读取文件：${selected.name}，请扫描表格。`);
    });

    textarea.addEventListener("input", () => {
      this.inputSourceLabel = "粘贴内容";
      resetInputState("输入已变化，请重新扫描表格。");
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
        if (!this.inspection) {
          this.inspection = await inspectPreviewInput(this.api, this.blockId, textarea.value);
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
            renderPreview(createPreviewFromInspection(this.inspection, [matching[0].index]));
            return;
          }
          previewButton.textContent = "使用所选表格生成预览";
          setStatus(
            matching.length === 0
              ? `识别到 ${this.inspection.candidates.length} 个表格，但没有与目标表头匹配的表格。`
              : `识别到 ${this.inspection.candidates.length} 个表格，其中 ${matching.length} 个表头匹配；请明确勾选要合并的表格。`,
            matching.length === 0 ? "error" : "info",
          );
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
      available ? "合并 Markdown 表格" : "请先明确选中一个表格块",
    );
  };

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
        const controller = new MergeDialogController(this, selection.id, () => {
          this.activeMergeDialog = null;
        });
        this.activeMergeDialog = controller.open();
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
