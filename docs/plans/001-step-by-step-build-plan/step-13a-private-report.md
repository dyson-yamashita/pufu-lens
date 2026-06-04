# Step 13a: Private Report 生成と閲覧

### 実装する機能

- `generate-report` workflow
- Gemini report generation provider
- report JSON schema `v1`
- Object Storage への report JSON 保存
- `reports` / `report_chunks` 登録
- `/api/projects/[projectSlug]/reports`
- `/api/projects/[projectSlug]/reports/[reportId]`
- `/projects/[projectSlug]/reports`

### 確認できること

- graph / vector / raw / parsed から週次レポート JSON を生成できる。
- Gemini で生成した report が JSON schema `v1` に収まる。
- report 本体は storage、metadata は DB に保存される。
- private report は project member のみ取得できる。
- private report は project member 認可のため DB 依存とし、業務時間外はチャットと同様に利用不可になる。

### 確認方法

```bash
pnpm report:generate --project sample-a --period weekly
psql "$DATABASE_URL" -c "SELECT title, storage_uri, schema_version, created_at FROM reports ORDER BY created_at DESC;"
find "$STORAGE_ROOT/sample-a/reports" -type f | sort
pnpm test -- --run report
pnpm test:e2e -- --grep "private report"
```

report page は Playwright e2e で次を確認する。手元ブラウザでの確認は補助とし、完了判定は API response、schema validation、storage の実体、viewport 別 screenshot で行う。

- `/projects/[projectSlug]/reports`
- `/projects/[projectSlug]/reports/[reportId]`

### 完了条件

- JSON が schema に合う。
- report page で JSON の各 section が読める。
- DB 停止中の private report API は `db_outside_business_hours` を返す。
- private report page の主要表示が e2e で検査され、desktop / mobile で section 表示が崩れない。

## Step 13a 確認記録

- 実施日: 2026-06-04
- 対象 commit: PR 作成時の branch head
- 実装範囲:
  - `report:generate` CLI
  - deterministic fallback / Gemini report generation provider
  - private report JSON schema `v1` validation
  - Object Storage への private report JSON 保存
  - `reports` / `report_chunks` DB 登録
  - private report 一覧 / 詳細 API
  - `/projects/[projectSlug]/reports` と `/projects/[projectSlug]/reports/[reportId]`
  - private report UI の desktop / mobile e2e
- 実行コマンド:
  - `pnpm format:check`
  - `pnpm --filter @pufu-lens/web test`
  - `pnpm --filter @pufu-lens/web typecheck`
  - `pnpm scripts:typecheck`
  - `pnpm --filter @pufu-lens/web exec playwright test --grep "private report"`
  - `pnpm test`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step13a-storage pnpm report:generate --project sample-a --period weekly`
- 自動テスト結果:
  - web unit test は `web report tests passed` を含め成功。
  - `scripts:typecheck` は Next build / package build / scripts typecheck まで成功。
  - Playwright は desktop / mobile の private report 4 test が成功。
  - `pnpm test` は 5 package 全て成功。
- 補助的な手動確認:
  - in-app Browser で `/projects/sample-a/reports/report-a` を開き、DB/storage env なしでは private report API が `http_503` 表示になることを確認。
  - API env 付き dev server で report 一覧 / 詳細を `curl` し、`status: "ok"` と schema `v1` JSON を確認。
- DB 確認:
  - 既存 Docker volume に `reports` / `report_chunks` が無かったため、smoke DB に `CREATE TABLE IF NOT EXISTS` で追加。
  - `reports` に `週次レポート 2026-06-01 - 2026-06-07`、`schema_version = v1`、storage URI が登録されたことを確認。
  - `report_chunks` は対象 report で 4 件登録されたことを確認。
- Storage 確認:
  - `/private/tmp/pufu-lens-step13a-storage/sample-a/reports/private/95aaada7-2f86-4d53-94ff-1f6df8041c7b.json` を確認。
- ログ / secret 確認:
  - report 生成は deterministic fallback で実行し、Gemini API key / OAuth token は使用していない。
  - API / CLI 出力に secret は含まれていない。
- 未確認リスク:
  - Gemini 実 API の JSON schema 収束は API key を使わず未実行。
  - GCS storage driver は未実装のため local storage のみ確認。
  - 既存 DB volume への schema migration は手動 smoke で実施。永続的な migration 方式は今後の DB migration step で整理が必要。
- 次 step に進む判断:
  - Private Report の生成、保存、DB metadata / chunks、API、UI、業務時間外応答、desktop / mobile e2e を確認できたため Step 13b に進める。
