---
name: pre-pr-review-thread
description: Create an independent Codex thread for pre-PR review of the current repository changes. Use when the user asks to review work before opening a pull request, wants review quality separated from the implementation session, or asks Codex to launch a review-only thread for branch/worktree diffs.
---

# Pre-PR Review Thread

## Overview

Use this skill to launch a fresh Codex thread that reviews repository changes before a PR is created. The review thread should inspect the diff, follow Pufu Lens repository rules, report findings only, and avoid applying fixes unless the user explicitly asks in that review thread.

## Workflow

1. Confirm the local state.
   - Run `git status --short`.
   - Note existing untracked or modified files before doing anything else.
   - Do not revert or clean user changes.

2. Create a new review thread, not a fork.
   - Prefer `create_thread` for independence from implementation context.
   - Do not use `fork_thread` for pre-PR review unless the user asks for history to be copied.
   - If thread tools are not loaded, use `tool_search` to find `list_projects` and `create_thread`.
   - Call `list_projects` first and choose the current `pufu-lens` project.
   - Create the thread in the project local environment unless the user asks for a separate worktree.

3. Pass a review-only prompt.
   - Include the current branch/base assumption.
   - Tell the review thread to inspect the diff only.
   - Tell it not to edit files, stage changes, commit, push, create issues, or create a PR.
   - Tell it to follow `AGENTS.md`, `.codex/rules/`, and relevant design docs.

4. Report the created thread.
   - After `create_thread` succeeds, include the required `::created-thread{...}` directive in the final response.
   - Mention that the review will happen in the new thread and that this implementation thread remains unchanged.
   - Keep the returned `threadId` available for later result retrieval in the current thread.

5. Retrieve review results when requested.
   - If the user asks for the review result in the implementation thread, use `read_thread` on the created review `threadId`.
   - If `read_thread` is not loaded, use `tool_search` to find `read_thread`.
   - If the review thread is still running, report that it is not complete yet and offer to check again.
   - If the review thread completed, summarize the final findings in the implementation thread.
   - Preserve severity labels (`P0` / `P1` / `P2`), file links, verification results, and residual risks.
   - Do not silently fix findings while retrieving results. Ask or wait for an explicit fix request.

## Review Prompt

Use this prompt as the basis for the new thread. Adjust only the branch/base or scope details the user provided.

```text
PR作成前レビューをしてください。

対象はこのリポジトリの現在の作業ツリーおよび現在ブランチの差分です。
base は `main` とし、可能なら `origin/main...HEAD`、未コミット変更がある場合は `git diff` / `git diff --staged` / 未追跡ファイルも確認してください。

あなたは実装者ではなく独立レビュアーです。
修正、ファイル編集、stage、commit、push、Issue作成、PR作成は行わず、レビュー結果だけを返してください。

最初に `git status --short` を確認してください。
`AGENTS.md`、`.codex/rules/project-rule.md`、`.codex/rules/git-rule.md`、`.codex/rules/format-rule.md` を確認してください。
plan を参照する必要がある場合は、先に `docs/plans/plan-status.md` を確認し、completed / deprecated の plan はユーザーが明示していない限り参照しないでください。
認可、SQL row 取得、app/package 境界、server action、runtime guard に触れる差分があれば `.codex/rules/architecture-rule.md` との整合を確認してください。
UI、画面遷移、レイアウト、コンポーネント方針に触れる差分があれば `docs/designs/ui/ui-design.md` との整合を確認してください。
仕様や設計に影響する変更であれば、関連する `docs/designs`、`docs/plans`、`docs/operations` の更新漏れも確認してください。

優先して見る観点:
- P0/P1 のバグ、データ破壊、セキュリティ、認可漏れ
- PII、secret、OAuth token、ログ出力、Google Workspace scope の扱い
- SQL row 取得、tenant/project 境界、runtime guard、server action の責務
- app/package 境界違反、相対 import、重複 helper、god file 化
- テスト不足、検証不足、ドキュメント不整合
- PR 前に直すべき lint / typecheck / build / test の不足

出力形式:
- Findings first。重大度順に並べる。
- 各指摘は `P0` / `P1` / `P2`、ファイル・行、問題、影響、最小修正案を含める。
- 指摘がない場合は「重大な指摘なし」と明記し、確認した範囲と残る未検証リスクだけを書く。
- まとめは短く。修正実装はしない。
```

## Fallback

If a new Codex thread cannot be created from the current environment, provide the review prompt to the user and explain that they should paste it into a fresh Codex thread for best independence. Do not silently fall back to reviewing in the implementation session unless the user asks for same-session review.
