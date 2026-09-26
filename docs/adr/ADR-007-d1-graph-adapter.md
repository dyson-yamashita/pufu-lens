# ADR-007: D1 Graph schema / adapter のローカル検証

- 日付: 2026-09-26
- 対象: Plan 018 Step 6B / [Issue #786](https://github.com/dyson-yamashita/pufu-lens/issues/786)
- 判断: ローカルD1でGraph capabilityを実装。remote採用・本番移行の判断は未実施

## 境界と再現

`packages/workers-spike/src/d1/` が `GraphReadRepository` / `GraphMutationRepository` を実装する。
D1 bindingの最小構造型は同directoryに閉じ、Core / GCPへの依存・設定変更を追加しない。
汎用DB abstraction、新package、Node polyfillは追加しない。Coreの公開exportを使用する。
`d1-worker.ts` は未認証のローカル試験専用compositionであり、公開してはならない。
remote binding、Wrangler/deploy設定、外向き通信は用意しない。

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck test --filter=@pufu-lens/workers-spike
```

6Aと同じMiniflare `4.20260730.0` / workerd `1.20260730.1`、compatibility date `2026-07-30`、
Node互換flagなしで実行する。Node runnerはfixture投入と期待値検証を担当し、adapterはWorker request内で
実際のD1 bindingを呼ぶ。SQLiteの代用品やquery mockではない。`pnpm test`にも含まれる。

## schemaとmutation

`d1/0001_graph.sql` は新しい空のローカルDB用で、GCP migrationとは独立する。
`projects(id TEXT)` はtenant identityのみの試験用最小tableであり、Project管理機能の移植ではない。
node複合PK、edge複合PK、project FK、両endpointのproject複合FK、cascade、kind/9 relation/JSON object
制約を維持する。UUIDはTEXT、JSONBはJSON TEXTにmappingする。timestampは今回のCore契約で使わないため
省略し、GCP schema全体との同一性は主張しない。schema versionはこのmigration filenameで固定する。

- node propertiesは浅いobject merge。SQLite `json_patch`の再帰merge/null削除を避け、`json_each`で
  既存keyと新keyを合成する。明示null、boolean、array、nested objectの置換を保持する。
- edgeは9 relationをCore guardとDB制約で拒否/許可し、同一identityの再試行はproperties置換となる。
  SAME_ASはSQLite BINARYのUTF-8 byte順で正規化し、同一endpointを拒否する。
- Actor mergeはguard、edge移送、secondary node削除の単一`batch`。guard後に別requestの書込みが
  割り込む事前read/write方式を使わない。既存primary edgeを保持し、移送edgeへprimaryActorIdを設定する。
  SAME_ASを再正規化し、mergeで生じるself edgeを除く。移送後にFK cascadeでsecondary incident edgeを削除する。
  secondaryなし/同一Actorはskipped。primary Actorなしやbatch失敗はunavailableで変更を残さない。
- Document cleanupはkindを限定する単一DELETE。ID集合は`json_each(?)`へ渡すため100件超でもbind数を増やさない。
  Viewer/cleanup等のID JSONはUTF-8 100,000 bytes超を明示拒否する。途中batch分割による部分commitはしない。
- ensureは既存projectを要求する。deleteProjectGraphはGraphのみを削除し、project自体は削除しない。

## read / Viewer

全joinとmutationをproject scopeで限定する。related readはseed重複排除後10件まで、SAME_AS/RELATED_TOは
1-hop、MENTIONSはTopicを介した2-hopのみ。relationごとのSQL row上限50、既定候補pool 2/5/5と
seed/document順・document単位dedupeを既存adapterに合わせる。relationLimitsは非負整数のみを受け付ける。
3本のrelated queryは単一batchにまとめる。成功0件とSQL失敗unavailableを区別し、不正rowはguard失敗にする。

Viewerはeligible documentのみを入口に501 SQL rows、500 edges、600 nodesを上限とする。
Core DTO parser、properties runtime guardを通し、dangling edgeを返さない。edge IDはWeb Crypto SHA-256で
GCPと同じ入力/先頭16桁を使う。rawRows、rowCount、truncated、previewも既存shapeを保持する。
DB rowsは`readonly unknown[]`からobject/field/JSON/Core guardを通す。node_keyやpropertiesをログへ出さない。

## 公式仕様の再確認

2026-09-26に再確認した仕様と今回の適用を記録する。

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): 100 bind/query、100 KB SQL、
  30秒query/batch、single-threaded DB、Free 50 / Paid 1000 queries per invocation。
  adapterは固定SQLで最大5 bind/statement、最大3 statements/operationとする。小fixtureでquota/性能を保証しない。
- [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/): batch途中の失敗は全体rollback。
  mergeの最後のDELETEをtriggerで失敗させ、移送INSERTも元へ戻ることを確認する。
- [D1 FK](https://developers.cloudflare.com/d1/sql-api/foreign-keys/): FKは常時有効。
  FKを無効化せず、project越境とorphan insertを拒否する。
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/):
  Sessions APIを使わない通常bindingはprimaryへ送る。今回はsession/bookmarkを使わず、read-after-writeを
  ローカルで検証する。remote replica配置・bookmarkの伝播・遅延は未検証とする。

## 検証と残るgate

ローカルD1 13件と既存Core 17件の計30件成功、skip 0。workspace build/typecheckも成功。
root `pnpm test` / `pnpm typecheck` / `pnpm format:check` / `pnpm lint`、`pnpm db:migrate --check`は成功。
root testにはDB接続等の外部条件を要する既存skipがあり、その検証完了は主張しない。
PostgreSQLの`db:schema-drift`はGCP schema変更がなくD1を検査できないため対象外とし、D1では実schema適用と
constraint/rollback試験を行った。Web変更がないためUI E2E/画面captureは対象外とする。

ローカルD1でschema拒否系、9 relation、JSON浅いmerge、UTF-8 SAME_AS、scoped traversal、Viewer shape/上限、
Actor merge/dedupe/再試行/並行実行、mid-batch rollback、100件超cleanup/cascade/rollback、lifecycle、
不正row、成功0件/unavailableを確認する。これは小さな境界fixtureであり、大規模負荷ではない。

remote resource作成、deploy、課金、実データ、GCP変更は0。ローカルの結果でremote latency/CPU/memory、
quota、replication、migration運用・Time Travel、全Graph backend parityを合格扱いしない。
remote検証は6Bのローカル到達点に不可欠ではない。6C keyword、6D Vectorize/outbox/embedding、6E stagingを残す。
大規模負荷はユーザー指定でスキップ。Chat品質未達、本番shadow観測、restore、Step 4削除gate、
PGroonga primary / pgroonga-shadow、Graph relational-only、AGE/PGroonga資産保持を維持する。
Issue #779を前提条件にせず、親Issue #704はclosedのままとする。
