# テスト運用

## Unit test

`pnpm test` は root の `scripts:test` と各 workspace の `test` task を実行する。

- `scripts:test`: `scripts/**/*.test.ts` を `node --experimental-strip-types --test` で実行する。DB へ接続せず、script helper や migration helper の pure unit test を対象にする。
- `turbo run test`: `apps/*` と `packages/*` の unit test を実行する。多くの `packages/*` は各 package の `test` script 内で `tsc` を実行し、生成された `dist/**/*.test.js` を Node test runner で実行する。例外として `@pufu-lens/activitypub` は TypeScript を検証したうえで、protocol contract test を `node --experimental-strip-types` により `src/**/*.test.ts` から直接実行する。

DB 接続を伴う migration / schema 検証は CI の `db-check` job で `pnpm db:migrate --check` と `pnpm db:schema-drift` として分離する。`scripts:test` には実 DB 接続を追加しない。

Plan 018 Step 2A の relational graph schema は、`scripts/relational-graph-schema-migration.test.ts` で
`GRAPH_EDGE_TYPES` と migration / fresh DB CHECK の drift、additive migration、constraint / index parityを
検証する。実PostgreSQLではWebの`test:db`に含まれる`relational-graph-schema-db.test.ts`がunknown relation、
orphan / cross-project endpoint、project / node cascade、Actor mergeに必要なedge-first / dedupe / rollback契約を
検証する。testは専用project fixtureだけを削除し、AGE graph、production DB、外部serviceを変更しない。

Plan 018 Step 2B の relational Graph adapter は、`packages/graph/src/postgres-relational-read.test.ts` と
`postgres-relational-mutation.test.ts`、read helperのunit testでruntime guard、malformed SQL rowのfail-closed、
bounded Viewer endpoint整合、SAME_ASのUTF-8 byte canonicalizationを検証する。実PostgreSQLではWebの`test:db`に含まれる
`postgres-relational-graph-adapter-db.test.ts`が9 edge type、1-hop / 2-hop read、Viewer preset、Synthetic Monitor count、
Document cleanup、Actor mergeのedge-first / dedupe / rollback、`COLLATE "C"`との順序整合、project isolationを明示DIで
検証する。通常の
`pnpm test`からDB testを除外し、`DATABASE_URL`を設定した`pnpm --filter @pufu-lens/web test:db`で実行する。
testはproduction composition、AGE graph、migration、外部serviceを変更しない。

ActivityPub の Actor repository / DB 制約 / 暗号化鍵再読込 / representation lock は、local PostgreSQL に `DATABASE_URL` を設定して `pnpm test:activitypub:db` で検証する。dispatcher の DB test は pool 上限を1接続にして report activity の materialization が完了することも検証し、transaction 内の Actor 参照が別接続を待つ自己デッドロックを回帰させない。test は固定した専用 fixture ID と、その実行中に新規作成した aggregate Actor だけを cleanup し、既存 aggregate Actor を再利用した場合は削除せず元の有効状態を復元する。各 DB 制約ケースは独立 rollback transaction で実行する。schema 変更時は `pnpm test:activitypub:schema`、`pnpm db:migrate --check`、`pnpm db:schema-drift` も併用する。Actor profile変更ではname / icon / promptの長さとURL guard、disabled Actorの編集、memberへのprompt非表示、PostgreSQL Actor SELECTのrow contract、aggregate disabled時のCreate-only outboxを検証する。Web runtime の unit test では production federation の初期化失敗後の再試行、DB pool 上限の入力 guard、project federation API の固定エラー契約と log sanitize、Follow / Accept / Undoの即時Job起動request、flag / activity type skip、設定・認証・timeout・network・非2xxのsafe fallbackに加え、reverse proxy の内部 URL / `Host` から canonical request を再構築した後の HTTP signature 検証と collection URL、forwarded host / network-path からの authority 逸脱拒否を確認する。投稿追加promptはserver→project順、未信頼値の構造化、最終guardrail、最大500 code pointの`activitypub_summary`、通常report artifactとの分離をunit testで確認する。PostgreSQL queue contractでは新規Inbox rowだけがhookを1回呼び、duplicate / outboxでは呼ばず、async hook完了までenqueueが待つことを検証する。

ActivityPub の instance 間互換性は、`pnpm test:activitypub:e2e` で検証する。`DATABASE_URL` 未指定時は local test PostgreSQL の標準 URL（`postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens`）を使い、CI などでは `DATABASE_URL` で上書きする。この command は1 process 内に database、canonical origin、Actor key を分離した Pufu Lens A / B と Mastodon v4.6.5 互換 fixture を起動し、外部 network を使わず実 route、HTTP署名、Fedify parser、PostgreSQL queue、retry / recoveryを通す。test-only host router / document loader は `NODE_ENV=test`、`ACTIVITYPUB_RUN_DB_TESTS=1`、`ACTIVITYPUB_RUN_HERMETIC_E2E=1` が揃う場合だけ有効とし、CI artifact `artifacts/activitypub-e2e/protocol-trace.json` にはraw body、署名header、秘密鍵、secret / PIIを含めない。fixtureの固定version、公式source provenance、実 Mastodon 未確認リスクは `packages/activitypub/fixtures/mastodon-v4.6.5/provenance.json` を正とする。

Step 7の運用境界は、`packages/activitypub/src/operations.test.ts` / `operations.db.test.ts`、`scripts/activitypub-queue-admin.test.ts`、`scripts/activitypub-observability-config.test.ts`、`apps/web/src/activitypub-proxy-observability.test.ts`で検証する。queue snapshot / origin上限、本文なしserializer、operator optimistic lock / audit、strict change ref / timestamp、dry-run時gcloud未呼出し、create / update / lookup失敗 / 重複のfail-closed、notification channel分離、Web handler例外のsafe 500 eventを対象とする。schema変更時は`pnpm db:migrate --check`、`pnpm db:schema-drift`、`pnpm test:activitypub:db`を併用する。実GCP resource、外部ActivityPub server、production deployはunit / DB testから呼ばない。

Source sync の差分取り込みと定期実行、および定期レポート生成は、collector、chunk置換、dispatcher、Mastra内部API、report UI の決定的なunit / integration / E2E testを組み合わせて確認する。実providerや本番credentialをテストから呼ばない。ローカル・stagingの運用確認と障害時の判断は [Source Sync Scheduling 運用手順](source-sync-scheduling.md) と [定期レポート Scheduling 運用手順](report-scheduling.md) に従う。

## Turbo cache

`turbo.json` の `test` task は `cache:false` とする。Unit test には runtime guard、DB row parser、storage adapter など実行時の安全性を確認するテストが含まれ、将来 DB 接続や fixture 依存のテストが package 側に追加されても stale cache で結果を取り違えないことを優先する。

`cache:false` では Turborepo の cache key 計算に使う `inputs` は実行判定に使われないため、test task には個別 `inputs` を設定しない。テストは入力ハッシュでの再利用より、常時実行を優先する。

## Coverage

現時点では全 workspace の coverage gate は導入しない。理由は、root scripts は `--experimental-strip-types` で TypeScript source を直接実行し、多くの `packages/*` は `tsc` 後の `dist` を実行し、`@pufu-lens/activitypub` は source から直接 contract test を実行し、`apps/web` は Next.js / Playwright を含むため、単一の coverage しきい値を置くと source map と測定対象のずれが大きいからである。

代わりに、scripts 配下の pure unit test については Node 組み込み coverage を使う `pnpm scripts:test:coverage` を提供する。全 workspace coverage を必須化する場合は、別 Issue で c8 などの reporter、source map、除外対象、CI artifact の保存方針をまとめて決める。
