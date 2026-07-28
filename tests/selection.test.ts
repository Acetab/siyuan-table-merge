import {describe, expect, it} from "vitest";
import {resolveTableSelection} from "../src/core/selection";

describe("活动编辑器表格选择解析", () => {
  it("明确块选择只有一个时直接使用", () => {
    expect(resolveTableSelection({
      explicitBlockIds: ["table-current"],
      activeEditorIds: ["table-old-1", "table-old-2"],
    })).toEqual({kind: "one", id: "table-current"});
  });

  it("明确选择多个表格时仍然阻止", () => {
    expect(resolveTableSelection({
      explicitBlockIds: ["table-a", "table-b"],
      activeEditorIds: [],
    })).toEqual({kind: "multiple", ids: ["table-a", "table-b"]});
  });

  it("浏览器光标位于表格时优先使用所在表格", () => {
    expect(resolveTableSelection({
      explicitBlockIds: [],
      activeEditorIds: ["table-old-1", "table-current"],
      rangeTableId: "table-current",
    })).toEqual({kind: "one", id: "table-current"});
  });

  it("活动编辑器残留多个选中样式时使用最近交互的表格", () => {
    expect(resolveTableSelection({
      explicitBlockIds: [],
      activeEditorIds: ["table-old", "table-current"],
      lastInteractedTableId: "table-current",
    })).toEqual({kind: "one", id: "table-current"});
  });

  it("没有任何表格证据时返回未选择", () => {
    expect(resolveTableSelection({
      explicitBlockIds: [],
      activeEditorIds: [],
    })).toEqual({kind: "none"});
  });
});
