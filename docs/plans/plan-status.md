# Plan Status

このファイルは `docs/plans/` 配下の plan ファイルの状態を管理するための索引である。
エージェントは個別の plan を読む前にこのファイルを確認し、`completed` / `deprecated` の plan を通常作業の参照対象にしない。

## ステータス定義

| status       | 意味                         | 参照ルール                               |
| ------------ | ---------------------------- | ---------------------------------------- |
| `planned`    | 未着手。今後実施予定。       | 作業対象として参照してよい。             |
| `active`     | 現在の主要計画。             | 優先して参照する。                       |
| `blocked`    | 外部要因や判断待ちで停止中。 | 理由を確認し、勝手に再開しない。         |
| `completed`  | 完了済み。                   | ユーザーが明示した場合を除き参照しない。 |
| `deprecated` | 破棄・置き換え済み。         | ユーザーが明示した場合を除き参照しない。 |

## Plan 一覧

| plan                                                       | status      | 更新日     | メモ                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/001-step-by-step-build-plan/overview.md`       | `completed` | 2026-06-21 | Step 10 の Drive / Gmail one-pass 実 API 確認と Step 14 の GCP deploy が完了済み。後続詳細作業は 004 / 005 / 007 で管理。                                                                                                                                                         |
| `docs/plans/002-account-login-public-projects/overview.md` | `completed` | 2026-06-11 | Auth.js ログイン基盤、public project / public report / public chat の入口実装は merge 済み。                                                                                                                                                                                      |
| `docs/plans/003-admin-age-viewer/overview.md`              | `completed` | 2026-06-11 | Issue #80 の Graph Viewer 実装は merge 済み。                                                                                                                                                                                                                                     |
| `docs/plans/004-project-settings-connections/overview.md`  | `completed` | 2026-06-28 | Step 1-7 完了。Project Settings 連携管理、Data Source 選択制御、server action / CLI enforcement、失効・scope 不足・解除済み connection の運用表示と deploy checklist 更新まで merge 済み。                                                                                        |
| `docs/plans/005-storage-recovery-artifacts/overview.md`    | `active`    | 2026-06-13 | Issue #117 / PR #118 で Step 1 完了。Step 2 以降の artifact 統合、reconcile、restore は未着手。                                                                                                                                                                                   |
| `docs/plans/006-db-migration-management/overview.md`       | `completed` | 2026-06-13 | Issue #119 / #121 / #123 / #127 / #130 / #133 で DB migration 運用、検証、drift 検出、重い DB 変更方針を整備済み。                                                                                                                                                                |
| `docs/plans/007-data-source-content-preview/overview.md`   | `completed` | 2026-06-21 | Issue #148 / PR #150 で content preview を実装・検証。Issue #212 / PR #213 で row parsing を helper 化済み。Chat / Graph 導線は後続 plan 候補に分離。                                                                                                                             |
| `docs/plans/008-agent-raw-reading/overview.md`             | `completed` | 2026-06-24 | Step 1–6 完了: Agent Raw Read View contract、Parser Profiles 廃止、adapter / repository、private chat/report raw 補完、trace / eval / docs 整備済み。                                                                                                                             |
| `docs/plans/009-oss-deployment-options/overview.md`        | `completed` | 2026-06-26 | Issue #318 で Step 1 完了。Issue #325 で Step 2 の GCP Cloud Build CI example を追加。Issue #327 で Step 3 の deploy example を追加。Issue #329 で Step 4 の GCP Cloud Build operations docs を追加。Issue #331 で Step 5 の provider expansion guide を追加し、plan 全体を完了。 |
| `docs/plans/010-editing-techniques-chat/overview.md`       | `completed` | 2026-06-28 | Issue #361 で selector なしの editing metadata 自動判定、Agent instructions、response metadata、compact UI 表示、unit / e2e / eval fixture 検証を実装。                                                                                                                           |
| `docs/plans/011-custom-report-layouts/overview.md`         | `planned`   | 2026-06-30 | Issue #377 で追加。カスタムレポート形式、汎用 `fixed_image`、判定パーツ、template import/export、PDF ダウンロードの実装計画。                                                                                                                                                     |

## 運用ルール

plan の参照・更新ルールは `.codex/rules/plan-rule.md` に従う。
