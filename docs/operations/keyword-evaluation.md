# Keyword評価（Plan 018 Step 3A）

`pnpm keyword:eval` は固定合成コーパスのkeyword順位を評価する。アプリケーションの検索方式や
normalizationを変更せず、provider選定と本番切替は後続Stepで行う。

## コーパスと再利用範囲

正本は `scripts/lib/keyword-eval-corpus.ts` の `keyword-synthetic-v1`。
37 chunk、36 document、2 project、22 queryを固定し、関連documentへ1〜3のgradeを付けた。
日本語、英数字混在、架空人名、製品・計画名、Issue / PR、URL / repository、技術語、部分一致、typo、
全角英字、空・記号、SQL / query構文、越境、長さ境界を含む。人名・製品名は架空、URLは
`example.invalid`。実データ、OAuth、秘密情報、外部API、embedding、LLMは使わない。

既存 `scripts/chat-eval.ts` と `fixtures/chat/*` はHTTP応答・source・tool callの評価なので維持する。
共通 `scripts/lib/cli.ts` の引数処理を再利用する。既存keyword adapterのchunk上限→document dedupe→
順位付けを評価SQLに写し、アプリのpublic tableに接続しない。Core RRFは変更しない。
これは小規模な品質回帰コーパスであり、実利用の分布や負荷を代表するものではない。

## DBなしの再評価

```bash
pnpm keyword:eval corpus --output /tmp/keyword-corpus.json
pnpm keyword:eval evaluate \
  --input fixtures/keyword/pgroonga-baseline-v1.json \
  --output /tmp/keyword-report.json --markdown /tmp/keyword-report.md
```

記録済みbaselineは後述の既知の不足によりexit 1となる。実行失敗とは区別し、生成reportのcase別結果を読む。
同一snapshotからのreportは決定論的。corpusのJSON表現のSHA-256が一致しないsnapshotは拒否する。
corpus内容変更時はversionを上げ、baselineも再収集する。

候補providerはexportした同一corpusで取得した結果を次のsnapshot形式にして比較する。

```json
{
  "schemaVersion": 1,
  "corpusHash": "corpus exportと同一内容のSHA-256（baseline参照）",
  "provider": "candidate-name",
  "environment": "DB・extension・index・実行条件の識別子（秘密情報禁止）",
  "cases": [
    { "id": "japanese", "status": "ok", "chunkIds": ["c01", "c02"], "latencyMs": [1, 2, 3] }
  ]
}
```

上記は形式の例であり、実際には全22 caseがちょうど1回ずつ必要。`chunkIds`は順位順、最大20件、
documentごとに1 chunkとする。未知ID・重複chunk・不正latency・欠落caseは入力エラーとなる。
`over-length`は`status: rejected`、空の候補とする。エラーを成功0件へ置換しない。
任意の追加fieldは破棄し、query / content / snippet / scoreはreportへ転記しない。
provider / environmentには認証情報や接続URLを入れない。

```bash
pnpm keyword:eval evaluate --input /tmp/candidate.json \
  --baseline fixtures/keyword/pgroonga-baseline-v1.json \
  --output /tmp/comparison.json --markdown /tmp/comparison.md
```

## 指標と判定

- Recall@20: 上位20 document中の関連document数 / 全関連document数。query単位のmacro平均。
- MRR@20: 上位20内の最初の関連document順位の逆数。未検出は0。
- nDCG@20: gain=`2^grade - 1`、discount=`log2(rank + 1)`、ideal順で正規化。
- 関連documentなしのcaseは品質平均から除外し、候補0件の必須ゲートで評価する。
- 全体Recallは0.95以上、正解を持つcategory別Recallは0.90以上。
- baseline指定時のMRR平均差は-0.05以上。nDCG差とTop-20 overlapは診断情報。
  overlapは共通document数 / 両者の候補数の大きい方（双方0件なら1）。
- 越境、重複document、必須exact queryのmiss、不正入力status、無関連caseのヒットは1件でもfail。
- baselineを省略すると絶対品質・必須ゲートだけ判定し、`comparisonComplete: false`を出す。
  `gate: true`だけでprovider採用・deploy可能とは判断しない。
- latencyはnearest-rankのp50 / p95。ローカルの小規模測定のため性能合否には使わない。

## ローカルPGroonga baseline収集

専用の使い捨てDB `keyword_eval` を用意する。`KEYWORD_EVAL_DATABASE_URL` のloopback接続だけを受け付け、
汎用 `DATABASE_URL` は読まない。URL optionは拒否する。本番へのport forwardを使わない。
既存のローカルimageがある場合の例:

```bash
docker run --rm -d --name keyword-eval \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=keyword_eval \
  -p 127.0.0.1:5747:5432 pufu-lens-postgres:latest
docker exec keyword-eval pg_isready -U postgres -d keyword_eval
docker exec keyword-eval psql -U postgres -d keyword_eval -c 'CREATE EXTENSION pgroonga'
KEYWORD_EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:5747/keyword_eval \
  pnpm keyword:eval collect --output /tmp/pgroonga.json
KEYWORD_EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:5747/keyword_eval \
  node --experimental-strip-types --test scripts/lib/keyword-eval-db.test.ts
docker stop keyword-eval
```

`pg_isready`が成功してからextensionを作る。imageを新規作成する場合はrepositoryの
`infra/docker/postgres/Dockerfile`を使う。上記のtrust認証はこのloopbackの使い捨てcontainer専用。

collectorは単一transactionで専用schema `keyword_eval_synthetic`を作り、合成chunkを投入し、
PGroonga indexを作成して測定し、tableとschemaを削除する。失敗時はrollback。
既存schemaがあればエラーにし、再利用・削除しない。public application tableのread / writeやextension作成はしない。
PGroonga 4.0.6ではTEMP tableのscore lookupが失敗したため、通常tableをこのtransaction内に隔離している。

queryはtrimのみ、空は0件、1000 UTF-16 code unit超はrunner側で拒否する。これは評価境界の規約であり、
既存Chat APIの長さ制限の証明ではない。Unicode正規化はbaselineのPGroonga既定に任せる。
SQLはbind parameterと既存adapter同様の`pgroonga_query_escape`を使用する。
小規模コーパスでもindex scoreを得るため`enable_seqscan=off`、各queryを1回warm-upして3回測る。
反復で順位が変われば失敗する。過長入力のlatency=0は拒否を表す。

## 2026-09-17 baseline結果と残課題

`fixtures/keyword/pgroonga-baseline-v1.json` はローカルPostgreSQL 18.1 / PGroonga 4.0.6で収集した実測snapshot。
全体Recall / MRR / nDCGは0.9333、必須exact queryは全件検出、project隔離caseは成功。
`ActivtyPub`のtypoは未検出。`absent OR ActivityPub`は候補が返り、無関連caseの必須ゲートに失敗する。
既存escape処理で検索構文の意図を完全に無効化できるとは扱わない。このため総合判定はFAILである。
baselineをpassさせるために正解や閾値を調整せず、Step 3Bの比較・normalization検討事項として保持する。

このStepではprovider選定、hybrid最終document / RRF採用差、期間filter、index容量、write amplification、
backfill、EXPLAIN比較、同時ingest、production SLO・コストの評価は未実施。Step 3B以降で補完する。
既存HTTP Chat evalは別途必要であり、このrunnerはChatのend-to-end品質を保証しない。

## 自動検証

`pnpm scripts:test` / `pnpm test` が指標・意図的失敗・snapshot検証・CLIのhermetic testを実行する。
DB testは`KEYWORD_EVAL_DATABASE_URL`を明示したときだけ動く。rootのformat / lint / typecheckも対象。
