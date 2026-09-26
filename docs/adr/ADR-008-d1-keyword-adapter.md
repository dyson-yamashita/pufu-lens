# ADR-008: D1 keyword adapterのローカル評価

- 日付: 2026-09-26
- 対象: Plan 018 Step 6C / [Issue #788](https://github.com/dyson-yamashita/pufu-lens/issues/788)
- 判断: application文字索引＋bigram判定をローカル候補に採用。remote採用・本番移行は未判断

## 方式と境界

`packages/workers-spike/src/d1/keyword.ts`が既存`KeywordCandidateRepository`を実装する。
NFKC / lowercase / trim、code point n-gram生成、全term / label-number / bounded typo規則を
`@pufu-lens/retrieval`の純粋関数として再利用する。既存Web入口でLIKE/POSIX表現に変換し、
GCPのSQL・normalization関数・threshold 0.6・composition・設定を変えない。
root評価scriptにもworkspace依存とbuild順を明示し、appへの相対importをWorkerに持ち込まない。

1. 最初の検索語のcode pointのいずれかを持つchunkを、project-scoped文字posting索引で取得する。
   literal・typo・近似一致の必要条件を満たすsupersetであり、この段階では順位を決めない。
2. DB rowをunknownからCore guardと原文/正規化整合guardで検証する。
3. 数字列は本文の数字列集合との完全一致を要求し、全termを要求する。記号はliteralのまま扱う。
   ASCII label＋数字は共有regexで対応関係と境界を保持する。SQL表現はCoreに持ち込まない。
4. literal部分一致、共有のbounded typo、単語ごとのbigram Jaccard ≥0.6をORする。
   単語はUnicode Letter/Markの連続。Jaccardは共通gram数 / 和集合gram数であり、pg_trgmの再実装ではない。
5. query全文literal一致をscore 2、それ以外は全termの最小Jaccardで並べ、chunk IDのcode unit順でtie-breakする。
   chunk上限→document重複排除→1始まりrankを守り、選択chunkの原文先頭700 code pointsをsnippetにする。
   raw scoreはCoreへ返さない。SQL/guard/予算超過は固定unavailable、成功0件は空配列、入力拒否はrejectedとする。

文字索引は短い日本語と共有typo規則のrecallを保つ最小の候補索引であり、選択性は低い。
**prefilter 1000 chunk超では明示unavailable**とし、途中切捨てで成功を装わない。
limitは1–1000、原文queryは1000 UTF-16単位まで。NULと孤立surrogateは拒否する。
これは小規模spike用の制約であり、大projectの完成した検索backendではない。
remote採用前には索引の選択性、候補予算、CPU/memory/latencyと長文を評価し直す必要がある。

## FTS5との比較と品質

固定`keyword-synthetic-v1`（37 chunk / 36 document / 2 project / 22 query）と保存済みPGroonga baselineを
`evaluateKeywordRun`へ渡し、同じjudgment / threshold / 必須exact / isolation / escaping gateで評価する。
FTS5はNFKC正規化した各検索語をquoteしANDで結び、bindで渡す。rank→chunk ID順、chunk上限20後にdedupeする。
FTSの比較queryは実ローカルD1 bindingで実行し、採用adapterはWorker request内で実行する。

| 方式                     | Recall@20 | MRR@20 | v1 gate | 判断                                            |
| ------------------------ | --------: | -----: | ------- | ----------------------------------------------- |
| FTS5 unicode61           |    0.4667 | 0.5333 | FAIL    | 日本語部分一致・混在・人名・typo等が欠落        |
| FTS5 trigram             |    0.9333 | 0.9333 | FAIL    | typo欠落。別境界試験で1–2文字の日本語MATCHも0件 |
| 文字posting＋bigram/typo |    1.0000 | 1.0000 | PASS    | v1全gate成功。nDCGも1.0000                      |

追加で既存56-query品質holdoutをそのまま実行し、期待集合の欠落/余分とも0件、Recall / MRR / nDCG各1.0。
既存14-case holdoutと別語彙15-query回帰も期待集合を満たす。fixture・期待値・thresholdは変更しない。
初回の全文gram被覆率方式では`enabled`が`disabled`へ一致する誤検出2件を観測した。
単語単位のJaccardへ変更し、散在gramの合算と余分な文字による誤一致を抑えた。
固定caseを特別扱いする辞書・補正は追加しない。

FTS5 trigram単独では短query/typoの補完経路が別途必要になるため、このspikeでは補助索引を一つにする。
FTS5の全設定が不適という判断ではない。将来、FTS5 trigram＋短query/typo索引を性能目的で比較できる。
単語分割・近似scoreはGCPと異なり、未観測の語彙・typo・順位が一致する保証はない。
この結果をStep 7のsemantic/hybrid/Chat parityや既存Chat品質gateの合格に代用しない。

## schema・原子性・scope

`d1/0002_keyword.sql`を6B schemaの後へ適用する。`keyword_documents`は検索用metadata projection、
`keyword_chunks`は原文/正規化本文、`keyword_characters`は重複なしのcode point postingを保持する。
project/document/chunk複合FK、project内chunk identityとdocument内chunk_indexのuniqueを維持し、cascadeで削除する。
raw document本体や履歴・認可tableを移植するschemaではない。呼出側が認可済みproject IDを渡す契約とする。

`replaceD1KeywordDocument`は文書の全chunk snapshotを受け、metadata upsert→旧chunk削除→chunk insert→posting insertを
4 statementの単一D1 batchで行う。同一snapshot再試行は冪等、異なるsnapshotは最後のcommitが勝つ。
順序逆転対策・version arbitration・ingestion接続は6D以降の設計対象。空chunk集合は索引を空にする。
各原文/正規化本文はUTF-8 8,000 bytesまで、serialized chunk/token＋metadataは100,000 bytesまでを事前拒否する。
大きい文書を部分batchに分割してcommitする処理は実装しない。
deleteはprojectとID集合を渡す単一SQLで、FK cascadeによりpostingも削除する。
project削除もcascadeする。欠落project、chunk ownership衝突、不正index/重複は拒否し、既存文書を保持する。

配列は`json_each(?N)`でbindし、検索2、置換最大6、削除2 bind/statementとする。
100件超の文字/IDでもbind数は増えない。SQL本文は固定であり、LIKE/GLOBもSQLへのquery補間も使わない。
最終posting insertに失敗triggerを置き、metadata更新・chunk削除までrollbackすることを実D1で確認する。
delete失敗時のcascade rollback、並行同一snapshot、read-after-write、他project同一IDの保護も検証する。

## 公式仕様の再確認

2026-09-26に確認。仕様値の根拠は以下とし、ローカル結果でremote quota適合は主張しない。

- [D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/): FTS5とJSON extensionをサポート。
- [SQLite FTS5](https://www.sqlite.org/fts5.html): unicode61とtrigram、quote/AND構文を参照。
  trigramの3文字未満queryの制限はローカルでも確認した。
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): 100 bind、100 KB SQL、
  LIKE/GLOB pattern 50 bytes、query/batch 30秒、Free 50 / Paid 1000 queries per invocation。
  索引置換は4 SQL、検索/削除は各1 SQL。短い実fixtureはCPU/memory/throughputの性能保証ではない。
- [D1 binding / batch](https://developers.cloudflare.com/d1/worker-api/d1-database/): batch失敗時は全sequence rollback。
  [prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)のordered bindを使用する。
- read replicationのsession/bookmarkは追加しない。通常bindingを用いる6Bと同じ境界で、remote replica遅延は未検証。

## 再現・未検証範囲

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck test --filter=@pufu-lens/workers-spike
```

Miniflare `4.20260730.0` / workerd `1.20260730.1` / compatibility date `2026-07-30`、Node互換flagなし。
テストは`dist/keyword-v1-evaluation.json`（run＋report）と`dist/keyword-holdout-evaluation.json`（hash＋case別結果）を再生成する。
artifactは非追跡で、fixture ID/順位/判定のみ。少数の実行時間sampleは性能判断に使わない。
`keyword-worker.ts`は未認証のローカル合成データ専用でありdeployしない。

keyword 8件、既存D1 Graph 13件、Core 17件の計38件成功、skip 0。
root `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm test`、`pnpm db:migrate --check`は成功。
root testの既存外部DB等のskipは維持し、全外部検証の成功とは扱わない。
`db:schema-drift`は最初DATABASE_URL未設定で実行不能だったが、既存ローカルimageの使い捨てDBで再実行して成功した。
root test初回は並行typecheckのNext build lockと競合したため、逐次実行して成功を確認した。
GCP schema変更がないためPostgreSQL driftはD1の検証にはならず、実D1 schema適用・制約・rollback試験を正とする。
UI変更はないため画面capture/Web E2Eは対象外。

remote resource作成・deploy・課金・実データコピー・GCP変更は0。remoteは6Cローカル到達点に不要。
大規模負荷はユーザー指定でスキップ。remote quota/latency、実production文書サイズ、性能と索引容量、
6D Vectorize/outbox/embedding、6E staging、Step 7全backend/Chat parityは未実施。
PGroonga primary / pgroonga-shadow、Graph relational-only、AGE/PGroonga資産保持、既存Chat品質未達、
本番shadow観測・restore・Step 4削除gateを維持する。#779を前提にせず、親#704はclosedのままとする。
