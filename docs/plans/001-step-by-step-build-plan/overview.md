# Pufu Lens Step by Step 構築計画

## 目的

Pufu Lens を一度に大きく実装して最後に確認するのではなく、各ステップで「動く最小単位」を作り、データ取り込みからデータ構築までを丁寧に検証しながら進める。

特に重要な確認対象は次のとおり。

- Collection Pipeline が候補を発見し、原本を保存し、`raw_documents` と `ingestion_queue` を正しく更新できること
- Ingestion Workflow が原本から parse、Actor 名寄せ、chunk、embedding、graph / vector / relational 保存まで段階的に進められること
- 重複、再実行、失敗、再試行、プロジェクト分離、PII / secret ログ漏れを各段階で確認できること
- UI / API / Agent の前に、データ基盤の状態遷移を CLI / DB / storage で観察できること

## 進め方の原則

- 1 step = 1 つの確認可能な成果物を基本にする。
- 各 step の完了時に `git status --short`、関連テスト、CLI / API / storage / DB / log による確認結果を記録する。
- 手動確認やブラウザ確認は補助確認として扱い、完了判定は可能な限り自動テスト、scripted smoke test、CLI、API response、snapshot、ログ検査で行う。
- データ取り込み系は外部 API 依存を後回しにし、まず fixture とローカルストレージで再現性を作る。
- 初期構築の LLM / embedding provider は Gemini API（Google AI / Vertex AI）を前提とし、`GEMINI_CHAT_MODEL`、`GEMINI_EMBEDDING_MODEL`、`GEMINI_API_KEY` または Vertex AI 認証を環境変数で切り替えられるようにする。
- ただし通常の収集・parse は Agent / LLM を呼ばず、source 別 scanner / parser / validator と deterministic embedding provider で検証できるようにする。
- DB / storage / graph / UI の更新は、必ず観察用コマンド、API、e2e test、または screenshot 検査で状態を確認できるようにする。
- 本物の OAuth token、個人情報、secret は fixture に入れない。ログには本文全文や token を出さない。
- 仕様や設計の差分が出た step では `docs/designs/*` の更新要否を確認する。

## Mastra UI で確認する範囲

Mastra UI（Studio / Playground）は、Agent / Workflow の入出力、tool call、step 実行、trace / log を観察するために使う。DB / Storage / Graph の最終整合性、認可、secret 漏れ、再実行時の idempotency は Mastra UI だけで完了判定せず、CLI、DB query、storage 確認、自動テストで検証する。

| 対象                           | Mastra UI で確認すること                                                                                                                                                           | Mastra UI だけでは完了判定しないこと                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection Pipeline            | `lookupRawDocument` → `fetchRaw` → `linkDataSource` → `queueCandidate` の処理順序、skip / enqueue 判断、log に本文全文や secret が出ないこと、通常経路で LLM call が発生しないこと | `raw_documents` / `raw_document_data_sources` / `ingestion_queue` の実レコード、storage に保存された原本、重複投入時の件数不変                           |
| Exception Agent                | 失敗 raw / parsed の調査、parser / validator 修正案、低 confidence 候補の整理、trace / token 使用量                                                                                | 修正後の fixture test、snapshot、failed queue retry、DB / Storage / Graph の最終整合性                                                                   |
| Ingestion Workflow             | `dequeueTargets`、`parseRaw`、`resolveActors`、`chunkAndEmbed`、`storeGraph` の step 入出力、失敗時の error、resume / retry の分岐                                                 | `parsed_uri` の実体、`documents` / `document_chunks` / `email_quotes` / graph の件数、embedding 次元、project 越境がないこと                             |
| Chat Agent                     | private chat の `vector-search`、`graph-query`、`document-fetch` などの tool selection、public chat の公開 context 限定回答、回答に source が含まれること                          | API 認可、サイズ上限、他 project の document を取得できないこと、public chat から raw / parsed / DB に触れないこと、ブラウザへの Gemini API key 露出防止 |
| Report Workflow / Report Agent | report 生成プロンプト、graph / vector / raw / parsed 参照の順序、JSON schema へ収める試行、生成時 trace / token 使用量                                                             | report JSON の storage 保存、`reports` / `report_chunks` 登録、private report の取得制御                                                                 |
| Scheduler / Job entrypoint     | workflow を単体で呼び出したときの step graph、失敗箇所、retry 可能性                                                                                                               | Cloud Run Job、Cloud Scheduler、Secret Manager、VPC、GCS prefix などクラウド権限境界                                                                     |

## Step 一覧

Step の詳細を参照する前に、この表で status を確認する。

| step     | plan                                                                                   | status      | 更新日     | メモ                                                 |
| -------- | -------------------------------------------------------------------------------------- | ----------- | ---------- | ---------------------------------------------------- |
| Step 0   | [開発基盤と品質ゲート](step-00-foundation.md)                                          | `completed` | 2026-05-29 | pnpm workspaces / Turborepo と品質ゲートを追加済み。 |
| Step 1   | [ローカル DB / Storage の最小起動](step-01-local-db-storage.md)                        | `completed` | 2026-05-30 | PR #6 で merge 済み。                                |
| Step 2   | [Project 作成とテナント分離の確認](step-02-project-tenancy.md)                         | `completed` | 2026-05-30 | Issue #7 で完了確認済み。                            |
| Step 3   | [Ingestion Fixture とデータ契約](step-03-ingestion-fixtures.md)                        | `completed` | 2026-05-30 | Issue #9 で完了確認済み。                            |
| Step 4   | [Collection Pipeline のローカル収集パイプライン](step-04-local-collection-pipeline.md) | `completed` | 2026-05-31 | Issue #13 で完了確認済み。                           |
| Step 4a  | [Parser Registry と承認制保留フロー](step-04a-parser-registry-approval.md)             | `completed` | 2026-05-31 | Issue #11 / PR #12 で設計反映済み。                  |
| Step 5   | [Raw Parse と parsed JSON 保存](step-05-raw-parse.md)                                  | `completed` | 2026-05-31 | Issue #15 で完了確認済み。                           |
| Step 6   | [Actor 名寄せと引用チェーン](step-06-actor-resolution.md)                              | `completed` | 2026-05-31 | Issue #17 で完了確認済み。                           |
| Step 7   | [Document / Chunk / Embedding の決定的検証](step-07-chunk-embedding.md)                | `completed` | 2026-05-31 | Issue #19 で完了確認済み。                           |
| Step 8   | [Graph / Relation 構築](step-08-graph-relations.md)                                    | `completed` | 2026-06-01 | Issue #21 で完了確認済み。                           |
| Step 9   | [Ingestion Workflow の通し実行](step-09-ingestion-workflow.md)                         | `completed` | 2026-06-01 | Issue #25 で完了確認済み。                           |
| Step 10  | [実データソース接続を 1 種類ずつ追加](step-10-real-data-sources.md)                    | `planned`   | 2026-05-29 | 未着手。                                             |
| Step 11  | [管理 UI と取り込み状況の可視化](step-11-admin-ui.md)                                  | `planned`   | 2026-05-29 | 未着手。                                             |
| Step 12  | [Chat Agent の最小確認](step-12-chat-agent.md)                                         | `planned`   | 2026-05-29 | 未着手。                                             |
| Step 13a | [Private Report 生成と閲覧](step-13a-private-report.md)                                | `planned`   | 2026-05-29 | 未着手。                                             |
| Step 13b | [Public Report 公開 artifact と配信](step-13b-public-report-artifact.md)               | `planned`   | 2026-05-29 | 未着手。                                             |
| Step 13c | [Public Chat 限定 context と安全確認](step-13c-public-chat-context.md)                 | `planned`   | 2026-05-29 | 未着手。                                             |
| Step 14  | [Scheduler / Cloud Run Job / Deploy 検証](step-14-scheduler-deploy.md)                 | `planned`   | 2026-05-29 | 未着手。                                             |

### ステータス定義

| status       | 意味                         | 参照ルール                               |
| ------------ | ---------------------------- | ---------------------------------------- |
| `planned`    | 未着手。今後実施予定。       | 作業対象として参照してよい。             |
| `active`     | 現在作業中の Step。          | 優先して参照する。                       |
| `blocked`    | 外部要因や判断待ちで停止中。 | 理由を確認し、勝手に再開しない。         |
| `completed`  | 完了済み。                   | ユーザーが明示した場合を除き参照しない。 |
| `deprecated` | 破棄・置き換え済み。         | ユーザーが明示した場合を除き参照しない。 |

### Step 進捗の運用ルール

- Step の着手・完了・停止時は、この表の `status`、更新日、メモを同時に更新する。
- Step 完了時は、該当 Step ファイルの確認方法と完了条件に沿って検証結果を残す。
- `completed` / `deprecated` の Step は、ユーザーが明示した場合を除き通常作業の参照対象にしない。

## データ取り込み・成形の重点確認項目

### 状態遷移

| 対象              | 正常系                                       | 失敗系                    | 再試行                                       |
| ----------------- | -------------------------------------------- | ------------------------- | -------------------------------------------- |
| `raw_documents`   | `fetched` → `parsed` → `indexed`             | `failed` + `ingest_error` | 原本を再 fetch せず `storage_uri` から再処理 |
| `ingestion_queue` | `pending` → `parsing` → `parsed` → `indexed` | `failed` + `last_error`   | `attempts` を増やして再投入                  |
| Object Storage    | `raw` → `parsed` → `reports`                 | 原本は保持                | parsed の再生成を許可                        |

### 重複確認

- `(project_id, source_type, source_id)` が同じ場合は `raw_documents` を増やさない。
- `content_hash` が同じでも `source_id` が異なる場合は raw を統合せず、更新検知または SAME_AS 候補として扱う。
- 別 `data_source` が同じ実体を拾った場合は `raw_document_data_sources` のみ増える。
- 別 source type の意味的同一は raw を統合せず、graph の `SAME_AS` で表現する。

### 成形確認

- Gmail は最新メールを `documents`、過去引用を `email_quotes` に分離する。
- Drive は revision を metadata に残し、最新版だけ `documents` にする。
- Web は canonical URL と content hash を保存する。
- GitHub は issue / PR / comment / diff の関係を graph で辿れるようにする。
- Actor は email / GitHub login を strong alias として扱い、display name は低 confidence 候補として扱う。

### セキュリティ確認

- OAuth token / refresh token / secret をログと fixture に出さない。
- Gemini API key / Google Cloud 認証情報をログと fixture に出さない。
- raw document の本文全文を通常ログに出さない。
- projectId 必須の API / workflow にする。
- private report / raw document / parsed document は project member 認可後だけ返す。
- DB 停止中は private report / raw document / parsed document を返さず、public report だけ公開用 manifest / metadata に基づいて返す。
- public chat は redaction 済み public report / public context bundle だけを使い、PII、未公開 URL、raw / parsed 本文全文、secret を回答しない。

## 各 step のレビュー記録テンプレート

```markdown
## Step N 確認記録

- 実施日:
- 対象 commit:
- 実装範囲:
- 実行コマンド:
- 自動テスト結果:
- 補助的な手動確認:
- DB 確認:
- Storage 確認:
- ログ / secret 確認:
- 未確認リスク:
- 次 step に進む判断:
```

## 最初の実装順序の推奨

まず Step 0 から Step 9 までを fixture ベースで完了させる。ここまでで外部 API に触らず、データ取り込みからデータ構築までの正しさ、再実行性、重複排除、失敗時の復旧を確認する。

その後 Step 10 で Web → GitHub → Drive → Gmail の順に実データソースを追加する。Gmail は引用分解、PII、scope の確認が重いため、最後に回す。
