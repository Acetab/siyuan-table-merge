# Contributing

Issues and improvement suggestions are welcome. When reporting a problem,
please include:

- SiYuan version and Windows version;
- plugin version;
- whether the input was pasted Markdown or a local `.md` file;
- the target header and the input header;
- the preview counts for additions, duplicates, notices, and conflicts;
- the complete error message with private links, note content, block IDs, and
  other sensitive information removed.

Before submitting code, run:

```powershell
npm ci
npm run check
npm test
npm run package
```

Do not commit `node_modules`, local SiYuan workspace data, backups, private
resource links, or credentials.

Maintainer releases are automated by `.github/workflows/release.yml`. Keep the
versions in `package.json`, `package-lock.json`, and `plugin.json` aligned,
push the source commit, and then push a `vX.Y.Z` tag. GitHub Actions will build
and attach `package.zip`; do not manually create the same Release first.

---

# 参与贡献

欢迎提交问题和改进建议。报告问题时，请尽量附上：

- 思源版本和 Windows 版本；
- 插件版本；
- 输入方式是粘贴 Markdown 还是选择本地 `.md` 文件；
- 目标表头和输入表头；
- 预览中的新增、重复、提示和冲突数量；
- 完整错误信息，并移除私人链接、笔记内容、块 ID 等敏感信息。

提交代码前请运行：

```powershell
npm ci
npm run check
npm test
npm run package
```

请不要提交 `node_modules`、本地思源工作空间数据、备份、私人资源链接或凭据。

维护者发布版本时由 `.github/workflows/release.yml` 自动处理。请先确保
`package.json`、`package-lock.json` 和 `plugin.json` 中的版本一致，推送源码提交，
再推送 `vX.Y.Z` 标签。GitHub Actions 会构建并附加 `package.zip`，不要提前手动
创建同名 Release。
