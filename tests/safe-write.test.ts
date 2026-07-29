import {describe, expect, it} from "vitest";
import {
  BackupStore,
  commitPreview,
  createPreview,
  KernelApi,
  SafetyError,
} from "../src/core/safe-write";

const original = [
  "| 名称 | 链接 | 来源 |",
  "| --- | --- | --- |",
  "| A | [下载](https://example.com/a) | 人工 |",
].join("\n");

const input = [
  "| 名称 | 链接 | 来源 |",
  "| --- | --- | --- |",
  "| B | [下载](https://example.com/b) | 人工 |",
].join("\n");

class FakeKernel implements KernelApi {
  markdown = original;
  updateCalls = 0;
  failUpdate = false;
  mutateAfterUpdate: ((markdown: string) => string) | null = null;

  async getBlockKramdown(): Promise<string> {
    return this.markdown;
  }

  async updateBlock(_blockId: string, markdown: string): Promise<void> {
    this.updateCalls += 1;
    if (this.failUpdate) {
      throw new Error("更新目标块失败：Kernel API code=5 simulated");
    }
    this.markdown = this.mutateAfterUpdate ? this.mutateAfterUpdate(markdown) : markdown;
  }
}

class FakeBackups implements BackupStore {
  calls: Array<{blockId: string; markdown: string}> = [];

  async saveBackup(blockId: string, markdown: string): Promise<string> {
    this.calls.push({blockId, markdown});
    return "backup-test.json";
  }
}

describe("安全写入反向验证", () => {
  it("表头不同：预览阶段阻止，写入调用为 0", async () => {
    const api = new FakeKernel();
    const mismatched = input.replace("| 名称 | 链接 | 来源 |", "| 名称 | 地址 | 来源 |");
    await expect(createPreview(api, "block-1", mismatched)).rejects.toThrow("表头不一致");
    expect(api.updateCalls).toBe(0);
  });

  it("预览后原表变化：摘要不符时阻止，备份和写入调用均为 0", async () => {
    const api = new FakeKernel();
    const backups = new FakeBackups();
    const preview = await createPreview(api, "block-1", input);
    api.markdown = original.replace("人工", "人工改动");
    await expect(commitPreview(api, backups, preview, {})).rejects.toThrow("内容在预览后发生变化");
    expect(backups.calls).toHaveLength(0);
    expect(api.updateCalls).toBe(0);
  });

  it("Kernel API 非零 code：视为失败并保留先行备份", async () => {
    const api = new FakeKernel();
    const backups = new FakeBackups();
    const preview = await createPreview(api, "block-1", input);
    api.failUpdate = true;
    await expect(commitPreview(api, backups, preview, {})).rejects.toThrow("code=5");
    expect(backups.calls).toHaveLength(1);
    expect(backups.calls[0].markdown).toBe(original);
    expect(api.updateCalls).toBe(1);
  });

  it("正常路径：先备份、写入、重读并验证行数和链接", async () => {
    const api = new FakeKernel();
    const backups = new FakeBackups();
    const preview = await createPreview(api, "block-1", input);
    const receipt = await commitPreview(api, backups, preview, {});
    expect(backups.calls).toHaveLength(1);
    expect(api.updateCalls).toBe(1);
    expect(receipt).toEqual({
      backupName: "backup-test.json",
      verifiedRowCount: 2,
      verifiedLinkCount: 2,
    });
    expect(api.markdown).toContain("https://example.com/a");
    expect(api.markdown).toContain("https://example.com/b");
  });

  it("只有数据行：未经人工映射不得直接进入安全写入", async () => {
    const api = new FakeKernel();
    const rowOnly = "| B | [下载](https://example.com/b) | 人工 |";
    await expect(createPreview(api, "block-1", rowOnly))
      .rejects.toThrow("没有识别到 Markdown 表格");
    expect(api.updateCalls).toBe(0);
  });

  it("来源合并选项：写入前后只改变来源单元格并通过反向验证", async () => {
    const api = new FakeKernel();
    const backups = new FakeBackups();
    const sourceUpdate = original.replace("人工", "新群");
    const preview = await createPreview(api, "block-1", sourceUpdate);
    expect(preview.result.conflicts[0].mergedSource?.cells[2]).toBe("人工；新群");

    const receipt = await commitPreview(api, backups, preview, {
      "conflict-1": "merge-source",
    });
    expect(receipt.verifiedRowCount).toBe(1);
    expect(api.markdown).toContain("| A | [下载](https://example.com/a) | 人工；新群 |");
    expect(api.markdown).not.toContain("https://example.com/b");
  });

  it("写入后结果被改变：明确报错且备份仍保留", async () => {
    const api = new FakeKernel();
    const backups = new FakeBackups();
    api.mutateAfterUpdate = (markdown) => markdown.replace("https://example.com/b", "https://example.com/lost");
    const preview = await createPreview(api, "block-1", input);
    await expect(commitPreview(api, backups, preview, {})).rejects.toThrow(SafetyError);
    expect(backups.calls).toHaveLength(1);
    expect(api.updateCalls).toBe(1);
  });

  it("真实思源表格 IAL：写入载荷保持原块 ID 且合并为 10 行", async () => {
    const api = new FakeKernel();
    const backups = new FakeBackups();
    api.markdown = [
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

    const preview = await createPreview(api, "20260728170113-88oqbn6", incoming);
    expect(preview.result.originalRows).toHaveLength(7);
    expect(preview.result.mergedRows).toHaveLength(10);

    api.markdown = api.markdown.replace(
      '{: updated="20260728170455" colgroup="width: 198px;|||" id="20260728170113-88oqbn6"}',
      '{: id="20260728170113-88oqbn6" updated="20260728170455" colgroup="width: 198px;|||"}',
    );
    const receipt = await commitPreview(api, backups, preview, {});
    expect(receipt.verifiedRowCount).toBe(10);
    expect(backups.calls[0].markdown.split("\n").at(-1)).toBe(
      '{: id="20260728170113-88oqbn6" updated="20260728170455" colgroup="width: 198px;|||"}',
    );
    expect(api.markdown.split("\n").at(-1)).toBe(
      '{: id="20260728170113-88oqbn6" updated="20260728170455" colgroup="width: 198px;|||"}',
    );
    expect(api.markdown.split("\n").at(-2)).toBe(
      "|示例经验帖|经验 / 规划|百度 / ⚠️|历史汇总|",
    );
  });

  it("同一块并发确认：第二次写入被互斥锁立即阻止", async () => {
    const api = new FakeKernel();
    const backups = new FakeBackups();
    const preview = await createPreview(api, "block-1", input);

    const firstCommit = commitPreview(api, backups, preview, {});
    await expect(commitPreview(api, backups, preview, {})).rejects.toThrow("已有写入正在进行");
    await expect(firstCommit).resolves.toEqual({
      backupName: "backup-test.json",
      verifiedRowCount: 2,
      verifiedLinkCount: 2,
    });
    expect(api.updateCalls).toBe(1);
    expect(backups.calls).toHaveLength(1);
  });
});
