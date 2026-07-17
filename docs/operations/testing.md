# テスト運用

## Unit test

`pnpm test` は root の `scripts:test` と各 workspace の `test` task を実行する。

- `scripts:test`: `scripts/**/*.test.ts` を `node --experimental-strip-types --test` で実行する。DB へ接続せず、script helper や migration helper の pure unit test を対象にする。
- `turbo run test`: `apps/*` と `packages/*` の unit test を実行する。`packages/*` は各 package の `test` script 内で `tsc` を実行し、生成された `dist/**/*.test.js` を Node test runner で実行する。

DB 接続を伴う migration / schema 検証は CI の `db-check` job で `pnpm db:migrate --check` と `pnpm db:schema-drift` として分離する。`scripts:test` には実 DB 接続を追加しない。

Source sync の差分取り込みと定期実行、および定期レポート生成は、collector、chunk置換、dispatcher、Mastra内部API、report UI の決定的なunit / integration / E2E testを組み合わせて確認する。実providerや本番credentialをテストから呼ばない。ローカル・stagingの運用確認と障害時の判断は [Source Sync Scheduling 運用手順](source-sync-scheduling.md) と [定期レポート Scheduling 運用手順](report-scheduling.md) に従う。

## Turbo cache

`turbo.json` の `test` task は `cache:false` とする。Unit test には runtime guard、DB row parser、storage adapter など実行時の安全性を確認するテストが含まれ、将来 DB 接続や fixture 依存のテストが package 側に追加されても stale cache で結果を取り違えないことを優先する。

`cache:false` では Turborepo の cache key 計算に使う `inputs` は実行判定に使われないため、test task には個別 `inputs` を設定しない。テストは入力ハッシュでの再利用より、常時実行を優先する。

## Coverage

現時点では全 workspace の coverage gate は導入しない。理由は、root scripts は `--experimental-strip-types` で TypeScript source を直接実行し、`packages/*` は `tsc` 後の `dist` を実行し、`apps/web` は Next.js / Playwright を含むため、単一の coverage しきい値を置くと source map と測定対象のずれが大きいからである。

代わりに、scripts 配下の pure unit test については Node 組み込み coverage を使う `pnpm scripts:test:coverage` を提供する。全 workspace coverage を必須化する場合は、別 Issue で c8 などの reporter、source map、除外対象、CI artifact の保存方針をまとめて決める。
