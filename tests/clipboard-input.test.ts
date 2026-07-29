import {describe, expect, it} from "vitest";
import {
  automaticHeaderMapping,
  columnCountMismatchMessage,
  parseRowOnlyInput,
  parseSelectableInputRows,
  renderClipboardRows,
  renderClipboardTable,
  renderMappedRowsForTarget,
} from "../src/core/clipboard-input";
import {requireSingleTable} from "../src/core/table";

const target = requireSingleTable([
  "| 名称 | 链接 | 来源 |",
  "| --- | --- | --- |",
  "| 原资料 | [下载](https://example.com/original) | 原群 |",
].join("\n"), "测试目标").table;

describe("表格数据行剪贴板输入", () => {
  it("粘贴完整表格后把表头和可选数据行分开", () => {
    const result = parseSelectableInputRows([
      "| 资源 | 类型 |",
      "| --- | --- |",
      "| 资料 A | 课程 |",
      "| 资料 B | 真题 |",
    ].join("\n"), true);
    expect(result).toEqual({
      sourceHeader: ["资源", "类型"],
      rows: [
        ["资料 A", "课程"],
        ["资料 B", "真题"],
      ],
    });
  });

  it("关闭第一行表头后允许把第一行也作为可选数据", () => {
    const result = parseSelectableInputRows([
      "| 资料 A | 课程 |",
      "| 资料 B | 真题 |",
    ].join("\n"), false);
    expect(result).toEqual({
      rows: [
        ["资料 A", "课程"],
        ["资料 B", "真题"],
      ],
    });
  });

  it("只有一行时不会把唯一一行吃成表头", () => {
    const result = parseSelectableInputRows(
      "| 资料 A | [链接](https://example.com/a) |",
      true,
    );
    expect(result).toEqual({
      rows: [["资料 A", "[链接](https://example.com/a)"]],
    });
  });

  it("多表输入保留给原有多表扫描流程", () => {
    const input = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");
    expect(parseSelectableInputRows(input, true)).toBeNull();
  });

  it("源、目标表头完全一致时生成直接映射", () => {
    expect(automaticHeaderMapping(
      ["资源", "类型", "平台 / 状态", "来源"],
      ["资源", "类型", "平台 / 状态", "来源"],
    )).toEqual([0, 1, 2, 3]);
  });

  it("表头名称相同但顺序不同时按名称重排", () => {
    expect(automaticHeaderMapping(
      ["来源", "资源", "平台 / 状态", "类型"],
      ["资源", "类型", "平台 / 状态", "来源"],
    )).toEqual([3, 0, 2, 1]);
  });

  it("只有列数相同但表头不同或重复时不自动映射", () => {
    expect(automaticHeaderMapping(["A", "B"], ["资源", "类型"])).toBeNull();
    expect(automaticHeaderMapping(["资源", "资源"], ["资源", "资源"])).toBeNull();
  });

  it("只有 Markdown 数据行时只解析内容，不自动借用目标表头", () => {
    const rows = parseRowOnlyInput(
      "| 新资料 | [下载](https://example.com/new) | 新群 |",
    );
    expect(rows).toEqual([["新资料", "[下载](https://example.com/new)", "新群"]]);
  });

  it("Tab 分隔的多行输入解析后等待人工映射", () => {
    const rows = parseRowOnlyInput([
      "资料 A\t[百度](https://pan.baidu.com/s/abc)\t群 A",
      "资料 B\t[夸克](https://pan.quark.cn/s/def)\t群 B",
    ].join("\n"));
    expect(rows).toHaveLength(2);
    expect(rows?.[1][1]).toContain("pan.quark.cn");
  });

  it("确认映射前不会产生带目标表头的完整表格", () => {
    const rows = parseRowOnlyInput("| 资料 | [链接](https://example.com) | 来源 |")!;
    expect(renderClipboardRows(rows)).not.toContain("| 名称 | 链接 | 来源 |");
  });

  it("完整表格不会被误判为仅数据行", () => {
    const input = [
      "| 名称 | 地址 | 来源 |",
      "| --- | --- | --- |",
      "| 新资料 | [下载](https://example.com/new) | 新群 |",
    ].join("\n");
    expect(parseRowOnlyInput(input)).toBeNull();
  });

  it("人工确认映射后生成目标表格并保留链接", () => {
    const markdown = renderMappedRowsForTarget(
      target,
      [["新资料", "[下载](https://example.com/new)", "新群"]],
      [0, 1, 2],
    );
    expect(markdown).toContain("[下载](https://example.com/new)");
    expect(requireSingleTable(markdown, "剪贴板结果").table.header.cells).toEqual([
      "名称",
      "链接",
      "来源",
    ]);
  });

  it("人工映射可调整列顺序", () => {
    const markdown = renderMappedRowsForTarget(
      target,
      [["[下载](https://example.com/new)", "新群", "新资料"]],
      [1, 2, 0],
    );
    expect(requireSingleTable(markdown, "映射结果").table.rows[0].cells).toEqual([
      "新资料",
      "[下载](https://example.com/new)",
      "新群",
    ]);
  });

  it("重复目标列或映射不完整时禁止生成表格", () => {
    const rows = [["新资料", "[下载](https://example.com/new)", "新群"]];
    expect(() => renderMappedRowsForTarget(target, rows, [0, 0, 2]))
      .toThrow("必须一一对应");
    expect(() => renderMappedRowsForTarget(target, rows, [0, 1]))
      .toThrow("不完整");
  });

  it("源列数和目标列数不同时禁止当前的一一对应映射", () => {
    expect(() => renderMappedRowsForTarget(target, [["资料", "链接"]], [0, 1]))
      .toThrow("当前仅支持一一对应映射");
  });

  it("列数不一致提示会列出差值、双方表头并排除界面辅助列", () => {
    const message = columnCountMismatchMessage(
      2,
      ["资源", "类型", "来源"],
      ["名称", "链接"],
    );
    expect(message).toContain("复制内容识别到 2 个数据列");
    expect(message).toContain("目标表格有 3 个数据列（比目标少 1 列）");
    expect(message).toContain("复制内容表头：名称 ｜ 链接");
    expect(message).toContain("目标表头：资源 ｜ 类型 ｜ 来源");
    expect(message).toContain("“选择”和“行号”是辅助列");
  });

  it("包含表头的富文本表格使用自身表头", () => {
    const markdown = renderClipboardTable(
      ["资源", "网址"],
      [["示例", "[打开](https://example.com)"]],
    );
    expect(markdown).toContain("| 资源 | 网址 |");
  });
});
