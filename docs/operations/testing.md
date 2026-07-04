# テスト運用

## Unit test

`pnpm test` は root の `scripts:test` と各 workspace の `test` task を実行する。

- `scripts:test`: `scripts/**/*.test.ts` を `node --experimental-strip-types --test` で実行する。DB へ接続せず、script helper や migration helper の pure unit test を対象にする。
- `turbo run test`: `apps/*` と `packages/*` の unit test を実行する。`packages/*` は build 済み `dist/**/*.test.js` を Node test runner で実行する。

DB 接続を伴う migration / schema 検証は CI の `db-check` job で `pnpm db:migrate --check` と `pnpm db:schema-drift` として分離する。`scripts:test` には実 DB 接続を追加しない。

## Turbo cache

`turbo.json` の `test` task は `cache:false` とする。Unit test には runtime guard、DB row parser、storage adapter など実行時の安全性を確認するテストが含まれ、将来 DB 接続や fixture 依存のテストが package 側に追加されても stale cache で結果を取り違えないことを優先する。

`inputs` は既定入力に加えて `src/**/*.test.ts`、`src/**/*.test.js`、`fixtures/**` を明示する。これにより、テストファイルや fixture の変更が test task の変更要因として読み取れる。

## Coverage

現時点では全 workspace の coverage gate は導入しない。理由は、root scripts は `--experimental-strip-types` で TypeScript source を直接実行し、`packages/*` は `tsc` 後の `dist` を実行し、`apps/web` は Next.js / Playwright を含むため、単一の coverage しきい値を置くと source map と測定対象のずれが大きいからである。

代わりに、scripts 配下の pure unit test については Node 組み込み coverage を使う `pnpm scripts:test:coverage` を提供する。全 workspace coverage を必須化する場合は、別 Issue で c8 などの reporter、source map、除外対象、CI artifact の保存方針をまとめて決める。
