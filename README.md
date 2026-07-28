# Table Merge

[简体中文](README.zh-CN.md)

Safely merge reviewed Markdown tables into an existing SiYuan table selected
by the user.

![Table Merge preview](preview.png)

> Note: The preview is an AI-assisted functional illustration and differs
> from the actual plugin interface. Please refer to the running plugin.

## Motivation

SiYuan stores standard tables as Markdown tables. My recurring workflow is to
have AI organize and clean a batch of resources into Markdown, review the
result, and periodically merge those rows into tables already maintained in
SiYuan.

Manual copy and paste makes it easy to miss duplicate links, same-name
resources with different links, changed access codes, and provenance updates.
Documents can also contain several sections—such as courses and past
papers—that deliberately use the same header. SiYuan databases can store
links, but standard Markdown hyperlinks are more convenient for this
AI-assisted, portable, copy-friendly workflow.

Table Merge handles only the final step: merging already reviewed Markdown
tables into an existing table with an explicit preview, manual conflict
choices, a backup, and post-write verification.

## Features

- Explicitly select one target table block; the plugin never guesses a note or
  destination.
- Paste Markdown or read a local `.md` file.
- For multi-table files, show the source filename, Markdown heading path, line
  range, header, and first two rows.
- Disable tables whose headers do not match the target.
- Separate additions, exact duplicates, same or normalized-name notices, and
  link conflicts.
- Identify Baidu and Quark shares by platform and share ID.
- Preserve same-name/different-link resources and cross-platform mirrors.
- Resolve each conflict by keeping the original row, using the incoming row,
  or keeping the original row while merging only its source/provenance cell.
- Re-read and back up the target before writing, then verify the header, row
  count, order, contents, and links after writing.
- Keep all table data local; no external AI or link-checking service is used.

## Usage

1. Select exactly one standard table block in SiYuan.
2. Open **Merge Markdown Table** from the top bar.
3. Paste reviewed Markdown or choose a local `.md` file.
4. Scan the input and explicitly select matching tables when more than one is
   found.
5. Review additions, duplicates, notices, and conflicts.
6. Resolve every conflict.
7. Confirm the summary and perform the final write.

For the first test, use a copied table in a disposable document rather than
the only copy of important data.

## Input

The selected input table must have the same column count and header as the
target:

```markdown
| Resource | Type | Platform / Status | Source |
| --- | --- | --- | --- |
| [Example notes](https://example.com/a) | Notes | Web / ✅ | Reviewed |
```

A file may contain prose, headings, and several tables with different headers.
Only recognized tables can be selected. Paragraphs and images outside tables
are never written into the target table.

## Merge rules

| Case | Default behavior |
| --- | --- |
| Exact row duplicate | Skip |
| New link | Append |
| Same name, different link | Keep both and show a notice |
| Same Baidu/Quark share ID with other changes | Require a conflict choice |
| Different query strings on ordinary URLs | Treat as different links |
| Rows without links | Deduplicate only when the entire row matches |
| Header mismatch | Block selection and writing |

A trailing decoration such as a platform and shortened share ID is ignored
only for normalized-name notices. It is never used as a deduplication or
overwrite key.

## Write safety

- Previewing never writes to the note.
- The SiYuan Kernel API is called only after final confirmation.
- The target is read again before writing; a changed table invalidates the
  preview.
- The latest original Kramdown is backed up through SiYuan's plugin data API.
- Only one write may run for a target block at a time.
- The result is read back and verified after writing.
- SiYuan Kramdown IAL metadata is preserved and excluded from data-row
  matching.

## Scope

- Windows desktop only.
- One explicitly selected standard Markdown table block.
- No AI invocation, chat-log cleaning, content classification, or link
  availability checking.
- No automatic choice between same-header sections.
- No direct `.sy` file editing and no external upload of table data.

## Installation

Install from the SiYuan Bazaar when available. For local installation, see
[README-install.zh-CN.md](README-install.zh-CN.md).

## Development

```powershell
npm ci
npm run check
npm test
npm run build
npm run package
```

Source lives in `src/`. `dist/`, `release/`, and `package.zip` are generated.

## Reporting issues

Remove private links, access codes, note content, block IDs, and workspace
paths before posting public reports. See [SECURITY.md](SECURITY.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT License](LICENSE)
