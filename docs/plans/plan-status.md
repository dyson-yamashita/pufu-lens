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

| plan                                                       | status      | 更新日     | メモ                                                                                                                                                           |
| ---------------------------------------------------------- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/001-step-by-step-build-plan/overview.md`       | `active`    | 2026-06-11 | Pufu Lens の段階的な構築計画。Step 別 plan は同ディレクトリ配下で管理する。旧インデックスファイルは廃止。                                                      |
| `docs/plans/002-account-login-public-projects/overview.md` | `completed` | 2026-06-11 | Auth.js ログイン基盤、public project / public report / public chat の入口実装は merge 済み。                                                                   |
| `docs/plans/003-admin-age-viewer/overview.md`              | `completed` | 2026-06-11 | Issue #80 の Graph Viewer 実装は merge 済み。                                                                                                                  |
| `docs/plans/004-project-settings-connections/overview.md`  | `active`    | 2026-06-11 | Issue #90 で Project Settings / Connections の実装が進行済み。残作業は後続 Issue で扱う。                                                                      |
| `docs/plans/005-storage-recovery-artifacts/overview.md`    | `active`    | 2026-06-12 | Issue #117 で Storage Recovery Artifacts Step 1 の event object schema / writer / reader を実装中。                                                            |
| `docs/plans/006-db-migration-management/overview.md`       | `active`    | 2026-06-13 | Issue #119 で Step 1、Issue #121 で Step 2、Issue #123 で Step 3、Issue #127 で Step 4、Issue #130 で Step 5 完了。Step 6 で重い DB 変更の運用を継続整備する。 |

## 運用ルール

plan の参照・更新ルールは `.codex/rules/plan-rule.md` に従う。
