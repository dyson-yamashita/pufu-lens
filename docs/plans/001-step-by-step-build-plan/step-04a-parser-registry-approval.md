# Step 4a: Parser Registry と承認制保留フロー

### 実装する機能

- Parser Registry の DB schema / repository
  - `parser_profiles`
  - `parser_versions`
  - `raw_documents.parser_profile_id` / `raw_documents.parser_version_id`
  - `ingestion_queue.parser_profile_id` / `ingestion_queue.parser_version_id`
  - `held` status / `hold_reason`
- project / data_source / source_type ごとの parser profile 作成
- draft parser version の artifact 保存
  - local: Object Storage の local driver
  - cloud: GCS
  - artifact hash を DB に記録
- draft parser version の validation report 作成
  - fixture
  - held raw
  - schema validation
  - secret / PII mask 確認
- parser version approve / reject CLI
- 承認済み parser version だけを active にできる制約
- 承認済み parser が無い raw を `held` にし、graph / vector / documents に進めない制御

### 確認できること

- project / data_source ごとに parser version を分けられる。
- draft parser は dry-run / validation にだけ使われ、本番 ingest には使われない。
- approved parser version だけが active になり、queue item に固定される。
- parser artifact は Cloud Run Job のローカルファイルシステムではなく Object Storage から取得される。
- NG raw は `held` になり、承認後に retry できる。

### 確認方法

```bash
pnpm parser:profile:create --project sample-a --source web --name sample-web
pnpm parser:version:create --project sample-a --profile sample-web --artifact fixtures/ingestion/web-parser.json
pnpm parser:version:validate --project sample-a --profile sample-web --version 1 --fixture
pnpm parser:version:approve --project sample-a --profile sample-web --version 1
pnpm ingest:parse --project sample-a --limit 10
pnpm ingest:status --project sample-a
psql "$DATABASE_URL" -c "SELECT status, hold_reason, parser_profile_id, parser_version_id FROM ingestion_queue ORDER BY updated_at DESC;"
psql "$DATABASE_URL" -c "SELECT ingest_status, hold_reason, parser_version_id, parser_artifact_hash FROM raw_documents ORDER BY updated_at DESC;"
```

未承認 parser の確認:

```bash
pnpm parser:version:create --project sample-a --profile sample-web --artifact fixtures/ingestion/web-parser-draft.json
pnpm ingest:parse --project sample-a --limit 10 --parser-version draft
psql "$DATABASE_URL" -c "SELECT status, hold_reason FROM ingestion_queue WHERE status = 'held';"
```

### 完了条件

- 未承認 parser version では `ingest-workflow` が parsed / indexed へ進まない。
- `held` raw / queue に `hold_reason` と要求 parser profile が記録される。
- approved parser version の artifact hash が検証され、raw / parsed metadata に記録される。
- parser version approve / reject の監査情報が DB に残る。
- Cloud Run Job の一時 filesystem に parser 永続状態を置かない方針がテストまたは設定で確認できる。
