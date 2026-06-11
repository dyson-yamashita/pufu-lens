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

| plan                                                       | status    | 更新日     | メモ                                                                                                |
| ---------------------------------------------------------- | --------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `docs/plans/001-step-by-step-build-plan/overview.md`       | `active`  | 2026-05-29 | Pufu Lens の段階的な構築計画。Step 別 plan は同ディレクトリ配下で管理する。                         |
| `docs/plans/002-account-login-public-projects/overview.md` | `active`  | 2026-06-08 | Issue #63 から派生し、Step 2 は Issue #76 で Auth.js ログイン基盤を実装中。                         |
| `docs/plans/003-admin-age-viewer/overview.md`              | `active`  | 2026-06-10 | Issue #80 で、プロジェクトごとの Graph と固定 query preset による Apache AGE graph 可視化を実装中。 |
| `docs/plans/004-project-settings-connections/overview.md`  | `planned` | 2026-06-11 | Project Settings で Google / GitHub 連携を管理し、未連携 data source の選択・実行を制御する。       |

## 運用ルール

plan の参照・更新ルールは `.codex/rules/plan-rule.md` に従う。
