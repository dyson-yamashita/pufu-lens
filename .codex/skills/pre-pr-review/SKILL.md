---
name: pre-pr-review
description: Self-review the current branch diff against main before creating a Pufu Lens PR. Use right before `gh pr create`, when asked to check whether a branch is ready for PR, or to pre-empt CodeRabbit / CI findings locally. Review-only skill; it reports severity-ranked findings and does not modify code.
---

# Pre-PR Review — Pufu Lens

PR 作成前に `main` との差分をセルフレビューし、CodeRabbit / CI が指摘する問題を PR 作成前に検出するためのスキル。

このスキルは **レビューのみ** を行い、コードの修正は行わない。修正は呼び出し元のセッションが指摘を受けて実施し、修正後に本スキルを再実行する。

## 実行タイミング

- `gh pr create` の直前に必ず実行する。
- Critical / Major 相当の指摘が 1 件でも残っている間は PR を作成しない。
- 機械チェック（format / lint / typecheck / test）が失敗した場合は、レビュー結果に関わらず **Fail** とし、PR 作成に進まない。

## 手順

### 1. 差分の確定

```bash
git fetch origin main
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

- 差分が大きい場合はファイル単位で分割して読む。
- 変更ファイルを領域別（schema/DB、storage、scripts、API、server action、UI、workflow、CI、docs）に分類する。

### 2. 機械チェック

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

- DB schema / migration を変更した場合は `pnpm db:migrate --check` と `pnpm db:schema-drift` も実行する。
- `apps/web` / `packages` に変更がある場合は、必要に応じて `pnpm test:e2e` を実行する。

### 3. 差分レビュー

`.coderabbit.yaml` および `.codex/rules/git-rule.md` の「コミット前チェック」と同じ観点で、変更差分（差分のみ。既存コードのスコープ外指摘はしない）を確認する。

| 観点           | 確認内容                                                                                                               | 重要度目安       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| secret / PII   | secret・`.env` 実値・OAuth token・PII が diff / SQL / fixture / log 出力に含まれない                                   | Critical         |
| 認可           | 認可判定が `apps/web/src/authz.ts` または専用 authz module に集約されている                                            | Critical / Major |
| server action  | server action に SQL・外部 process 実行・storage 操作・複雑な mapping が蓄積していない                                 | Major            |
| SQL row cast   | `rows[0] as SomeRow` / `as SomeRow[]` 等、runtime guard なしの `as` cast を新規追加していない                          | Major            |
| package 境界   | app 間の `src` 相対 import がなく、workspace dependency / turbo 依存グラフから外れる暗黙依存がない                     | Major            |
| scripts helper | `requiredEnv` / `parseArgs` / `validateGraphName` 等の汎用 helper を重複定義していない                                 | Minor            |
| 責務分離       | god file への責務追加、UI とデータ処理の混在がない                                                                     | Minor            |
| DB migration   | `infra/docker/postgres/init.sql`・`infra/db/migrations/*.sql`・baseline seed の更新要否、destructive change の互換期間 | Major            |
| テスト         | 変更に対応するテストが追加・更新されている                                                                             | Major / Minor    |

機械的に検出できる観点は検索で補助する。

```bash
rg -n 'as [A-Z][A-Za-z]*Row(\[\])?' apps packages --type ts
rg -n "from '\.\./\.\./\.\./apps/" apps packages --type ts
```

### 4. ドキュメント整合

実装変更が仕様・設計・plan に影響する場合は `implementation-docs-diff` スキルで docs との drift を確認する。

### 5. 判定と報告

- 指摘は CodeRabbit と同じ重要度（Critical / Major / Minor / Trivial / Info）を付け、重要度順に報告する。
- 報告の先頭に重要度サマリ（各重要度の件数、マージ前対応の要否）を置く。
- 各指摘には対象ファイル・行、問題の内容、期待される修正方針を含める。曖昧な指摘（「動作がおかしい」等）は禁止。
- Critical / Major が 0 件かつ機械チェックが全パスの場合のみ **Pass** とし、PR 作成に進んでよい。
- Fail の場合は指摘を報告して終了する。修正後に本スキルを再実行する。
- Pass 後の PR 本文には、本スキルで検出し対応した指摘があればその要約を記載する。
