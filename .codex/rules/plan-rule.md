# Plan ルール

## 1. 目的

この文書は、`docs/plans/` 配下の plan ファイルと `docs/plans/plan-status.md` の運用を Codex などの AI エージェントでも一貫して扱うためのルールである。

## 2. 参照ルール

- plan を参照する前に `docs/plans/plan-status.md` を確認する。
- `completed` / `deprecated` の plan は、通常の実装・調査時に前提資料として扱わない。
- `completed` / `deprecated` の plan は、ユーザーが明示した場合のみ参照する。
- `blocked` の plan は停止理由を確認し、ユーザーの明示なしに勝手に再開しない。

## 3. 更新ルール

- plan を追加したら、`docs/plans/plan-status.md` の一覧に必ず行を追加する。
- Step に着手するときは、作業開始前に対応する GitHub Issue を作成し、Step の status / 更新日 / メモに Issue 番号を反映する。
- plan の作業が完了したら `status` を `completed` に変更し、必要ならメモに完了範囲を残す。
- Step の作業が完了したら、対応 Issue に紐づく PR を作成し、PR 本文に検証結果と未検証リスクを記載する。
- plan が別 plan に置き換わったら `deprecated` に変更し、メモに置き換え先を残す。
- plan の実態に合わせて `status`、更新日、メモを同時に更新する。
