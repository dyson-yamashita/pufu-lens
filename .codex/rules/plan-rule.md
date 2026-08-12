# Plan ルール

## 1. 目的

この文書は、`docs/plans/` 配下の plan ファイルと `docs/plans/plan-status.md` の運用を Codex などの AI エージェントでも一貫して扱うためのルールである。

## 2. 参照ルール

- plan を参照する前に `docs/plans/plan-status.md` を確認する。
- `completed` / `deprecated` の plan は、通常の実装・調査時に前提資料として扱わない。
- `completed` / `deprecated` の plan は、ユーザーが明示した場合のみ参照する。
- `blocked` の plan は停止理由を確認し、ユーザーの明示なしに勝手に再開しない。

## 3. Step タスクルール

- plan の Step に着手するときは、Step ごとに独立した Codex タスク（thread / session）を先に作成する。
- 1 つの Codex タスクで複数の Step を実装しない。前の Step の PR が merge され、次の Step へ進む場合は新しいタスクを作成する。
- タスク作成時は、対象 plan のパスと Step、最新 `main` から開始すること、GitHub Issue / Step 用ブランチ / PR の作成要件をタスクの指示に含める。
- タスクの作成に失敗した場合は、元のタスク内で Step 実装を開始せず、worktree、ホスト接続、同時実行状態を確認して再試行する。解消できない場合は、原因と未着手であることをユーザーに報告する。

## 4. 更新ルール

- plan を追加したら、`docs/plans/plan-status.md` の一覧に必ず行を追加する。
- Step に着手するときは、作業開始前に `main` を最新化し、その最新 `main` から Step 用ブランチを作成する。
- Step に着手するときは、作業開始前に対応する GitHub Issue を作成し、Step の status / 更新日 / メモに Issue 番号を反映する。
- Step が認可、DB row、app/package 境界、server action 分割に影響する場合は、着手前に `.codex/rules/architecture-rule.md` の該当項目を確認し、必要なら Issue に分割方針を記載する。
- plan の作業が完了したら `status` を `completed` に変更し、必要ならメモに完了範囲を残す。
- Step の作業が完了したら、対応 Issue に紐づく PR を作成し、PR 本文に検証結果と未検証リスクを記載する。
- plan が別 plan に置き換わったら `deprecated` に変更し、メモに置き換え先を残す。
- plan の実態に合わせて `status`、更新日、メモを同時に更新する。
