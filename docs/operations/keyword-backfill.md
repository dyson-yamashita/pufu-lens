# Portable keyword materialization（Step 3C / 3D）

Issue #752で候補adapterとadditive schemaを実装し、Issue #754でshadow / primary + fallbackの切替準備を追加した。
本番は`pgroonga-shadow`を反映済みで、keyword primaryはPGroongaのまま、Core RRF `k=60`、Chat API、期間付き検索の
既存経路は変更しない。本番migrationと全4 projectのbackfillは完了したが、portable primary切替は別承認と品質gateに残る。
PGroonga indexはrollback window中維持する。

## 2026-09-20 production backfill記録

- `book-read-log`、`pufu-lens-dev-pj`、`pufu-tomonokai`、`test` の全4 projectを対象に実行した。
- 100件単位のbounded transactionで3,420件を更新し、全projectで`pending=0`、`normalize_keyword(content)`との不一致0件を確認した。
- `pgroonga-primary`は維持し、portable providerのprimary切替やPGroonga cleanupは行っていない。
- shadow観測の設定準備とrollback条件はIssue #756で管理する。

## 当日の安定稼働確認（2026-09-21、Issue #759）

ユーザー指定で最低7日soakをデプロイ当日（Asia/Tokyo）の確認へ変更する。品質閾値、fallback 0、復元試験、rollback用資産の保持期間は短縮しない。
日次・週次負荷を網羅した証明ではなく、当日中に実行されなかった経路は未検証として残す。

- PR #757のmerge commit `20a6b6dae700f63c9a1bd0872fbd71448d91e81f` をbuild `a9988267-013c-4564-a63b-308a5993cb9c` で反映し、2026-09-20 22:10:14 JSTに全16工程SUCCESS（smokeを含む）を確認した。
- 同日22:10:14〜24:00のCloud Run request logはMastra 202が63件、Web 200が4件、307が2件、404が12件、5xxが0件。404の原因は未分類であり、正常と断定しない。
- 同期間の `keyword_transition_observation` は0件。検索が実行された証拠がないため、shadow品質・fallback 0のgateは未判定。
- 翌日のブラウザ確認でProjects / Overview / Chat / Reports / Graph / Loginが表示され、Graphは36 documentsを読み込んだ。これは当日の観測とは分けて扱う。console/network詳細は未確認。
- 本番shadow設定は反映済みだが、primary切替・PGroonga削除は未実施。検索評価・復元試験を完了するまで移行完了とはしない。

## Schemaと正規化

- `0027_portable_keyword_schema`: `pg_trgm`、nullableな`document_chunks.keyword_content`、正規化関数、更新trigger。
  既存行はNULLのままなので、全行rewriteをDDL内で行わない。短いtable lockは必要。
- `0028_portable_keyword_index`: GiST indexを`CONCURRENTLY`作成。中断後はmigration runnerの再実行で
  既存indexをconcurrent dropして再作成する。backfillとは別工程。fresh `init.sql`は通常のindex作成と両version seedを持つ。
- PostgreSQL 18 / UTF8 / `pg_unicode_fast`のUnicode full lowercaseを使う。
  pg_trgmはAGEから独立した`public` schemaへ配置する。既存extensionが別schemaにある場合はmigrationを停止し、
  operatorが既存依存を調査して配置を判断する。自動移設は行わない。
  `public.normalize_keyword`をquery・trigger・backfillで共有し、NFKC → lowercase → ECMAScript trim対象文字の除去を行う。
  casefold・アクセント除去・記号除去はしない。NodeとDBのUnicode version差は全Unicodeで検証済みではない。
- `keyword_content`は`C` collation。原文`content`とsnippetは保持する。INSERT、content更新、keyword列直接更新では
  BEFORE triggerが現在contentから再計算する。ingestionのdelete/reinsert、document/raw/project cascade削除でも同じrow内で整合する。
  historyは検索対象外のため列を追加しない。同一hashによるingestion skipでは既存NULLを修復しないのでbackfillが必要。

## 候補adapter

`createPostgresPortableKeywordCandidateRepository(sql)`を明示的に呼ぶ評価経路だけで使用する。
通常の`createGcpPostgresCandidateRepositories`はPGroongaを返す。

- queryは最大1000 UTF-16 code unit、NUL拒否、空は0件。limitは整数1–1000。
- LIKEの`%` / `_` / backslashをliteral escapeしbind。`LIKE OR %>`、word threshold 0.6。
- queryに数字列が含まれる場合は、近似`word_similarity`を残しつつ、各数字列が文書側の数字列境界と完全一致することを追加で要求する。
- 検索transaction内でのみthresholdと5秒statement timeoutを設定し、成功・失敗後もpool session設定を復元する。
- chunkとdocumentのproject一致を検索上限より前に要求する。literal一致score 2、その他word similarity、chunk ID順。
  chunk limit → document dedupe → 1始まりrank、同じ採用chunkの原文snippet（最大700文字）を返す。
- NULLの未backfill行は候補にならない。0件は空配列、DB errorは伝搬し、adapter内部でPGroonga fallbackを行わない。
  本番fallback / unavailable / shadow、期間filterを含むhybrid最終品質はStep 3Dで扱う。

## Step 3D transition / rollback準備

server-onlyの`PUFU_LENS_KEYWORD_TRANSITION_MODE`をdeployment composition rootで一度だけ解決する。未知の値はfail closedし、
request body、project settings、URLからproviderを選択しない。

| mode               | primary                         | portable候補 | fallback / 戻し方                                                                          |
| ------------------ | ------------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `pgroonga-primary` | PGroonga                        | 実行しない   | 初期既定。設定をこの値へ戻せばPGroongaのみへ戻る                                           |
| `pgroonga-shadow`  | PGroonga                        | shadow比較   | primary結果を常に返す。shadow error / timeout / mismatchは結果を変えない                   |
| `portable-primary` | portable LIKE / word similarity | primary      | portableのerror / timeoutだけPGroongaへ1回fallback。成功0件はauthoritativeでfallbackしない |

成功0件は`success`として扱い、provider error / timeout、fallback成功、両系統unavailable、入力rejectedと混同しない。
shadow観測はprovider、mode、outcome、候補件数、latency、有限のmismatch categoryだけを記録する。
query本文、snippet、provider raw score、document / chunk identity、error本文、secretはログへ出さない。
portable primaryのfallbackは固定のunavailable errorを返し、DB error本文を上位へ再掲しない。入力不正は別providerへretryしない。

tracked App HostingはIssue #756 / PR #757で`pgroonga-shadow`へ変更し、本番反映済み。Cloud Buildの汎用既定値は`pgroonga-primary`のまま維持する。
production triggerのsubstitutionとtracked Webが同じ値になるまでdeployしない。shadow開始後もprimary結果を変えない。
rollbackは全runtime unitを
`pgroonga-primary`へ揃え、portable schema / index / backfill済みrowを削除せず原因調査とforward fixへ進む。

Step 4の削除gateは、全chunk backfill、fallback 0、デプロイ当日の安定稼働確認、restore point / isolated restore確認が完了するまで、
PGroonga package / extension / indexのcleanupを開始しない。
これは運用条件の列挙であり、別途、固定eval合格と[holdout品質条件](keyword-evaluation.md#step-3d-holdoutとtransition比較)の達成も必須とする。
既知失敗の記録は広いholdoutの合格を意味せず、品質条件未達のまま削除へ進めない。

## Backfill CLI

`DATABASE_URL`はoperatorが選んだ対象を使う。以下はローカル合成DB向けの操作例。
`--project`はslugではなくUUID。document範囲はUUIDの昇順、両端を含む。

```bash
pnpm keyword:backfill --project "$PROJECT_UUID" --status
pnpm keyword:backfill --project "$PROJECT_UUID" --dry-run --limit 100
pnpm keyword:backfill --project "$PROJECT_UUID" --execute --limit 100 \
  --document-from "$FIRST_DOCUMENT_UUID" --document-through "$LAST_DOCUMENT_UUID"
pnpm keyword:backfill --project "$PROJECT_UUID" --execute --limit 100 \
  --document-from "$FIRST_DOCUMENT_UUID" --document-through "$LAST_DOCUMENT_UUID" \
  --resume-cursor "$CURSOR"
```

1回は1 batch、既定100件・最大1000件。`--status` / `--dry-run` / `--execute`のどれか1つを必須とする。
NULL行だけを`(document_id, id)`のkeyset順で処理する。executeはrow lockを取得し、同時ingestionを直列化する。
SKIP LOCKEDを使わず、lock timeout 5秒・statement timeout 30秒で失敗時はbatch全体をrollbackする。
大量・長文・高競合環境ではlimitを下げる。再試行は最後に成功したcursorから行う。

出力は`total` / `pending`（全指定範囲の件数、decimal文字列）、`selected` / `updated`、`dryRun`、`resumeCursor`のみ。
content、snippet、接続URLは出力しない。cursorは認証情報ではなく、scope hashとdocument/chunk UUIDをbase64url化した値。
project / document範囲を変えたcursorは拒否する。dry-runはread-onlyでcursorを進めない。
同じcursor・同じ範囲の再実行は既に完了したrowをskipする。未知projectは拒否する。

cursorはsnapshotではない。既存NULL行がcursorより前へ移動した場合など、後方に残件があれば`pending`に含まれる。
`selected=0`だけで完了と判定せず、`--status`の`pending=0`を確認する。残件があればcursorを外して再走査する。
通常の新規writeはtriggerでmaterialize済みになる。trigger停止やDB関数定義の手動変更はサポートしない。

## ローカル検証と残るgate

専用loopback DB `keyword_eval`へ`init.sql`またはbaseline＋全migrationを適用し、次を実行する。

```bash
pnpm --filter @pufu-lens/retrieval build
KEYWORD_EVAL_DATABASE_URL="postgres://postgres@127.0.0.1:5747/keyword_eval" node --experimental-strip-types --test \
  scripts/lib/keyword-selected-db.test.ts scripts/lib/keyword-backfill.test.ts
DATABASE_URL="postgres://postgres@127.0.0.1:5747/keyword_eval" pnpm db:migrate --check
DATABASE_URL="postgres://postgres@127.0.0.1:5747/keyword_eval" pnpm db:schema-drift
```

DB testは実アプリschema上の合成projectだけを作成・削除する。実データを持つDBでは実行しない。
CIの`db-check`でも専用DBを作成して実行する。DB環境変数なしのunit実行ではDB testをskipする。

固定v1の22 query / 37 chunkは既存PGroonga baseline必須で評価し、portable候補はRecall / MRR / nDCG = 1、全gateを通過した。
NFKC・Unicode lowercase（İ、Greek sigma）、trim、短query、結合文字、emoji、LIKE特殊文字、SQL注入否定例を確認した。
Step 3D holdoutでは日本語typo、1文字query、数字 / 識別子、否定 / 複数語、Unicode、literal escapingをPGroonga baselineと
portable候補へ同じproject scopeで実行する。Issue #763で数字列の完全一致guardを追加し、`invoice 31415`は正しいchunkだけ、関連なしの
`31417`は空結果となるよう修正した。2026-09-24の専用合成DBではbaseline / candidateとも14ケースの失敗0件で、baseline失敗や
未記録のcandidate失敗はなかった。threshold `0.6`、v1 judgment、入力境界は調整していない。

広いholdoutの品質合否は未判定のまま維持する。大規模・長文・project偏り・同時ingest負荷、自然plannerでのGIN/GiST比較、
WAL/容量/latency SLO、hybrid・RRF後選択・Chat HTTP、production shadowの検索観測・restoreも未検証。
今回の境界testと小規模成功は本番品質・性能の証明ではない。Step 2の全8 unit relational-only、AGE / backup /旧image保持と
自然mutation全経路・長期観測・復元試験の残件を維持する。
