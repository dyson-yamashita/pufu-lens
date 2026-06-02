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

- 実施日:
- 対象 Issue:
- 実装範囲:
- 実行コマンド:
- 自動テスト結果:
- 補助的な手動確認:
- DB 確認:
- Storage 確認:
- ログ / secret 確認:
- 未確認リスク:
- 次 step に進む判断:
