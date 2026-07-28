# 本地安装说明

项目提供两种等价交付物：

- `release/siyuan-table-merge/`：完整插件文件夹，可以直接整体复制。
- `package.zip`：上述文件夹内容的 ZIP。

本项目不会自动安装插件，也不会写入真实思源工作空间。

建议的手动安装步骤：

1. 关闭思源或确认目标工作空间没有正在进行的重要写入。
2. 直接复制项目中的 `release/siyuan-table-merge` 文件夹；或把 `package.zip`
   解压到一个名为 `siyuan-table-merge` 的文件夹。
3. 将整个 `siyuan-table-merge` 文件夹放入目标工作空间的 `data/plugins/` 下。
4. 启动思源，在“集市 → 已下载 → 插件”中启用“表格合并”。
5. 首次验证只使用可丢弃文档中的表格副本。

ZIP 根目录必须直接包含：

- `plugin.json`
- `index.js`
- `README.md`
- `README.zh-CN.md`
- `README-install.zh-CN.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `LICENSE`
- `icon.png`
- `preview.png`

卸载或替换前，请自行保留插件数据目录中的 `backup-*.json`，其中包含写入前的
原始表格 Kramdown。
