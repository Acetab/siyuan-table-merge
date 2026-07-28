import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {
  applyConflictChoices,
  extractUrls,
  inspectInputTables,
  mergeTables,
} from "../src/core/merge";
import {
  parseMarkdown,
  renderWithRows,
  requireSingleTable,
  splitTableRow,
  TableParseError,
} from "../src/core/table";

const header = "| 名称 | 链接 | 来源 |\n| --- | --- | --- |";

function table(...rows: string[]): string {
  return `${header}\n${rows.join("\n")}`;
}

function target(...rows: string[]) {
  return requireSingleTable(table(...rows), "测试目标").table;
}

describe("Markdown 表格保真解析与合并", () => {
  it("完全重复：跳过且保持原行", () => {
    const row = "| 高数 | [下载](https://example.com/a) | 人工 |";
    const result = mergeTables(target(row), table(row));
    expect(result.additions).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.mergedRows[0].rawLine).toBe(row);
  });

  it("百度同分享 ID 不同提取码：识别为冲突而不是新增", () => {
    const result = mergeTables(
      target("| 高数 | [下载](https://pan.baidu.com/s/1AbCd?pwd=1111) | A |"),
      table("| 高数 | [下载](https://pan.baidu.com/s/1AbCd?pwd=2222) | A |"),
    );
    expect(result.additions).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].keys).toEqual(["baidu:1AbCd"]);
  });

  it("夸克相同分享 ID：完全相同行跳过", () => {
    const row = "| 英语 | [下载](https://pan.quark.cn/s/Qwer12) | B |";
    const result = mergeTables(target(row), table(row));
    expect(result.duplicates).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.additions).toHaveLength(0);
  });

  it("普通 URL 按完整 URL：查询参数不同视为两个链接", () => {
    const result = mergeTables(
      target("| 政治 | [下载](https://example.com/file?id=1) | A |"),
      table("| 政治 | [下载](https://example.com/file?id=2) | A |"),
    );
    expect(result.additions).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("同名不同链接：两行都保留并提示", () => {
    const result = mergeTables(
      target("| 资料 | [真题](https://example.com/one) | A |"),
      table("| 资料 | [真题](https://example.com/two) | A |"),
    );
    expect(result.additions).toHaveLength(1);
    expect(result.mergedRows).toHaveLength(2);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].name).toBe("真题");
    expect(result.notices[0].match).toBe("exact");
  });

  it("名称末尾的平台和分享 ID 装饰只用于疑似同名提示，不参与去重", () => {
    const result = mergeTables(
      target("| 资料 | [全程班（百度 · …AbCd12）](https://pan.baidu.com/s/1OldShare) | A |"),
      table("| 资料 | [全程班（夸克 · …EfGh34）](https://pan.quark.cn/s/NewShare) | B |"),
    );
    expect(result.additions).toHaveLength(1);
    expect(result.mergedRows).toHaveLength(2);
    expect(result.notices).toEqual([
      expect.objectContaining({name: "全程班", match: "normalized"}),
    ]);
  });

  it("同链接不同名称：进入冲突且默认不覆盖原行", () => {
    const original = "| 资料 | [旧名称](https://example.com/same) | A |";
    const incoming = "| 资料 | [新名称](https://example.com/same) | A |";
    const result = mergeTables(target(original), table(incoming));
    expect(result.conflicts).toHaveLength(1);
    expect(result.mergedRows[0].rawLine).toBe(original);
    expect(() => applyConflictChoices(result, {})).toThrow("仍有 1 个冲突");
    expect(applyConflictChoices(result, {"conflict-1": "incoming"})[0].rawLine).toBe(incoming);
  });

  it("同链接但来源不同：进入冲突并列出来源列差异", () => {
    const result = mergeTables(
      target("| 数学 | [下载](https://example.com/same) | 群 A |"),
      table("| 数学 | [下载](https://example.com/same) | 群 B |"),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].differences).toEqual([
      {column: 2, header: "来源", original: "群 A", incoming: "群 B"},
    ]);
    expect(result.conflicts[0].mergedSource?.cells).toEqual([
      "数学",
      "[下载](https://example.com/same)",
      "群 A；群 B",
    ]);
    expect(applyConflictChoices(result, {"conflict-1": "merge-source"})[0].rawLine).toBe(
      "| 数学 | [下载](https://example.com/same) | 群 A；群 B |",
    );
  });

  it("来源合并保留原行的其他列，状态差异仍由用户明确承担", () => {
    const original = "|[讲义](https://pan.baidu.com/s/1Same)|讲义|百度 / ✅|群 A|";
    const incoming = "|[讲义新版](https://pan.baidu.com/s/1Same)|课程|百度 / ⚠️|群 B|";
    const result = mergeTables(
      requireSingleTable(
        "|资源|类型|平台 / 状态|来源|\n|---|---|---|---|\n" + original,
        "测试目标",
      ).table,
      "|资源|类型|平台 / 状态|来源|\n|---|---|---|---|\n" + incoming,
    );
    const resolved = applyConflictChoices(result, {"conflict-1": "merge-source"})[0];
    expect(resolved.cells).toEqual([
      "[讲义](https://pan.baidu.com/s/1Same)",
      "讲义",
      "百度 / ✅",
      "群 A；群 B",
    ]);
    expect(resolved.rawLine).toBe(
      "|[讲义](https://pan.baidu.com/s/1Same)|讲义|百度 / ✅|群 A；群 B|",
    );
  });

  it("空单元格：保留空值与原始 Markdown 行", () => {
    const incoming = "| 中文资料 | [下载](https://example.com/empty) |  |";
    const result = mergeTables(target(), table(incoming));
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0].cells).toEqual(["中文资料", "[下载](https://example.com/empty)", ""]);
    expect(result.additions[0].rawLine).toBe(incoming);
  });

  it("中文内容：解析与链接提取不丢字符", () => {
    const incoming = "| 示例中文讲义 | [夸克下载](https://pan.quark.cn/s/TEST_ONLY_CN) | 人工复核 |";
    const result = mergeTables(target(), table(incoming));
    expect(result.additions[0].cells[0]).toBe("示例中文讲义");
    expect(extractUrls(result.additions[0])).toEqual(["https://pan.quark.cn/s/TEST_ONLY_CN"]);
  });

  it("转义竖线：不拆分单元格并保留反斜杠", () => {
    const row = "| A\\|B | [下载](https://example.com/pipe?x=a%7Cb) | 人工 |";
    expect(splitTableRow(row)).toEqual(["A\\|B", "[下载](https://example.com/pipe?x=a%7Cb)", "人工"]);
    const result = mergeTables(target(), table(row));
    expect(result.additions[0].rawLine).toBe(row);
  });

  it("多个输入表格：同表头行按出现顺序全部合并", () => {
    const input = [
      table("| A | [一](https://example.com/1) | X |"),
      "",
      "说明文字",
      "",
      table("| B | [二](https://example.com/2) | Y |"),
    ].join("\n");
    const result = mergeTables(target(), input);
    expect(result.inputRowCount).toBe(2);
    expect(result.additions.map((row) => row.cells[0])).toEqual(["A", "B"]);
  });

  it("多表格文件：列出位置、行数、表头匹配和前两行", () => {
    const different = [
      "| 日期 | 事项 | 备注 |",
      "| --- | --- | --- |",
      "| 7月 | 测试 | 无 |",
    ].join("\n");
    const input = [
      table("| A | [一](https://example.com/1) | X |"),
      "",
      different,
      "",
      table(
        "| B | [二](https://example.com/2) | Y |",
        "| C | [三](https://example.com/3) | Z |",
      ),
    ].join("\n");

    const candidates = inspectInputTables(target(), input);
    expect(candidates.map((candidate) => ({
      index: candidate.index,
      lines: [candidate.startLine, candidate.endLine],
      rows: candidate.rowCount,
      matches: candidate.matchesTarget,
      preview: candidate.previewRows.map((row) => row.cells[0]),
    }))).toEqual([
      {index: 0, lines: [1, 3], rows: 1, matches: true, preview: ["A"]},
      {index: 1, lines: [5, 7], rows: 1, matches: false, preview: ["7月"]},
      {index: 2, lines: [9, 12], rows: 2, matches: true, preview: ["B", "C"]},
    ]);
  });

  it("资源汇总脱敏样本：候选表格携带完整标题路径并严格区分表头", () => {
    const fixture = readFileSync(
      fileURLToPath(new URL("./fixtures/resource-summary-sanitized.md", import.meta.url)),
      "utf8",
    );
    const fourColumnTarget = requireSingleTable(
      "|资源|类型|平台 / 状态|来源|\n|---|---|---|---|",
      "四列表头",
    ).table;
    const candidates = inspectInputTables(fourColumnTarget, fixture);

    expect(candidates.map((candidate) => ({
      heading: candidate.headingPath,
      matches: candidate.matchesTarget,
      rows: candidate.rowCount,
    }))).toEqual([
      {
        heading: ["资源汇总（脱敏测试）", "课程、教材与讲义"],
        matches: true,
        rows: 1,
      },
      {
        heading: ["资源汇总（脱敏测试）", "真题与题库"],
        matches: true,
        rows: 1,
      },
      {
        heading: ["资源汇总（脱敏测试）", "学习网站"],
        matches: false,
        rows: 1,
      },
      {
        heading: ["资源汇总（脱敏测试）", "经验与学习方法"],
        matches: false,
        rows: 1,
      },
    ]);

    const selected = mergeTables(fourColumnTarget, fixture, [1]);
    expect(selected.additions[0].cells[0]).toContain("示例题库");
    expect(selected.additions[0].cells[2]).toBe("夸克 / ⚠️");
  });

  it("多个同表头表格：只合并用户明确选择的序号", () => {
    const input = [
      table("| A | [一](https://example.com/1) | X |"),
      "",
      table("| B | [二](https://example.com/2) | Y |"),
      "",
      table("| C | [三](https://example.com/3) | Z |"),
    ].join("\n");

    const result = mergeTables(target(), input, [1]);
    expect(result.inputRowCount).toBe(1);
    expect(result.additions.map((row) => row.cells[0])).toEqual(["B"]);
  });

  it("显式选择表头不匹配的表格：禁止生成预览", () => {
    const input = [
      table("| A | [一](https://example.com/1) | X |"),
      "",
      "| 日期 | 事项 | 备注 |\n| --- | --- | --- |\n| 7月 | 测试 | 无 |",
    ].join("\n");
    expect(() => mergeTables(target(), input, [1])).toThrow("表头不一致");
    expect(() => mergeTables(target(), input, [])).toThrow("尚未选择");
  });

  it("表头不一致：禁止合并", () => {
    const input = "| 名称 | 地址 | 来源 |\n| --- | --- | --- |\n| A | https://example.com | X |";
    expect(() => mergeTables(target(), input)).toThrow(TableParseError);
    expect(() => mergeTables(target(), input)).toThrow("表头不一致");
  });

  it("无链接行：仅完全相同的整行判重", () => {
    const result = mergeTables(
      target("| 备注 | 暂无 | 人工 |"),
      table("| 备注 | 暂无 | 人工 |", "| 另一条 | 暂无 | 人工 |"),
    );
    expect(result.duplicates).toHaveLength(1);
    expect(result.additions).toHaveLength(1);
  });

  it("链接查询参数和提取码文本原样保留", () => {
    const row = "| 高数 | [下载](https://example.com/a?token=x%2By&pwd=12%2034) | 提取码：甲乙 |";
    const result = mergeTables(target(), table(row));
    expect(result.additions[0].rawLine).toBe(row);
    expect(extractUrls(result.additions[0])).toEqual([
      "https://example.com/a?token=x%2By&pwd=12%2034",
    ]);
  });

  it("目标块前后 Kramdown 内容在渲染时保持原位", async () => {
    const source = `前置说明\n${table("| A | [一](https://example.com/1) | X |")}\n{: id=\"block\"}`;
    const parsed = parseMarkdown(source);
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.lines[0]).toBe("前置说明");
    expect(parsed.lines.at(-1)).toBe('{: id="block"}');
  });

  it("混合输入：新增、重复和冲突数量精确统计", () => {
    const result = mergeTables(
      target(
        "| A | [甲](https://example.com/a) | 原来源 |",
        "| B | [乙](https://pan.baidu.com/s/1Share?pwd=1111) | 原来源 |",
      ),
      table(
        "| A | [甲](https://example.com/a) | 原来源 |",
        "| C | [丙](https://example.com/c) | 新来源 |",
        "| B | [乙](https://pan.baidu.com/s/1Share?pwd=2222) | 原来源 |",
      ),
    );
    expect({
      added: result.additions.length,
      duplicate: result.duplicates.length,
      conflict: result.conflicts.length,
      merged: result.mergedRows.length,
    }).toEqual({added: 1, duplicate: 1, conflict: 1, merged: 3});
  });

  it("思源 colgroup 属性行：不得算作数据，新增行必须写在 IAL 之前", () => {
    const source = [
      "|资源|类型|平台 / 状态|来源|",
      "| --------| -------------------| -------------| ----------------------------------|",
      "|示例 A|课程、讲义 / 笔记|夸克 / ✅|来源群甲|",
      "|示例 B|课程、讲义 / 笔记|百度 / ✅|来源群乙|",
      "|示例 C|课程、讲义 / 笔记|夸克 / ✅|来源群乙|",
      "|示例 D|课程、讲义 / 笔记|百度 / ✅|来源群甲 ×2|",
      "|示例 D|课程、讲义 / 笔记|夸克 / ✅|来源群甲 ×2|",
      "|示例赠品|课程、讲义 / 笔记|百度 / ✅|来源群丙|",
      "|示例空项|课程、讲义 / 笔记|百度 / ✅|来源群甲|",
      '{: updated="20260728170455" colgroup="width: 198px;|||" id="20260728170113-88oqbn6"}',
    ].join("\n");
    const incoming = [
      "|资源|类型|平台 / 状态|来源|",
      "| ----------------| -------------------| -------------| --------------|",
      "|示例复试课程|课程、经验 / 规划|夸克 / ✅|来源群丁 ×3|",
      "|示例院校资料|经验 / 规划|夸克 / ✅|历史汇总|",
      "|示例经验帖|经验 / 规划|百度 / ⚠️|历史汇总|",
    ].join("\n");

    const {document, table: sourceTable} = requireSingleTable(source, "真实思源表格");
    const result = mergeTables(sourceTable, incoming);
    const rendered = renderWithRows(document, sourceTable, result.mergedRows);
    const renderedLines = rendered.split("\n");

    expect(sourceTable.rows).toHaveLength(7);
    expect(result.additions).toHaveLength(3);
    expect(result.mergedRows).toHaveLength(10);
    expect(renderedLines.at(-1)).toBe(
      '{: updated="20260728170455" colgroup="width: 198px;|||" id="20260728170113-88oqbn6"}',
    );
    expect(renderedLines.at(-2)).toBe("|示例经验帖|经验 / 规划|百度 / ⚠️|历史汇总|");
  });
});
