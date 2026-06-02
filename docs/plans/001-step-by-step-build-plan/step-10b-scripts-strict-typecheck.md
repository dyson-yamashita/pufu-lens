# Step 10b: scripts strict typecheck 対応

### 実装する機能

Step 10a で `.ts` に統一した scripts を TypeScript の型チェック対象にする。実行形式の統一とは分け、型安全性を段階的に整備する。

- scripts 用の typecheck 経路を追加する。
  - `tsconfig.scripts.json` を追加する、または同等の `pnpm` script を整備する。
  - root の `pnpm typecheck` から scripts typecheck を実行するか、明示的な `pnpm scripts:typecheck` を追加する。
- 暗黙 `any` を解消する。
- CLI args の型を定義し、parse 結果の shape を明確にする。
- repository class の `sql`、`storage`、`sourceType`、`graphName` などの property 型を明示する。
- `../packages/*/dist/*.js` import の型解決方法を整理する。
- strict typecheck で通る状態にする。

### 確認できること

- scripts の型エラーを CI / ローカル品質ゲートで検出できる。
- CLI option の typo や repository method の shape 不一致を実行前に見つけられる。
- Step 10 以降の ingestion / inspection CLI を型付きで保守できる。

### 確認方法

```bash
pnpm scripts:typecheck
pnpm typecheck
pnpm test
pnpm format:check
```

`scripts:typecheck` という script 名を採用しない場合は、scripts typecheck 用に追加した実コマンドを確認記録に明記する。

### 完了条件

- scripts 用 typecheck が追加され、全 scripts が対象になっている。
- scripts typecheck が strict 相当の設定で通る。
- root の品質ゲートから scripts typecheck を実行できる、または CI / 運用ドキュメントに明示的な実行コマンドが記載されている。
- `pnpm typecheck` と `pnpm test` が通る。
- Step 10a で統一した `.ts` 実行形式は維持される。

## Step 10b 確認記録

- 実施日: 2026-06-02
- 対象 Issue: #34
- 実装範囲: `tsconfig.scripts.json` と `pnpm scripts:typecheck` を追加し、root `pnpm typecheck` から scripts typecheck を実行するようにした。Step 10a で `.ts` 化した scripts 全体に型注釈を追加し、`allowImportingTsExtensions` で既存の `.ts` import 実行形式を維持した。
- 実行コマンド:
  - `pnpm scripts:typecheck`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm format`
  - `pnpm format:check`
- 自動テスト結果: `pnpm scripts:typecheck`、`pnpm typecheck`、`pnpm test`、`pnpm format:check` が通過。
- 補助的な手動確認: `git diff --stat` と主要設定ファイル差分を確認し、scripts typecheck が root 品質ゲートに含まれることを確認。
- DB 確認: 型チェック経路の追加が対象であり、DB 接続を伴う smoke test は未実施。
- Storage 確認: 型チェック経路の追加が対象であり、Storage 実体を使う smoke test は未実施。
- ログ / secret 確認: 実データ収集や DB / Storage 実行はしていないため、secret を含むログ出力は発生していない。
- 未確認リスク: scripts の DB row / repository 境界は段階導入として広めの明示型を残している。今後の source 追加時に具体型へ狭める余地がある。
- 次 step に進む判断: scripts typecheck が root 品質ゲートに入り、Step 10a の `.ts` 実行形式を維持したまま通過したため Step 10b は完了。
