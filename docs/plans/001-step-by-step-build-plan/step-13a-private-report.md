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
