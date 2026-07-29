# Changelog

## 0.1.7 - 2026-07-29

- Preserve the reviewed preview and icon PNG files in Linux release builds
  instead of re-rendering their SVG sources without the required fonts.

## 0.1.6 - 2026-07-28

- Shorten and center preview button labels to prevent text overflow.

## 0.1.5 - 2026-07-28

- Show source filenames and Markdown heading paths in the multi-table picker.
- Add normalized-name notices without using names as deduplication keys.
- Add an explicit conflict choice that keeps the original row and merges only
  its source/provenance cell.
- Add a sanitized resource-summary regression fixture.
- Rename the public package identity to `siyuan-table-merge`.
- Add marketplace preview assets, bilingual documentation, MIT license,
  security and contribution guidance, a release workflow, and local
  marketplace validation.

## 0.1.4 - 2026-07-28

- Add explicit selection for files containing multiple Markdown tables.
- Add a directly copyable plugin folder under `release/`.

## 0.1.3 - 2026-07-28

- Ignore volatile IAL attribute order when checking for concurrent edits.
- Add one-dialog and per-block write locks.

## 0.1.2 - 2026-07-28

- Preserve SiYuan table IAL metadata after all data rows.

## 0.1.1 - 2026-07-28

- Restrict target-table selection to the active editor.

## 0.1.0 - 2026-07-27

- Initial reviewed Markdown table merge workflow.
