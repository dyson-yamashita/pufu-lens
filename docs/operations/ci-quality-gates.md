# CI 品質ゲート

この文書は、Pufu Lens の現行 CI とローカル確認コマンドの対応関係を定義する。Vitest / Oxlint は導入しておらず、unit / integration test は Node.js の test runner と `node --experimental-strip-types` による実行、lint / format は Biome、Markdown lint は `markdownlint-cli2` を使う。

## 必須コマンド

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

必要に応じて、Web E2E は次を実行する。

```bash
pnpm test:e2e
```

## 運用メモ

- CI workflow は PR / main push ごとに古い同一 ref の実行をキャンセルし、`format-lint`、`typecheck`、`unit-test`、`db-check`、`build`、`e2e` を job 分割して並列実行する。
- `format:check` は Biome と Prettier の差分有無を検査する。TypeScript / TSX / JavaScript / JSX / JSON / JSONC は Biome、Markdown / YAML は Prettier が担当する。
- `lint` は `biome ci .` と `markdownlint-cli2` を実行する。
- `db:migrate --check` は migration file の命名、番号重複、履歴との整合を検査する。CI では PostgreSQL test container に `init.sql` を適用した後、`DATABASE_URL` 付きで online check として実行する。
- `db:schema-drift` は `init.sql` で作る fresh DB と `baseline + migrations` で作る DB の public schema を比較する。実行には create database 権限付きの `DATABASE_URL` が必要である。
- `typecheck` / `test` / `build` は Turborepo 経由で workspace 配下の package script を実行する。
- `pnpm test` は root で `pnpm scripts:test` を実行してから workspace test を実行する。
- `e2e` は PR の変更ファイルに応じて必要な場合だけ実行する。Playwright browser cache を復元し、cache miss のときだけ Chromium browser を再取得する。
- secret、`.env.local`、`node_modules`、build artifact、ローカル storage volume は追跡対象にしない。

## 完了報告

- PR または Issue の完了報告では、実行したコマンドと結果を列挙する。
- targeted check だけを実行した場合は、全体検証ではなく targeted であることを明記する。
- Docker、PostgreSQL、Playwright browser、外部 API key などの不足で実行できなかった検証は、未検証リスクとして明記する。
- GitHub Checks を確認した場合は、対象 PR と `format-lint`、`typecheck`、`unit-test`、`db-check`、`build`、`e2e` の状態を確認したことを記録する。

## Hook 方針

Stop Hook / PostToolUse hook は現時点では repository に導入しない。現行の強制点は GitHub Actions であり、hook は tool ごとのローカル設定に依存して CI の代替にならない。さらに、DB / Docker / Playwright / 外部 API key を必要とする検証を Stop Hook 実行時に一律実行すると誤検知や開発待ち時間が大きくなる。

hook を導入する場合は、別 Issue で対象 tool、実行タイミング、skip 条件、失敗時の扱い、CI との責務分担、ローカル動作確認結果を明記してから実装する。
