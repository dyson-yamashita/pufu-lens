# Step 10a: scripts 実行形式の `.ts` 統一

### 実装する機能

既存の scripts 実行形式を `.ts` に統一する。strict typecheck 対応は Step 10b に分け、この step では実行形式と参照パスの整理だけを行う。

- 旧拡張子の実行用 scripts を `scripts/*.ts` にリネームする。
- `package.json` の script 実行コマンドを `node --experimental-strip-types scripts/*.ts` に統一する。
- `scripts/ingest-workflow.ts` の子プロセス起動でも `--experimental-strip-types` を付ける。
- `scripts/ingest-workflow.ts` が参照する子 script path を `.ts` に更新する。
- docs / plans / script 内 metadata などの旧 script path 参照を `.ts` に更新する。

この step では次を行わない。

- `tsconfig.scripts.json` の追加
- scripts 全体の strict typecheck 対応
- 暗黙 `any` や repository class property の型注釈整理
- 追加 dependency の導入

### 確認できること

- scripts の拡張子と実行方法が `.ts` に統一される。
- 既存 CLI は Node v22 系の `--experimental-strip-types` で実行できる。
- `ingest:run` / `ingest:retry` の workflow 子 step でも `.ts` script が実行対象になる。
- docs / plans の確認コマンドが実際の script path と一致する。

### 確認方法

```bash
for f in scripts/*.ts; do node --experimental-strip-types --check "$f"; done
node --experimental-strip-types scripts/ingest-workflow.ts run --project sample-a --source web --limit 1 --dry-run
pnpm format:check
pnpm test
```

Docker daemon とローカル DB / storage が利用できる場合は、Step 10 の Web URL smoke test も合わせて実行する。

```bash
pnpm ingest:collect --project sample-a --source web --limit 5 --dry-run
pnpm ingest:run --project sample-a --source web --limit 5 --embedding-provider deterministic
pnpm ingest:inspect --project sample-a --source web --limit 5 --format json
```

### 完了条件

- `scripts/` 配下の実行用 script が `.ts` に統一されている。
- `package.json` から旧拡張子の script 実行参照がなくなっている。
- `ingest-workflow` の dry-run で collect / parse / resolve / chunk / graph の argv が `.ts` script を指す。
- docs / plans の script path が Step 10a 実装後の `.ts` path に追従している。
- `pnpm format:check` と `pnpm test` が通る。

## Step 10a 確認記録

- 実施日: 2026-06-02
- 対象 Issue: #32
- 実装範囲: `scripts/` 配下の実行用 script を `.ts` に統一し、root `package.json` の script 実行を `node --experimental-strip-types` に更新。`ingest-workflow` の子プロセス起動にも `--experimental-strip-types` を追加し、子 step の script path を `.ts` に更新。docs / plans / script metadata の script path 参照も `.ts` に追従。
- 実行コマンド:
  - `for f in scripts/*.ts; do node --experimental-strip-types --check "$f"; done`
  - `node --experimental-strip-types scripts/ingest-workflow.ts run --project sample-a --source web --limit 1 --dry-run`
  - `pnpm format:check`
  - `pnpm test`
  - `docker info --format '{{.ServerVersion}}'`
- 自動テスト結果: 全 script の strip-types 構文チェック、workflow dry-run、`pnpm format:check`、`pnpm test` が通過。dry-run では collect / parse / resolve / chunk / graph の argv が `.ts` script を指し、LLM 使用量 0 を確認。
- 補助的な手動確認: `rg` で旧拡張子参照と旧 Node 実行形式の残存がないことを確認。
- DB 確認: Docker daemon に接続できず、実 DB smoke は未実施。
- Storage 確認: Docker daemon に接続できず、実 URL storage smoke は未実施。
- ログ / secret 確認: workflow dry-run の構造化ログで raw / parsed 本文、token、secret の出力がなく、LLM 使用量 0 であることを確認。
- 未確認リスク: Docker daemon 未起動のため、Step 10 の Web URL 実データ `--limit 5` smoke test は未実施。
- 次 step に進む判断: scripts 実行形式の `.ts` 統一は完了。次は Step 10b で scripts strict typecheck 対応を進める。
