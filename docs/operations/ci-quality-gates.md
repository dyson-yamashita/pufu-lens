# CI 品質ゲート候補

Step 0 では、以降の実装で共通利用する品質確認コマンドを固定する。

## 必須候補

```bash
pnpm install --frozen-lockfile
pnpm db:migrate --check
pnpm db:schema-drift
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 運用メモ

- CI workflow は PR / main push ごとに古い同一 ref の実行をキャンセルし、format/lint、typecheck、unit test、DB check、build、E2E を job 分割して並列実行する。
- `format:check` は Biome と Prettier の差分有無を検査する。JSON / JSONC は Biome、Markdown / YAML は Prettier が担当する。
- `db:migrate --check` は migration file の命名、番号重複、履歴との整合を検査する。CI では PostgreSQL test container に `init.sql` を適用した後、`DATABASE_URL` 付きで online check として実行する。
- `db:schema-drift` は `init.sql` で作る fresh DB と `baseline + migrations` で作る DB の public schema を比較する。実行には create database 権限付きの `DATABASE_URL` が必要である。
- `lint` は Biome の静的検査と markdownlint を実行する。
- `typecheck` / `test` / `build` は Turborepo 経由で workspace 配下の package script を実行する。
- E2E は PR の変更ファイルに応じて必要な場合だけ実行する。Playwright browser cache を復元し、cache miss のときだけ Chromium browser を再取得する。
- secret、`.env.local`、`node_modules`、build artifact、ローカル storage volume は追跡対象にしない。
