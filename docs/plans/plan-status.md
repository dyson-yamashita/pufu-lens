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

| plan                                                       | status      | 更新日     | メモ                                                                                                                   |
| ---------------------------------------------------------- | ----------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/001-step-by-step-build-plan/overview.md`       | `blocked`   | 2026-06-13 | Step 10 は Drive / Gmail 実 API smoke 待ち。Step 14 は local dry-run 完了済み、staging GCP identifier / 権限設定待ち。 |
| `docs/plans/002-account-login-public-projects/overview.md` | `completed` | 2026-06-11 | Auth.js ログイン基盤、public project / public report / public chat の入口実装は merge 済み。                           |
| `docs/plans/003-admin-age-viewer/overview.md`              | `completed` | 2026-06-11 | Issue #80 の Graph Viewer 実装は merge 済み。                                                                          |
| `docs/plans/004-project-settings-connections/overview.md`  | `active`    | 2026-06-13 | Project Settings / Connections は Step 1-5 完了。Step 6 / 7 の server enforcement と失効・scope 不足運用が残作業。     |
| `docs/plans/005-storage-recovery-artifacts/overview.md`    | `active`    | 2026-06-13 | Issue #117 / PR #118 で Step 1 完了。Step 2 以降の artifact 統合、reconcile、restore は未着手。                        |
| `docs/plans/006-db-migration-management/overview.md`       | `completed` | 2026-06-13 | Issue #119 / #121 / #123 / #127 / #130 / #133 で DB migration 運用、検証、drift 検出、重い DB 変更方針を整備済み。     |
| `docs/plans/007-data-source-content-preview/overview.md`   | `active`    | 2026-06-15 | Issue #148 で Data Sources 詳細の raw / indexed document、snippet、queue 状態 preview 実装に着手。                     |

## 運用ルール

plan の参照・更新ルールは `.codex/rules/plan-rule.md` に従う。
