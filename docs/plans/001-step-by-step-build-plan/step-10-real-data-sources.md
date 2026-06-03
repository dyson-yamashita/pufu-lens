# Step 10: 実データソース接続を 1 種類ずつ追加

### 実装する機能

実データソースは同時に増やさず、次の順に追加する。

1. Web URL
2. GitHub
3. Drive
4. Gmail

各 source で追加するもの。

- OAuth / token / GitHub App などの接続設定
- `sourceScannerTool`
- 実 API から fixture と同じ raw contract へ変換する adapter
- source 別 parser / validator の実データ fixture
- source / project / data_source ごとの parser profile と approved parser version
- rate limit / pagination / incremental window
- source ごとの skip / dedup 判定
- 失敗 raw をマスクして fixture 化し、parser 修正後に retry する運用手順

### 確認できること

- 外部 API の差分を raw contract に閉じ込められる。
- 実データでも Step 4 から Step 9 の確認方法を流用できる。
- project / data_source 固有の format 差分を Parser Registry の version として管理できる。
- scope、PII、API コスト、レート制限を source ごとに確認できる。
- 実データ接続時も全候補を Agent に渡さず、固定スクリプトで収集・parse できる。

### 確認方法

各 source で次を実行する。

```bash
pnpm ingest:collect --project sample-a --source <source> --limit 5 --dry-run
pnpm ingest:collect --project sample-a --source <source> --limit 5
pnpm ingest:run --project sample-a --source <source> --limit 5 --embedding-provider deterministic
pnpm ingest:status --project sample-a
pnpm ingest:inspect --project sample-a --source <source> --limit 5 --format json
pnpm ingest:fixture:add-failed --project sample-a --source <source> --limit 3 --dry-run
pnpm parser:version:validate --project sample-a --source <source> --held --dry-run
pnpm test -- --run "source:<source>"
```

source 別に `ingest:inspect` と source contract test で次を検査する。実データの初回接続時にブラウザや外部サービス管理画面を見る場合も、完了判定は CLI 出力、DB / storage 状態、ログ検査で行う。

- Web: canonical URL、HTML 本文抽出、content hash
- GitHub: issue / PR / comment / diff の紐付け
- Drive: folder 制限、revision、owner、mime type
- Gmail: label / query 制限、thread、最新メールと引用分解、送受信者名寄せ

### 完了条件

- `--limit 5` の小さな実データで `indexed` まで到達する。
- scope が必要最小限である。
- 個人情報を含む本文が過剰にログ出力されない。
- 同じ source を再実行しても重複しない。
- `ingest:inspect` の JSON が source contract に合い、source 別の必須項目が自動検査で通る。
- 実データ `--limit 5` の範囲で Agent / chat model を使わずに collect → parse が通る。
- source 固有 parser の変更は draft → validation → approve を通り、未承認データは `held` のまま保留される。

### 後続の品質整理

Step 10 の Web URL 接続で追加した scripts は、後続 Step 10a / Step 10b で段階的に整理する。

- Step 10a: scripts の実行形式だけを `.ts` に統一する。Step 10 確認記録に残る旧拡張子表記は、Step 10a 実装時に `.ts` へ更新済み。
- Step 10b: scripts 全体の strict typecheck 対応を行う。Step 10a では型注釈整理や `tsconfig.scripts.json` 追加は行わない。

## Step 10 確認記録

- 実施日: 2026-06-01
- 対象 Issue: #27
- 実装範囲: Web URL source scanner / raw adapter / `pnpm ingest:collect` CLI / `ingest:run --source web` の collect step 接続。2026-06-02 に `ingest:inspect`、`parser:version:validate`、失敗 raw fixture 化の source 絞り込み、`ingest:run --source web` の parse / resolve / chunk / graph source 絞り込みを追加。2026-06-03 に Issue #38 で GitHub source scanner / raw adapter / `--repo` CLI / `ingest:run --source github` の collect step 接続 / GitHub inspect contract を追加。2026-06-03 に Issue #40 で Drive source scanner / raw adapter / `--folder-id`・`--folder-url` CLI / `ingest:run --source drive` の collect step 接続 / Drive inspect contract を追加。
- 実行コマンド:
  - `pnpm --filter @pufu-lens/ingestion test`
  - `pnpm format:check`
  - `pnpm test`
  - `node --experimental-strip-types --check scripts/inspect-ingestion-source.ts && node --experimental-strip-types --check scripts/validate-parser-version.ts && node --experimental-strip-types --check scripts/ingest-workflow.ts`
  - `node --experimental-strip-types scripts/ingest-workflow.ts run --project sample-a --source web --limit 1 --dry-run`
- 自動テスト結果: Web URL の URL 正規化、canonical URL source id、本文全文を metadata に入れないこと、dry-run、重複 skip を unit test で確認。全 package test と format check も通過。
- 補助的な手動確認: workflow dry-run で collect / parse / resolve / chunk / graph の各サブコマンドに `--source web` が渡ることを確認。
- DB 確認: 2026-06-03 に Docker daemon 起動後、`step10-web-smoke` project で実 URL smoke test を実施。`raw_documents.ingest_status='indexed'` 1 件、`ingestion_queue.status='indexed'` 1 件、`documents.web_page` 1 件、`document_chunks` 1 件を確認。`sample-a` では既存 fixture Web の `parsed_uri` が過去の `/private/tmp/pufu-lens-step6-storage` を指しており、現在の `STORAGE_ROOT` から外れるため chunk で失敗した。
- Storage 確認: `/private/tmp/pufu-lens-step10-web-smoke/step10-web-smoke/raw/web/example.com-0f115db062b7.html` と `/private/tmp/pufu-lens-step10-web-smoke/step10-web-smoke/parsed/web/https-example.com.json` を確認。
- ログ / secret 確認: unit test で raw body を metadata に保存しないことを確認。実 URL でのログ検査は未実施。
- 未確認リスク: Web URL と GitHub は isolated smoke project で indexed 到達を確認済み。`sample-a` の古い fixture Web raw は storage root mismatch を起こすため、同 project で実 URL と fixture Web を混在させる場合は storage URI の掃除または volume 初期化が必要。GitHub smoke は public repo の issue 1 件で確認し、pull request diff の実データ indexed は未確認。Drive は scanner / adapter 実装済みだが実 Drive folder での indexed 到達は未確認。Gmail の実データ接続は未着手。
- 次 step に進む判断: Web URL と GitHub の collect / dedup / parse / resolve / chunk / graph / inspect が deterministic provider で通り、LLM / chat model 使用量 0 も確認できたため、Step 10 の次 source（Drive）に進める。

### 2026-06-03 追記: Web URL smoke test

- 対象 project: `step10-web-smoke`
- 対象 URL: `https://example.com`
- 実行コマンド:
  - `docker compose up -d postgres`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-web-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 create-project --slug step10-web-smoke --name "Step 10 Web Smoke"`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-web-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:collect --project step10-web-smoke --source web --url https://example.com --limit 5 --dry-run`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-web-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:run --project step10-web-smoke --source web --url https://example.com --limit 5 --embedding-provider deterministic`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-web-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:status --project step10-web-smoke`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-web-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:inspect --project step10-web-smoke --source web --limit 5 --format json`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-web-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 parser:version:validate --project step10-web-smoke --source web --held --dry-run`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-web-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:fixture:add-failed --project step10-web-smoke --source web --limit 3 --dry-run`
- 結果:
  - `ingest:collect --dry-run` は `would_collect`。
  - `ingest:run` は `collect` / `parse` / `resolve` / `chunk` / `graph` 全 step 成功。
  - workflow log の `llm` は `agentCalls=0`、`chatModelCalls=0`、`embeddingModelCalls=0`、`tokenUsage=0`。
  - `ingest:status` は `rawDocuments=1`、`queueItems=1`、`documents=1`、`documentChunks=1`、`rawDocumentsByStatus.indexed=1`、`ingestionQueueByStatus.indexed=1`、`failedQueue=[]`。
  - `ingest:inspect` は `contentHashMatchesStorage=true`、`canonicalUrlMatchesSourceId=true`、`parsedDocType=web_page`、`parsedHasBodyText=true`、`failedContracts=0`。
  - 再 collect は `skipped_existing` で、Web raw 件数は 1 件のまま。
  - `parser:version:validate --held --dry-run` は held raw がなく `total=0`。
  - `ingest:fixture:add-failed --dry-run` は失敗 raw がなく追加対象なし。

### 2026-06-03 追記: GitHub smoke test

- 対象 Issue: #38
- 対象 project: `step10-github-smoke`
- 対象 repository: `octocat/Hello-World`
- 対象 raw: `octocat/Hello-World/issues/9678`
- 実行コマンド:
  - `docker compose up -d postgres`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-github-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 create-project --slug step10-github-smoke --name "Step 10 GitHub Smoke"`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-github-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:collect --project step10-github-smoke --source github --repo octocat/Hello-World --state all --limit 1 --dry-run`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-github-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:run --project step10-github-smoke --source github --repo octocat/Hello-World --state all --limit 1 --embedding-provider deterministic`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-github-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:status --project step10-github-smoke`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-github-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:inspect --project step10-github-smoke --source github --limit 5 --format json`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-github-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 parser:version:validate --project step10-github-smoke --source github --held --dry-run`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-github-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:fixture:add-failed --project step10-github-smoke --source github --limit 3 --dry-run`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step10-github-smoke pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 ingest:collect --project step10-github-smoke --source github --repo octocat/Hello-World --state all --limit 1`
- 結果:
  - `ingest:collect --dry-run` は `would_collect`。
  - `ingest:run` は `collect` / `parse` / `resolve` / `chunk` / `graph` 全 step 成功。
  - workflow log の `llm` は `agentCalls=0`、`chatModelCalls=0`、`embeddingModelCalls=0`、`tokenUsage=0`。
  - `ingest:status` は `rawDocuments=1`、`queueItems=1`、`documents=1`、`documentChunks=1`、`rawDocumentsByStatus.indexed=1`、`ingestionQueueByStatus.indexed=1`、`failedQueue=[]`。
  - `ingest:inspect` は `contentHashMatchesStorage=true`、`sourceIdMatchesMetadata=true`、`parsedDocType=issue`、`parsedMatchesKind=true`、`parsedHasBodyText=true`、`failedContracts=0`。
  - 再 collect は `skipped_existing` で、GitHub raw 件数は 1 件のまま。
  - `parser:version:validate --held --dry-run` は held raw がなく `total=0`。
  - `ingest:fixture:add-failed --dry-run` は失敗 raw がなく追加対象なし。

### 2026-06-03 追記: Drive source 実装

- 対象 Issue: #40
- 実装範囲:
  - Drive folder scanner / raw adapter を追加。
  - `GOOGLE_DRIVE_ACCESS_TOKEN` または `GOOGLE_OAUTH_ACCESS_TOKEN` を使う `pnpm ingest:collect --source drive --folder-id ...` / `--folder-url ...` を追加。
  - `ingest:run --source drive` の collect step 接続を追加。
  - `ingest:inspect --source drive` の source contract に `fileId`、`revisionId`、`mimeType`、`ownerCount`、`drive_doc` parse 検査を追加。
  - Drive 実データ収集手順を `docs/operations/drive-source.md` に追加。
- 実行コマンド:
  - `pnpm --filter @pufu-lens/ingestion test`
  - `node --experimental-strip-types --check scripts/collect-source.ts && node --experimental-strip-types --check scripts/ingest-workflow.ts && node --experimental-strip-types --check scripts/inspect-ingestion-source.ts`
  - `pnpm format`
- 自動テスト結果: Drive folder scan、ingest window、file filter、raw metadata、本文全文 / token を metadata に保存しないこと、dry-run、重複 skip、失敗時の secret マスクを unit test で確認。ingestion package test は全 59 件成功。
- 補助的な手動確認: script 構文 check で Drive 用 CLI option と workflow option が Node の strip-types 実行形式で解釈できることを確認。
- DB 確認: 未実施。OAuth access token と実 Drive folder が必要なため、この追記時点では実 DB smoke は未実施。
- Storage 確認: 未実施。unit test の in-memory storage では raw JSON 保存と重複 skip を確認済み。
- ログ / secret 確認: unit test で Drive text fetch failure の `token=secret` がログに残らないこと、raw metadata に token と本文全文が入らないことを確認。
- 未確認リスク: 実 Drive API での `--limit 5` indexed 到達、OAuth scope の最小性、Google Docs / Sheets / Slides 以外の binary / PDF の本文抽出、実 folder での再実行重複確認は未実施。Gmail の実データ接続は未着手。
- 次 step に進む判断: Drive の実 API 接続部と contract test は追加済みだが、Step 10 の完了条件である実データ `indexed` 到達は未確認。Drive smoke 用の OAuth access token と folder が用意できたら `docs/operations/drive-source.md` の手順で確認する。
