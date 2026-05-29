# Codex 作業ルール

## 1. 目的

この文書は、Pufu Lens を Codex で安全かつ一貫して開発するための詳細ルールである。


## 2. 作業開始時の確認

作業前に以下を確認する。

1. `git status --short`
2. 関連する設計書と計画書
3. 変更対象の既存ファイル
4. 仕様変更を伴うかどうか
5. Google Workspace scope、PII、コスト、テストへの影響範囲

仕様変更を伴う場合は、実装だけでなく `docs/designs/*` の更新が必要か判断する。

## 3. フロントエンド実装ルール

- ボタン、入力、フォーム、重要な表示に安定した `data-testid` を付与する。
- `data-testid` は `{component}-{element-role}` 形式を基本にする。
- API 通信、状態管理、UI 表示の責務を分ける。
- 画面上のテキストがモバイル・デスクトップで重ならないよう確認する。

## 4. Git ルール

Git / branch / PR / commit の運用は `.codex/rules/git-rule.md` に従う。
