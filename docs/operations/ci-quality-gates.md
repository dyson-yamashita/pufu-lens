# CI 品質ゲート候補

Step 0 では、以降の実装で共通利用する品質確認コマンドを固定する。

## 必須候補

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 運用メモ

- `format:check` は Biome と Prettier の差分有無を検査する。
- `lint` は Biome の静的検査と markdownlint を実行する。
- `typecheck` / `test` / `build` は Turborepo 経由で workspace 配下の package script を実行する。
- secret、`.env.local`、`node_modules`、build artifact、ローカル storage volume は追跡対象にしない。
