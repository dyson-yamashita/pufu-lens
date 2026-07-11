# Storage Recovery Artifacts 計画

> **中止（2026-07-11、Issue #524）**: 現時点で Step 2 以降の着手予定がないため、本計画を `deprecated` とする。Step 1 で実装済みの artifact schema / writer / reader は削除せず維持する。将来再開する場合は、現行の logical source ID / source version 契約と実装状況を再調査し、新しい Issue または plan でスコープを定義する。

## 目的

DB / AGE graph が消失、リプレイス、またはデータ移行された場合でも、Object Storage に残る raw / parsed / graph artifact から関係性まで復元できるようにする。

この計画では Object Storage を復元元、DB を再構築可能なインデックスとして扱う。DB UUID は復元後に変わってよいものとし、復元キーは `projectSlug + sourceType + sourceId + contentHash` と `graphNodeId` を基本にする。

## 方針

- 保存形式は append-only event object と `latest.json` pointer にする。`ObjectStorage` は append API を持たず、GCS もオブジェクト追記を提供しないため、単一 JSONL への read-modify-write append は採用しない。
- 各 raw / parsed / graph event は 1 レコード = 1 オブジェクトとして保存し、復元時は `list()` で event prefix を走査する。
- raw / parsed だけでなく、graph materialize 済みの node / edge / email quote を artifact として保存する。
- v1 の復元対象は `raw_documents`、`parsed_uri`、`documents`、`email_quotes`、AGE graph node / edge とする。
- embedding vector、report artifact、public / private report の復元は v1 の対象外にする。
- 復元直後は `document_chunks` / embedding が存在しないため、vector search は効かない。検索を再開するには chunk / embedding step を再実行する。
- manifest / log には secret、OAuth token、raw 本文全文を出さない。

## 保存する artifact

| artifact prefix / file                               | 目的                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `<project>/manifests/raw-documents/events/*.json`    | raw 本体への参照と `raw_documents` 復元情報を保持する。           |
| `<project>/manifests/parsed-documents/events/*.json` | raw と parsed JSON の対応、parser 情報を保持する。                |
| `<project>/graph/relations/events/*.json`            | graph node / edge / email quote の復元情報を保持する。            |
| `<project>/manifests/raw-documents/latest.json`      | 最新 raw manifest event set の件数、hash、生成時刻を保持する。    |
| `<project>/manifests/parsed-documents/latest.json`   | 最新 parsed manifest event set の件数、hash、生成時刻を保持する。 |
| `<project>/graph/relations/latest.json`              | 最新 graph event set の件数、hash、生成時刻を保持する。           |

### raw manifest

`raw-documents/events/*.json` は raw 保存と `raw_documents` upsert が成功した後に、イベント単位で保存する。ファイル名は `recordedAt`、`sourceType`、`sourceId`、`contentHash` から衝突しない storage-safe な名前を作る。

主な項目:

- `artifactVersion`
- `recordedAt`
- `projectSlug`
- `sourceType`
- `sourceId`
- `sourceUri`
- `storageUri`
- `contentHash`
- `mimeType`
- `byteSize`
- `fetchedAt`
- `metadata`
- `dataSourceKeys`

### parsed manifest

`parsed-documents/events/*.json` は parsed JSON 保存と `markParsed` が成功した後に、イベント単位で保存する。DB UUID は補助情報として保持してよいが、復元の主キーには使わない。

主な項目:

- `artifactVersion`
- `recordedAt`
- `projectSlug`
- `sourceType`
- `sourceId`
- `contentHash`
- `rawStorageUri`
- `parsedUri`
- `parserProfileKey`
- `parserVersion`
- `parserArtifactHash`
- `parsedSchemaVersion`
- `parsedAt`
- `sourceParserProfileId`
- `sourceParserVersionId`

### graph relation events

`graph/relations/events/*.json` は graph materialize 時にイベント単位で保存する。`storeGraphRelations` が DB / AGE に upsert する正規化済みの node / edge と、`email_quotes` に保存する quote 情報を同じ単位で保存する。

主な項目:

- `artifactVersion`
- `recordedAt`
- `projectSlug`
- `sourceType`
- `sourceId`
- `contentHash`
- `documentGraphNodeId`
- `nodes`
- `edges`
- `emailQuotes`
- `document`

`document` には `documents` 復元に必要な `docType`、`title`、`summary`、`canonicalUri`、`occurredAt`、`metadata` を保存する。graph node の properties から推測せず、復元用の安定した shape として明示する。

### latest pointer

各 `latest.json` は対象 prefix の `eventCount`、`sha256`、`generatedAt`、`artifactVersion` を保持する。破損検出は行単位ではなく、event object の JSON parse、schema validation、prefix 内 event count、`latest.json` の hash 照合で行う。

## 復元セマンティクス

- 同じ `projectSlug + sourceType + sourceId + contentHash` の raw / parsed event が複数ある場合は `recordedAt` が最新の event を使う。
- 同じ `documentGraphNodeId` の graph event が複数ある場合は last-wins とし、最新 event の node / edge / email quote だけを適用する。
- `email_quotes` は現行実装と同じく document 単位で replace する。
- 復元した `raw_documents.ingest_status` は graph event がある場合 `indexed`、parsed event だけの場合 `parsed`、raw event だけの場合 `fetched` にする。
- 復元した `ingestion_queue` は v1 では再作成しない。再 parse / reindex が必要な場合は、復元後に専用 retry / reindex step を実行する。
- `projects` は復元前に存在している必要がある。`data_sources`、`parser_profiles`、`parser_versions` は自然キーで解決できる場合だけリンクし、解決できない場合は dry-run で警告する。
- `raw_document_data_sources` は `dataSourceKeys` が解決できる場合だけ復元する。解決できない data source link は skip し、raw / parsed / graph の復元は継続する。
- parser 同定は `parserProfileKey`、`parserVersion`、`parserArtifactHash`、`parsedSchemaVersion` を使う。`sourceParserProfileId` / `sourceParserVersionId` は監査用であり、復元後 DB の FK として信用しない。
- Storage にあるが DB / manifest に存在しない orphan raw / parsed artifact は dry-run で報告する。v1 の apply では自動採用しない。

## Step 構成

| Step | status       | 内容                                                           | 完了条件                                               |
| ---- | ------------ | -------------------------------------------------------------- | ------------------------------------------------------ |
| 1    | `completed`  | event object schema / writer / reader を追加する。Issue #117。 | `pnpm --filter @pufu-lens/ingestion test` で確認済み。 |
| 2    | `deprecated` | collection / parse / graph に artifact 書き込みを統合する。    | 中止。                                                 |
| 3    | `deprecated` | `ingest:reconcile-artifacts` を追加する。                      | 中止。                                                 |
| 4    | `deprecated` | `ingest:restore --dry-run` を追加する。                        | 中止。                                                 |
| 5    | `deprecated` | `ingest:restore --apply` を追加する。                          | 中止。                                                 |
| 6    | `deprecated` | docs / 運用手順 / smoke test を整備する。                      | 中止。                                                 |

## 完了条件

- fixture ingest 後に raw / parsed / graph artifact が Object Storage に作成される。
- 導入前に ingest 済みの既存データを `ingest:reconcile-artifacts` で backfill できる。
- DB 空想定で dry-run が復元予定件数と欠損を報告できる。
- apply 後に `raw_documents`、`documents`、`email_quotes`、AGE graph node / edge が再作成される。
- 復元後の `raw_documents.ingest_status` が `fetched` / `parsed` / `indexed` のいずれかに正しく設定され、意図しない全件再 parse を起こさない。
- manifest / log に secret、OAuth token、raw 本文全文が出ない。
- 既存 ingestion workflow の再実行性、重複 skip、project 分離を壊さない。

## テスト計画

- artifact schema validation の unit test。
- event object の write / list / read と破損検出の unit test。
- fixture ingest run 後に raw / parsed / graph artifact が保存される integration test。
- 既存 DB + Storage から欠損 artifact を backfill する reconcile test。
- restore dry-run が復元予定件数、欠損 artifact、衝突を報告する test。
- 同一 document の複数 graph event では last-wins で復元される test。
- parser UUID が存在しない復元先でも、自然キーと artifact hash で parser を解決する test。
- restore apply 後に `raw_documents`、`documents`、`email_quotes`、graph node / edge が復元される test。
- 復元直後は `document_chunks` が存在せず、chunk / embedding 再実行が必要であることを status / docs で確認する test。
- Storage に orphan parsed JSON がある場合、dry-run が DB 未参照 artifact として報告する test。
- secret / token / raw 本文全文が manifest とログに出ない regression test。

## 実装時の注意

- Step に着手するときは `.codex/rules/plan-rule.md` に従い、最新 `main` から Step 用ブランチを作成し、GitHub Issue を作成する。
- artifact 書き込み失敗時に DB だけ進むと復元元が欠けるため、collection / parse / graph の成功判定と artifact 書き込みの整合を設計する。
- 並行 worker が同じ manifest object を更新する設計にしない。単一 JSONL append、read-modify-write append、単一ライター前提は v1 では採用しない。
- 復元 CLI は `--dry-run` を既定動作にし、`--apply` 指定時だけ DB / AGE graph を更新する。
- event object の compaction / retention は v1 では扱わず、必要になった時点で別計画に分ける。
