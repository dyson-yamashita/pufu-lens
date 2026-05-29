# Step 0: 開発基盤と品質ゲート

### 実装する機能

- pnpm workspaces / Turborepo の最小 scaffold
- TypeScript、Biome、Prettier、markdownlint の設定
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test` の初期 script
- `.env.example` と secret を含めない設定雛形
- Gemini 接続設定の雛形（`GEMINI_API_KEY`、`GEMINI_CHAT_MODEL`、`GEMINI_EMBEDDING_MODEL`、`GEMINI_EMBEDDING_DIMENSIONS=1536`、Vertex AI 利用時の project / location）
- CI で実行するコマンド候補の整理

### 確認できること

- リポジトリの基本コマンドが通る。
- Markdown / TypeScript の整形・静的検査方針が固定される。
- 今後の step で品質確認を同じ手順に揃えられる。

### 確認方法

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
git status --short
```

### 完了条件

- 上記コマンドが成功する。
- `.env.local`、token、secret、生成物、`node_modules` が追跡対象に入っていない。
- Gemini の API key や Google Cloud 認証情報が `.env.example` に実値として含まれていない。
- `.env.example` の embedding 次元が DB schema の `vector(1536)` と一致している。

## Step 0 確認記録

- 実施日: 2026-05-29
- 対象 commit: 未コミット
- 実装範囲: pnpm workspaces / Turborepo scaffold、TypeScript / Biome / Prettier / markdownlint 設定、品質確認 script、`.env.example`、CI workflow、CI 品質ゲート文書
- 実行コマンド:
  - `pnpm install`
  - `pnpm format`
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `git status --short`
- 自動テスト結果: `pnpm test` 成功。現時点では各 workspace の no-op test。
- 補助的な手動確認: `.env.example` に secret 実値が含まれないこと、`GEMINI_EMBEDDING_DIMENSIONS=1536` であることを確認。
- DB 確認: Step 0 では DB 未導入。
- Storage 確認: Step 0 では storage 実装未導入。ローカル volume は `.gitignore` 対象。
- ログ / secret 確認: `.env.local`、`.env.*`、`node_modules`、build artifact、`infra/volumes/` を `.gitignore` 対象に追加。
- 未確認リスク: Next.js / Mastra 実体は後続 Step で導入するため、この時点の package は最小 TypeScript scaffold。
- 次 step に進む判断: Step 1 のローカル DB / Storage 実装に進める。
