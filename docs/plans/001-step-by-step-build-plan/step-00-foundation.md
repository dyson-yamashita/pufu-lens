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
