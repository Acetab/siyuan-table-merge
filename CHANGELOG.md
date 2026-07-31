# Changelog

## 0.2.1 - 2026-07-31

- Clarify that the plugin primarily serves a personal workflow for
  same-schema resource tables, especially cloud-drive link tables.
- Document that merged-cell navigation tables and other curated presentation
  layouts remain outside the plugin's scope.
- Direct community feedback to a dedicated Table Merge thread under the
  existing Auto Favicon community post instead of creating a separate
  promotional post.

## 0.2.0 - 2026-07-29

- Select the destination table once, then paste and choose incoming rows in the
  same merge dialog.
- Render pasted content as a source-column table with individual row
  checkboxes, a select-all control, and a live selected-row count.
- Treat the first pasted row as the source header by default and preselect all
  later rows; allow including the first row when it is data.
- Treat a lone pipe/TSV row as data automatically instead of consuming it as a
  header.
- Recover standard and SiYuan rich-text hyperlinks from HTML clipboard data so
  multi-row copying does not degrade links to plain text.
- Skip mapping for equal headers and reorder automatically when the same unique
  header names appear in a different order.
- Require an explicit one-to-one column mapping only for real header
  mismatches or headerless input.
- Improve column-count mismatch errors with both counts, their difference,
  both header lists, and a note that selection/row-number UI columns are not
  table data.
- Expand the review dialog, shorten displayed links, hide empty result
  sections, and present conflicts in a three-column comparison table.

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
