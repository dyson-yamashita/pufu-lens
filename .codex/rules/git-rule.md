# Pufu Lens Git ルール

## 1. 目的

この文書は、Pufu Lens の Git / GitHub Flow / branch / PR / commit の運用を Codex などの AI エージェントでも一貫して扱うためのルールである。

## 2. GitHub Flow

- `main` / `master` への直接 push / コミットは禁止。PR 必須、merge 後は branch を削除し短命に保つ。
- 1 branch = 1 issue。
- plan の Step に限らず、機能修正、バグ修正、ドキュメント修正、設定変更など、変更をリポジトリに入れる作業は GitHub Issue と対応 PR を作成する。
- 質問回答、調査のみ、変更を伴わない確認は Issue / PR 作成の対象外とする。

## 3. ブランチ命名（GitHub Flow / AI 向け）

形式:

```text
<type>/issue-<issue-number>-<short-description>
```

例: `feature/issue-123-add-user-search`、`fix/issue-245-fix-login-timeout`

| type       | 用途         |
| ---------- | ------------ |
| `feature`  | 新機能       |
| `fix`      | バグ修正     |
| `hotfix`   | 緊急修正     |
| `refactor` | リファクタ   |
| `chore`    | 雑務・保守   |
| `docs`     | ドキュメント |
| `test`     | テスト       |
| `ci`       | CI/CD 修正   |

ルール:

- 順序は固定: `type` → `issue-number` → `description`
- description は kebab-case のみ（`a-z` `0-9` `-`）。60 文字以内・3〜6 語程度
- 必ず Issue 番号を含める
- plan の Step 用ブランチは、作成前に `main` を最新化し、最新の `main` から作成する
- 禁止: ユーザー名・日付・日本語・camelCase / snake_case・曖昧名（`fix-stuff` 等）

CI / hook 用 regex:

```regex
^(feature|fix|hotfix|refactor|chore|docs|test|ci)\/issue-[0-9]+-[a-z0-9-]+$
```

AI エージェントは上記に従って branch を作成する。

## 4. コミット・PR・Issue

- コミットメッセージは Conventional Commits 形式。
- GitHub の Issue 起票、PR タイトル、PR 本文、PR 上のコメント、Issue / PR コメントは日本語で書く。
- 外部仕様名、エラー文、コード識別子、引用が必要なログは原文のまま記載してよいが、説明は日本語で補足する。
- PR 本文には、該当する場合、認可 / runtime guard / module 境界への影響、追加・変更した検証、例外的に許容した設計負債と理由を記載する。
- PR はユーザーが明示的に draft を指定した場合を除き、ready/open PR として作成する。作業途中、検証未完了、レビュー待ちなどを理由に draft を既定にしない。
- UI のレイアウト、スタイル、文言、表示状態、画面操作など、画面修正を含む PR では、レビュー対象が分かる修正後の画面キャプチャを PR 本文の「修正後の画面」セクションに添付する。
- レスポンシブ表示に影響する場合は、影響を受ける各 viewport の画面キャプチャを添付する。操作や状態遷移に関する変更では、変更内容を確認できる状態を撮影する。
- 画面キャプチャには実データの PII、secret、token を含めず、テストデータを使用するか必要な箇所をマスクする。画面修正を含まない PR は、PR 本文で画面キャプチャが対象外であることを示す。
- Step に着手するときは、作業開始前に対応する GitHub Issue を作成する。
- Step の作業が完了したら、対応 Issue に紐づく PR を作成する。
- Step 用ブランチは、対応 Issue 番号を含むブランチ命名ルールに従う。
- plan 外の変更作業に着手するときも、作業開始前に対応する GitHub Issue を作成する。
- plan 外の変更作業が完了したら、対応 Issue に紐づく PR を作成する。
- plan 外の変更作業用ブランチも、作成前に `main` を最新化し、対応 Issue 番号を含むブランチ命名ルールに従う。
- PR 作成前に `.codex/skills/pre-pr-review` スキルでセルフレビューを実行し、Critical / Major 相当の指摘を解消してから PR を作成する。
- PR 作成後はレビュー支援ツールが起動する前提で、少なくとも 5 分間はレビューコメントの有無を適切な間隔（例: 1〜2 分おき）で定期確認する。
- PR 作成後の確認中にレビューコメントや requested changes が付いた場合は、作業範囲内で対応し、必要な検証を実行してから追加 commit / push する。
- PR レビューコメントで指摘を受けて対応した場合は、対応完了後に該当レビューコメントへ返信し、対応内容と必要に応じて検証結果を日本語で簡潔に記載する。
- レビュー対応後も、再レビューコメントが追加されていないか短時間確認し、未対応コメントを残したまま完了報告しない。

## 5. コミット前チェック

1. `git status --short`
2. `git diff --staged`
3. secret や `.env` が含まれていないこと
4. 不要な生成物や `node_modules` が含まれていないこと
5. 関連テストまたは検証結果
6. 認可 SQL、SQL row cast、app 間相対 import、script helper 重複、god file への責務追加がないこと

## 6. pre-push hook

- `pnpm install` 時の `prepare` script が `core.hooksPath` を `.githooks` に設定し、push 前に `.githooks/pre-push` が `pnpm format:check` / `pnpm lint` / `pnpm typecheck` を強制する。
- チェック失敗時は push が中断される。修正してから再 push する。
- 緊急回避（CI 修正の push 等）に限り `PUFU_LENS_SKIP_PREPUSH=1 git push` でスキップできる。常用しない。
