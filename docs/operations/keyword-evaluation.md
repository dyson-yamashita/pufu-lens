# Keyword評価（Plan 018 Step 3A / 3B / 3D）

`pnpm keyword:eval` は固定合成コーパスのkeyword順位を評価する。アプリケーションの検索方式や
normalizationを変更せず、評価用spikeでproviderを比較する。本番への接続・切替は後続Stepで行う。

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

## Step 3Cの選定adapter検証

実アプリschema上の候補adapter・trigger・backfill検証は[keyword backfill運用](keyword-backfill.md)を参照する。
固定v1を既存baselineと比較して全gate通過を確認した。追加の短query / Unicode境界例と数字境界はStep 3Dのholdoutで検証する。
本番切替・hybrid / Chat / 負荷評価は後続gateに残る。

## Step 3D: holdoutとtransition比較

`scripts/lib/keyword-holdout.ts` の固定holdoutはv1のjudgmentを変更せず、日本語typo、1–2文字query、数字 / 識別子、
否定 / 複数語、NFKC / combining mark / emoji、`%`・`_`・backslash・SQL風文字列を含む。実アプリschema上のDB testは
PGroongaをbaseline、portable GiST候補をcandidateとして同じsynthetic projectへ投入し、候補件数・expected empty・先頭順位・
project scopeを比較する。query / content / snippet / scoreはreportへ転記しない。

```bash
pnpm --filter @pufu-lens/web... build
KEYWORD_EVAL_DATABASE_URL="postgres://postgres@127.0.0.1:5747/keyword_eval" \
  node --experimental-strip-types --test scripts/lib/keyword-selected-db.test.ts
```

数字queryでは、`invoice 31415`が`invoice 31416`を余分に返す近似overmatchと、関連なしの`31417`が
`invoice 31415` / `invoice 31416`へ近似一致する2件のportable false positiveを再現する赤テストを追加した。
Issue #763で、`word_similarity`のthreshold `0.6`を変えず、数字列だけ文書側の数字列境界との完全一致を要求するguardを追加した。
2026-09-24の専用合成DB検証ではbaseline / candidateとも14ケースの期待集合に一致し、candidate failureは0件となった。
固定v1の期待値、threshold、入力境界は緩めていない。日本語typo、否定 / 複数語、Unicode、literal escaping、project isolation、
正規化境界も同じ検証で維持した。

同日のportable live evalは11方式の記録済み順位を再現し、専用schemaの既存保護・失敗時rollbackも通過した。これは合成DB上の
固定v1 / 14-case境界品質の合格を示すが、実利用分布の広いholdout全体の証明ではない。

transitionのtracked modeは`pgroonga-primary`、`pgroonga-shadow`、`portable-primary`の3値だけである。shadowはPGroongaの
結果を返しportableを比較する。portable primaryは成功0件をauthoritativeとし、error / timeout時だけPGroongaへfallbackする。
両系統失敗はunavailable、入力不正はrejectedとして区別する。観測はprovider、mode、outcome、件数、latency、有限カテゴリだけで、
query本文・snippet・raw score・identity・secretを出さない。

品質・切替gateは、全chunk backfill、fallback 0、デプロイ当日の安定稼働確認、restore point / isolated restore確認であり、Step 3Dのローカル
実装検証だけでは満たさない。hybrid最終document、Core RRF `k=60`後の採用差、期間filter、Chat HTTP、large / long / skewed
corpus、同時ingest、GIN/GiST自然planner、WAL / 容量 / latency SLO、production shadow / primaryは未検証のまま残す。
上記は運用条件であり、切替には固定eval合格と本節のholdout品質条件も必須とする。14-case holdoutは合格したが、広いholdout、
hybrid / Chat、負荷、production shadowの検索観測、restoreが未達のままportable primary切替やPGroonga cleanupへ進めない。

## Step 3Dの広いholdout実測（2026-09-24、Issue #767）

`scripts/lib/keyword-quality-corpus.ts`は、既存v1と14-case holdoutを変更せず追加した独立の56 query / 33文書である。
同一文書の重複chunkと別projectの同文keywordを加え、計35 chunk / 34文書 / 2 projectで実行する。
期待値はproviderの収集前に固定し、数字列の完全一致、複数数字の役割（release番号とbuild番号）、全検索概念の一致、
typoで意図した文書、literal記号を評価する。否定例の`not` / `OR`は検索演算子としてではなくliteral語として扱う。
既存14-caseの`ガラズ`はempty判定だったが、新holdoutはtypoの正解を明示して取りこぼしを評価する。

専用ローカルPostgreSQL 18.1 / PGroonga 4.0.6 / pg_trgm 1.6で実測した。runnerは既存v1 collectorと同様に
`ANALYZE`と専用接続の`enable_seqscan=off`でindex優先にする。初回の自然plannerではPGroongaに21ケースの集合差があり、
統計更新後のindex優先では13ケースとなった。最終runnerはChatと同じ`normalizeHybridKeywordQuery`を両providerへ適用し、
trim境界の1件が解消してbaselineは12ケースとなった。数字の部分一致とbackslash等で計画依存差があり、自然plannerの品質・負荷は未解決である。
この設定は評価接続だけで、本番adapterやpool設定を変更しない。

| 指標                    | PGroonga baseline | portable candidate |
| ----------------------- | ----------------- | ------------------ |
| 期待集合との差          | 12 / 56           | 13 / 56            |
| Recall@20               | 0.8636            | 0.9091             |
| MRR@20                  | 0.8523            | 0.9091             |
| nDCG@20                 | 0.8552            | 0.9091             |
| 正解なしqueryの誤ヒット | 3                 | 2                  |

portableのcategory別Recallはtypo 0.50、numeric 0.8889、multi-number 0.80、その他の正解ありcategoryは1.0。
全体0.95 / category 0.90の既存品質条件を満たさない。MRRのbaseline差が正でも、取りこぼしや余分なヒットを免除しない。
`fixtures/keyword/quality-holdout-v2.json`へcorpus hash、全caseの合成文書ID順位、missing / extra、category集計を保存した。
query / 本文 / snippet / raw score / UUID / 接続URLはreportに含めない。

portableの残差は次の13ケースである。判断を実装に合わせる変更やthreshold 0.6の調整は行っていない。

- missing: `ja-typo`、`ja-transpose`、`digits-natural-typo`、`digits-pair`。
- extra: `digits-unrelated-word`、`digits-two`、`digits-two-reverse`、`digits-repeated`、`multi-enabled`、
  `multi-reordered`、`negative-not`、`literal-percent`、`literal-path`。

数字guardは数字列の存在を要求するが、その役割や出現回数まで保証しない。word similarityは語・記号を無視して近似一致し得る。
これらの解消には検索語の組合せ・近似検索の契約を再検討する必要があり、本PRは観測を固定し、runtime検索仕様は変更しない。

hybridは同じ固定semantic順位を両providerへ渡す8シナリオを用い、実Chat repositoryのCore RRF `k=60`、Top-5、
nDCG@10、実`preparing → retrieving → detail`の最終sourceを評価した。比較gateは4/8合格、4/8不合格。
数字typoと日本語typoでは必須文書が最終sourceに欠落する。英語typoはportableで改善してもbaseline overlapが0のため
比較gateはFAILのまま。literal percentでは余分な文書が最終sourceに残り、overlapは0.5である。
合成semantic順位は実embedding品質を示さず、分類・query展開・retry・graph・timelineの全workflow実行も含めない。

各provider×8シナリオの実取得sourceを、OS割当loopback portのMastra protocol stubと本番workflow HTTP clientで16往復した。
create-run / stream、requestのproject・question・limit、progress、sourceとtoolの保持、内部score/provenanceの除去を確認した。
**Next Chat route・認証・実Mastra server・外部LLM回答/citationの評価ではない**。synthesisは固定合成回答で、外部課金はない。

再実行は専用の使い捨てDBへinit.sqlを適用後、次を実行する。下記5767は例であり他タスクと重複しないportを使う。

```bash
pnpm --filter @pufu-lens/web^... build
KEYWORD_EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:5767/keyword_eval \
  node --experimental-strip-types scripts/keyword-quality.ts /tmp/keyword-quality.json
KEYWORD_EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:5767/keyword_eval \
  node --experimental-strip-types --test --test-concurrency=1 \
  scripts/lib/keyword-quality.test.ts scripts/lib/keyword-selected-db.test.ts
```

collectorは同じfilesystemの一時ファイルへreportを書き、renameで原子的に置換してから品質未達でexit 1となる。
書き込み・rename失敗時は既存reportを保持し、一時ファイルを削除する。`keywordExactGate`は全case集合一致、`hybridGate`はTop-5/source overlap
0.80以上・nDCG@10差-0.05以上・必須source欠落なしを要求する。DB/HTTP errorは品質0件へ置き換えず異常終了する。
testの成功は既知のmissing / extraと選択差の再現であって、品質合格ではない。改善・新しい失敗とも自動snapshot更新せず根拠を確認する。
CI `db-check`にも追加し、table lockを使う旧testとの競合を避けるため直列実行する。作成済みの専用projectだけfinallyで削除し、
既存ID衝突は拒否する。専用Docker containerはoperatorが終了後に削除する。

広いholdoutの品質は**未達と実測確定**した。大規模・長文・偏り・同時ingest、自然planner、容量/WAL/latency SLO、
実semantic / 全Chat HTTP、production shadow検索観測、isolated restoreは未検証として維持する。
本評価の追加でprimary切替・cleanup・Step 4へ進めない。

## Step 3D残差修正（2026-09-25、Issue #769）

Issue #767の結果を`quality-holdout-v2.json`に保持したまま、同一56-query / judgment / corpus hashの実測を
`fixtures/keyword/quality-holdout-v3.json`へ保存した。全termを必須にし、記号はliteral、ASCII labelと直後の数字は
同じphraseとして照合する。word threshold 0.6は維持し、短いtypoは辞書によらない制限付きの綴り候補で補完する。
3–12 code pointの英字は隣接2文字の交換、日本語は1文字の移動、カタカナは1文字のカタカナ置換を許可する。
入力由来のregex metacharacterはescapeし、数字と記号をこの補完で変えない。先頭termで候補を絞り、全term条件をlimit / dedupe前に適用する。

| 指標                  | PGroonga baseline | portable candidate |
| --------------------- | ----------------- | ------------------ |
| 56-case期待集合との差 | 12                | 0                  |
| Recall@20             | 0.8636            | 1.0                |
| MRR@20                | 0.8523            | 1.0                |
| nDCG@20               | 0.8552            | 1.0                |

hybridの必須文書と最終sourceの欠落は8件すべて0となり、literal percentの余分な文書も解消した。
比較gateは6/8合格。`typo-keyword-only`と`ja-typo-keyword-only`はbaselineが0件、candidateが正解文書を取得するため
overlapが0であり、nDCG差+1でも現行比較gateはFAILのままとする。baseline改善差を自動免除する変更は行っていない。
HTTP transportは引き続き16/16成功。collectorのexit 1はこのhybrid比較gate未達による。

旧14-caseの`ガラズ`はemptyと定義され、新56-caseのtypo relevanceと矛盾していた。ユーザーの明示承認により関連ありへ統一した。
その結果、旧holdoutはbaseline miss 1 / candidate miss 0となる。**固定v1の期待値と新56-caseの期待値は変更していない**。
旧snapshotを合格に見せるための期待値変更ではなく、日本語typoの検索契約を明示して矛盾を解消したものである。

`portable-keyword-regression.test.ts`では別語彙の15 queryを追加し、数字のprefixとラベル内部分一致、ラベルと数字の入れ替わり、
否定語、`%` / backslash / regex文字列、英字と日本語typo、補完対象外の2文字queryを実DBで検証する。
実装後に追加した回帰例なので独立holdoutとは呼ばない。CIのDB検証へ追加している。

```bash
KEYWORD_EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:5769/keyword_eval \
  node --experimental-strip-types --test --test-concurrency=1 \
  scripts/lib/keyword-quality.test.ts scripts/lib/keyword-selected-db.test.ts \
  scripts/lib/portable-keyword-regression.test.ts
```

index優先の小規模評価に限る。限定typo候補による未知queryの誤検出とindex / latency影響は広い実利用分布・負荷での確認を残す。
自然planner、大規模・同時ingest、全Chat E2E、production shadow観測、restore、primary切替・Step 4 gateは未達を維持する。

## 実Chat E2E（2026-09-25、Issue #771）

2026-09-25、Issue #771で[実Chat E2E](live-chat-e2e.md)を実行した。
Next認証・実Mastra・Gemini・embedding・DB・表示・履歴を通した代表ケースは両方式7/7、障害時1/1成功。
ただしsource overlap 0.5の1件、本文引用欠落・内部診断混入があり、全品質gate合格にはしない。
大規模負荷検証はユーザー指定でスキップする。production shadow観測・restoreは残る。

Issue #772の回答表現補修後は、同じ実Chatケースで両方式7/7成功、必要な本文リンク・事実を保持し、
内部診断混入0件を確認した。今回のsource overlapは全件1.0だが、旧v1の観測と既存比較gate未達は維持する。
詳細と脚注記号が残る書式上の限界は[実Chat E2E](live-chat-e2e.md#回答表現の補修issue-772)を参照。

Issue #775でpublic Chatも両方式8/8成功。実LLM回答5件の公開source overlapはすべて1.0で、
公開IDへの変換、匿名UI、公開制御の拒否系を確認した。合成Web資料の代表検証であり、既存比較gateの未達は維持する。
再現手順・範囲は[実Chat E2E](live-chat-e2e.md#public-chatの実経路issue-775)を参照。

Issue #777では非空Graph・raw原文の実Chat 2件とparsed metadataの直接HTTP確認1件が両方式3/3成功。
原文限定情報とGraph非空取得を確認した。portable keywordは24回success / fallback 0、候補非空0回であり、
keyword単独の品質証明にはしない。parsedのLLM tool選択失敗2回を含む証跡は[実Chat E2E](live-chat-e2e.md)を参照。

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

Step 3Aではprovider選定、hybrid最終document / RRF採用差、期間filter、index容量、write amplification、
backfill、EXPLAIN比較、同時ingest、production SLO・コストの評価は未実施。Step 3Bの補完範囲は次節を参照する。
既存HTTP Chat evalは別途必要であり、このrunnerはChatのend-to-end品質を保証しない。

## Step 3B: portable比較spike

比較結果と採用提案は [ADR-005](../adr/ADR-005-portable-keyword-spike.md) を正本とする。
FTS simple、pg_trgm LIKE / similarity / word similarity、LIKE OR word（GIN / GiST）、application
bigram / trigram（strict / fuzzy）、bigram OR wordの11方式を同一corpusで収集する。
LIKE OR wordとfuzzy n-gram等の5方式が全gate合格。GCPの次の候補にLIKE OR word / GiSTを提案する。
この結果は本番採用・デプロイ・PGroonga削除の承認ではない。

上記の専用DBに`pg_trgm`も事前installし、次を実行する。extensionの作成はcollector自身では行わない。

```bash
docker exec keyword-eval psql -U postgres -d keyword_eval -c 'CREATE EXTENSION pg_trgm'
KEYWORD_EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:5747/keyword_eval \
  pnpm keyword:eval spike --output /tmp/portable-spike.json
pnpm keyword:eval evaluate-spike --input /tmp/portable-spike.json \
  --baseline fixtures/keyword/pgroonga-baseline-v1.json --output /tmp/portable-reports.json
KEYWORD_EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:5747/keyword_eval \
  node --experimental-strip-types --test scripts/lib/keyword-eval-portable.test.ts
```

`spike`は収集成功でexit 0、`evaluate-spike`は1方式でもgate不合格なら全reportを書いたうえでexit 1。
候補の不合格は想定された評価結果である。`evaluate-spike`の`--baseline`は必須で、省略時は評価・report生成前にexit 1となる。
DBなしで再評価する場合はinputを`fixtures/keyword/portable-spike-v1.json`に置き換える。
単一snapshot用の既存`evaluate`はbaseline任意で引き続き利用できる。

spikeの出力は`{ run, diagnostics }`の配列。`run`は既存snapshot契約、`diagnostics`はload / build /
write時間、token数、relation容量、FTS parser token、EXPLAINを持つ。
**diagnosticsには合成query / 本文断片が含まれる**ため、実データへ流用しない。品質reportはそれらを転記しない。
schemaは`keyword_eval_portable`。方式ごとのtransactionで作成・削除し、既存schemaは拒否する。
loopback制限だけでは本番port forwardを検知できないので、専用の使い捨てcontainerにのみ接続する。

候補方式は評価用にNFKC / lowercaseを揃え、現行アプリのnormalizationを変更しない。
seqscan off / onのEXPLAIN、3回の本文再書込み後の容量を保存する。latencyは3sampleのみ、37 chunkで
通常plannerがSeq Scanを選ぶ規模であり、production性能・WAL・同時負荷・hybrid品質は未検証。

## 自動検証

`pnpm scripts:test` / `pnpm test` が指標・意図的失敗・snapshot検証・CLIのhermetic testを実行する。
DB testは`KEYWORD_EVAL_DATABASE_URL`を明示したときだけ動く。rootのformat / lint / typecheckも対象。
