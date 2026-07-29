# Project Rules

## Scope

This file applies only to `siyuan-table-merge/`. Do not mix its source,
versions, dependencies, build output, or release operations with the sibling
`detach-tab/` project.

## Approval Gate

- Read-only inspection is allowed when needed to prepare an accurate proposal.
- Before any implementation, file modification, build, local packaging,
  installation, Git commit/push/tag, GitHub Release, or marketplace submission,
  first present the concrete plan to the user and wait for explicit approval.
- Approval for one plan does not authorize later materially different work.

## Local Packaging

- A local package operation must generate both artifacts in the same run:
  - `package.zip`
  - `release/siyuan-table-merge/`, ready to move directly into SiYuan's
    `data/plugins/` directory for manual testing.
- `npm run package` is the canonical command and must keep verifying that both
  outputs contain the required plugin files.
- Local packaging is not publication.

## Publication

- Default state is **do not publish**. Building or packaging locally never
  authorizes a Git push, tag, GitHub Release, Bazaar submission, or installation
  into a real SiYuan workspace.
- Publish only after the user explicitly approves a publication plan.
- The plugin is already listed in SiYuan Bazaar. Routine updates require only
  updating this repository and its release notes, then publishing a new tag;
  Bazaar pulls the new release automatically, so do not open another listing
  PR.
- The last verified public GitHub tag and Release is `v0.2.0`
  (`11463b0`, published and package-verified 2026-07-29).
- Before any future publication, verify the current remote Release/tag again,
  choose the intended next public version with the user, and align
  `package.json`, `package-lock.json`, and `plugin.json`.

## Verification

Run commands from this project directory. The standard validation sequence is:

```powershell
npm ci
npm run check
npm test
npm run package
npm run validate:marketplace
```
