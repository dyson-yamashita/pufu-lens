# ADR-006: Workers Core package spike

- 日付: 2026-09-26
- 状態: Step 6A のローカル互換性を確認。Cloudflare backend の採用判断は未実施
- Issue: [#784](https://github.com/dyson-yamashita/pufu-lens/issues/784)
- 対象: Plan 018 Step 6A。Step 6B–6E の adapter 完成は含まない

## 判断と再現方法

`packages/workers-spike` を独立した private workspace とし、公開入口
`@pufu-lens/graph`、`@pufu-lens/retrieval`、`@pufu-lens/project-tenancy` から必要な Core を利用する。
GCP の composition、binding、環境変数、DB schema、公開 API は変更しない。
Node test runner は HTTP 相当の入力・期待値検証だけを担当し、Worker 本体は Miniflare の workerd で実行する。
Miniflare `4.20260730.0` / workerd `1.20260730.1`、compatibility date `2026-07-30` を固定し、
`nodejs_compat` を含む追加 flag は指定しない。registry の latest が alpha のため安定版の 4 系を選んだ。

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck test --filter=@pufu-lens/workers-spike
```

`pnpm test` の workspace test にも自動的に含まれる。workerd binary のインストールだけを
`pnpm-workspace.yaml` の `allowBuilds` に追加した。Worker に remote binding はなく、outbound fetch も拒否する。
deploy script / Wrangler 設定は作らない。`POST /probe` は合成データを検証するテスト専用入口であり、
認証・認可を備えた application API として公開してはならない。

esbuild の browser target で bundle し、metafile の外部 import、node_modules、Postgres adapter、
ingestion 混入を拒否する。Node builtin は browser build で解決不能となる。
出力 `dist/worker.js` と `dist/metafile.json` は再生成可能な非追跡 artifact とする。

## 検証結果と範囲

- ローカル macOS / Node 22.16.0 / pnpm 11.1.1 で17件成功、skip 0。
- bundle 11,771 bytes、gzip 2,851 bytes。これは Core の使用部分のみの大きさでありアプリ全体ではない。
- 実 workerd request 内で RRF `k=60`、document dedupe、同点時 document ID 順、semantic / keyword の
  provenance 選択、provider score の除外、Graph node / edge / related candidate / preset の guard を確認。
- rank、identity、snippet、distance、hop、relation、Graph count / node / edge、project DTO / slug の
  拒否系と成功0件、JSON不正、対象外 route を検証。
- runtime 起動と request 成功を確認したが、startup CPU / memory / latency の性能保証はしていない。
  D1 roundtrip、実 traversal、Actor merge、tenant isolation、Vectorize、embedding API は未実行。
  project DTO の検証は認可・tenant isolation の証明ではない。

## 依存の境界

| 入口                 | 判断                               | 後続で守る境界                                                                            |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| graph root           | 使用した runtime guards を実行可能 | `postgres-*` subpath と `postgres` driver を持ち込まない                                  |
| retrieval root       | RRF / candidate guards を実行可能  | keyword transition の全挙動や Chat source selection の移植完了とは扱わない                |
| project-tenancy root | slug validation を実行可能         | `buildCreateProjectSql` は PostgreSQL/AGE専用。D1に流用しない                             |
| ingestion embedding  | 今回の bundle 対象外               | `chunk-embedding.ts` の `node:crypto`、`ingestion-fixtures.ts` 等の依存を分離してから検証 |

6BのD1 Graph adapterとローカル検証は[ADR-007](ADR-007-d1-graph-adapter.md)へ記録する。
6Dではfetch-only embedding入口を分離し、実workerd＋合成HTTP応答で検証した（[ADR-009](ADR-009-vectorize-outbox-repair.md)）。
実embedding API・Vectorizeの互換性/品質は未確認。今回は巨大な共通 abstraction や
Node polyfill を追加しない。Core package 全 export、Web / Mastra / ingestion 全体の互換性は主張しない。

## 公式仕様の再確認と後続条件

以下は2026-09-26確認時点。実装・remote評価開始時に再確認する。

- [Workers local development](https://developers.cloudflare.com/workers/local-development/) と
  [Miniflare tests](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/):
  Worker は workerd、Node test runner は別 runtime。Vectorize はローカルシミュレーションがない。
- [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/):
  Node API のサポートは部分的で stub もあり、import 成功だけを実行互換の根拠にしない。
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/):
  memory 128 MB/isolate、CPU Free 10 ms / Paid既定30秒・最大5分、同時接続6、
  subrequest Free 50 / Paid既定10,000。ローカル小規模検証でquota適合を保証しない。
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/):
  DB Free 500 MB / Paid 10 GB、100 bind parameters/query、30秒query、single-threaded DB。
  6BではUUIDをTEXT、JSONB/arrayをJSON TEXT等へmappingし、project複合キー/FK/unique、
  bounded 1-hop / 2-hop、失敗時rollbackをローカルD1で検証する。
- [D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/) と
  [D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/):
  FTS5は6Cの候補。Postgres SQL/transaction objectは持ち込まずD1 bindingをadapter内部に閉じる。
  `readonly unknown[]` として取得したrowをguard後にCore DTOへ変換する。
  batch原子性、read replicationのsession/bookmark、一貫性は6Bの実験条件として残す。
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/):
  1536 dimensions / float32、topKは値・metadataあり50、なし100、Worker upsert batch 1000、
  metadata 10 KiB/vector、metadata index 10、ID / namespace 64 bytes。
  6Dでcosine metric、model identity、namespaceとindexed project metadata、D1のproject scopeを検証する。
  scoreをCoreのcosineDistanceに正規化し、guardを通してからrankを渡す。
  D1 writeとVectorize writeは単一transactionではなくoutbox / idempotency / repairを要する。

Queues / Workflows の retry / quota / pricing、D1 Time Travel / migration、Vectorize rebuildの詳細は
6D–6E開始時の事前調査として残す。本spikeではこれらを使用・採用しない。

## remote 検証に進むための条件

6Aではremote検証不要。6D以降のVectorize実挙動確認には専用staging index
（cosine / 1536次元）、最小Worker、合成vectorが必要になる。対象は本番と分離し、
vector保存・query dimensionsとWorkers request/CPUが課金対象になり得るため、fixture件数・実行回数・
保持期間・当時の料金で費用見積りを作り、resource作成前に承認を得る。今回の費用はremote利用0。

大規模負荷はユーザー指定でスキップ。Step 3のChat品質未達、Issue #779の独立品質問題、
本番shadow観測・restore・Step 4削除gateは維持する。PGroonga primary / pgroonga-shadow、
Graph relational-only、AGE / PGroonga資産保持を変更しない。親Issue #704はreopenしない。
