# Portable keyword materialization（Step 3C / 3D）

Issue #752で候補adapterとadditive schemaを実装し、Issue #754でshadow / primary + fallbackの切替準備を追加した。
通常runtimeのkeyword primaryは`pgroonga-primary`（PGroonga）のままで、Core RRF `k=60`、Chat API、期間付き検索の
既存経路は変更しない。本番migration・backfill・shadow有効化・切替は未実施。本番実行は別承認、品質gate、backup確認が必要であり、
PGroonga indexはrollback window中維持する。

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

現在のtracked App Hosting / Cloud Build設定は`pgroonga-primary`である。切替準備で変更するのは設定と検証だけであり、
本番migration、backfill、shadow有効化、primary切替、deployは含まない。rollbackは全runtime unitを
`pgroonga-primary`へ揃え、portable schema / index / backfill済みrowを削除せず原因調査とforward fixへ進む。

Step 4の削除gateは変更しない。全chunk backfill、fallback 0、最低7日soak、restore point / isolated restore確認が完了するまで、
PGroonga package / extension / indexのcleanupを開始しない。

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
portable候補へ同じproject scopeで実行する。関連なしの数字query `31417`は`invoice 31415` / `invoice 31416`へ近似一致する
2件のfalse positiveを再現し、holdout gateを不合格として記録する。これは既知の失敗を可視化するものであり、閾値・v1 judgmentを調整しない。

広いholdoutの品質合否は上記known failureのため未達。大規模・長文・project偏り・同時ingest負荷、自然plannerでのGIN/GiST比較、
WAL/容量/latency SLO、hybrid・RRF後選択・Chat HTTP、production backfill・7日soak・restoreも未検証。
今回の境界testと小規模成功は本番品質・性能の証明ではない。Step 2の全8 unit relational-only、AGE / backup /旧image保持と
自然mutation全経路・長期観測・復元試験の残件を維持する。
