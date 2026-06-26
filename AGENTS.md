# AGENTS.md

このファイルは、このリポジトリで Codex などの AI エージェントが作業するときの入口ルールです。詳細は `.codex/rules/`、`docs/designs/`、`docs/plans/` を参照してください。

## 基本方針

- 常に日本語で回答する。
- 作業前に `git status --short` を確認し、既存の未コミット変更を把握する。
- ユーザーによる変更を勝手に戻さない。
- 変更前に関連する設計書、ルール、既存ファイルを確認する。
- plan を参照する前に `docs/plans/plan-status.md` を確認し、`completed` / `deprecated` の plan はユーザーが明示した場合を除き参照しない。
- plan の Step に着手するときは、先に `main` を最新化し、その最新 `main` から Step 用ブランチを作成する。
- Step に着手するときは GitHub Issue を作成し、作業完了時は対応 PR を作成する。
- PR 作成後はレビュー支援ツールのコメントを一定時間確認し、対応可能なレビューコメントがあれば対応・返信してから完了報告する。
- 仕様や設計に影響する変更では、関連ドキュメントの更新要否を確認する。

## 参照先

- プロジェクト全体の作業ルール: `.codex/rules/project-rule.md`
- アーキテクチャ境界・認可・runtime guard ルール: `.codex/rules/architecture-rule.md`
- Git / branch / PR / commit ルール: `.codex/rules/git-rule.md`
- format / lint ルール: `.codex/rules/format-rule.md`
- plan ルール: `.codex/rules/plan-rule.md`
- plan ステータス管理: `docs/plans/plan-status.md`
- 作業計画: `docs/plans/`
- システム設計: `docs/designs/system/`
- UI デザイン: `docs/designs/ui/ui-design.md`

## 作業時の注意

- ファイル検索は `rg` / `rg --files` を優先する。
- 手動編集は `apply_patch` を使う。
- 認可、SQL row 取得、app/package 境界、server action の責務に触れる場合は、`.codex/rules/architecture-rule.md` との整合を確認する。
- UI、画面遷移、レイアウト、コンポーネント方針を変更する場合は、`docs/designs/ui/ui-design.md` との整合を確認する。
- Google Workspace データ、個人情報、OAuth token、secret を扱う変更では、収集範囲、PII マスク、ログ出力、コスト影響を確認する。
- テストや検証を実行できない場合は、理由と未検証リスクを最終報告に明記する。
