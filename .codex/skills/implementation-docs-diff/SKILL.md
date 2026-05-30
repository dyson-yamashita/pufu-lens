---
name: implementation-docs-diff
description: Check whether implementation changes are reflected in repository documentation. Use when asked to compare code and docs, find drift between implementation and design/plan/rules files, audit a PR for missing doc updates, or update docs after code/review changes.
---

# Implementation Docs Diff

Use this skill to audit implementation/documentation drift before reporting that a step, PR, or review response is complete.

## Workflow

1. Start with repository rules.
   - Run `git status --short`.
   - Read `docs/plans/plan-status.md` before opening plan files.
   - Respect `.codex/rules/project-rule.md`, `plan-rule.md`, and `git-rule.md`.

2. Identify implementation changes.
   - For uncommitted work: inspect `git diff --stat` and targeted diffs.
   - For a PR branch: compare against base with `git diff origin/main...HEAD --stat` after `git fetch origin` if needed.
   - List changed files by area: schema/DB, storage, CLI/scripts, package scripts, API, UI, workflow, security, deployment.

3. Find documentation that should match those changes.
   - Plans: `docs/plans/001-step-by-step-build-plan/overview.md` and the active step file.
   - System design: `docs/designs/system/*.md`.
   - UI design: `docs/designs/ui/*.md` only for UI behavior/layout changes.
   - Operations docs: `docs/operations/*.md`.
   - Project rules: `.codex/rules/*.md` only when workflow, Git, lint, or plan process changes.
   - Root user instructions: `AGENTS.md` only when cross-agent rules change.

4. Search for stale terms.
   - Use `rg` for identifiers, commands, env vars, table/column names, route paths, validation rules, package names, and script names.
   - Include removed dependencies and old commands in the search terms.
   - For security-sensitive changes, search docs for old examples that expose secrets or credentials.

5. Compare contracts, not prose only.
   - Check commands in docs against `package.json` scripts and actual CLI parsing.
   - Check SQL/schema docs against `infra/docker/postgres/init.sql` and relevant package code.
   - Check storage layout docs against `packages/storage` behavior.
   - Check API paths and auth claims against implementation and design docs.
   - Check validation rules in docs against tests and runtime validation.

6. Report or update.
   - If the user asked whether drift exists, report each drift with file links and the matching implementation reference.
   - If the user asked to update docs, edit the smallest relevant docs and then rerun the drift searches.
   - If docs are intentionally ahead of implementation, call that out explicitly as planned/future design.

## Pufu Lens Hotspots

- Project creation: `scripts/create-project.ts`, `packages/project-tenancy`, `packages/storage`, `docs/plans/001-step-by-step-build-plan/step-02-project-tenancy.md`, `docs/designs/system/03-data-model.md`, `docs/designs/system/11-deployment.md`.
- Local DB/storage: `docker-compose.yml`, `infra/docker/postgres/init.sql`, `packages/storage`, Step 1 plan, `docs/designs/system/03-data-model.md`, `04-storage.md`.
- Quality gates: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `biome.json`, `.markdownlint-cli2.jsonc`, `.codex/rules/format-rule.md`, `docs/operations/ci-quality-gates.md`.

## Output Shape

Keep the result concise:

- `差分あり`: list stale doc locations and required updates.
- `差分なし`: state the implementation areas checked and any residual risk.
- `更新済み`: list edited docs and validation/search commands run.
