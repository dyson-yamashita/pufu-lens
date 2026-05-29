# Step 13b: Public Report 公開 artifact と配信

### 実装する機能

- private report JSON から redaction 済み public report JSON を生成する処理
- public report 用 manifest / metadata の保存と更新
- `artifact_version` を含む versioned URI への public report JSON 保存
- `/api/public/reports/[reportId]`
- `/reports/public/[projectSlug]/[reportId]`
- report 公開状態変更 API での publish / revoke 処理

### 確認できること

- public report は private report JSON をそのまま返さない。
- public report JSON には内部 `project_id`、`document_id`、raw / parsed URI、社内 URL、メールアドレス、PII を含む可能性のある snippet が含まれない。
- public report は DB 稼働確認に依存せず、業務時間外でも Object Storage から閲覧できる。
- `is_public=false`、存在しない report、revoke 済み report は同じ `404` を返す。
- report の公開状態変更時に public manifest / metadata と public artifact が同期される。
- 未公開化後に古い public artifact が manifest 経由で読まれない。

### 確認方法

```bash
pnpm report:generate --project sample-a --period weekly
pnpm report:publish --project sample-a --report <report-id>
test -f "$STORAGE_ROOT/sample-a/reports/public/<report-id>/manifest.json"
find "$STORAGE_ROOT/sample-a/reports/public/<report-id>" -type f | sort
pnpm test -- --run report:public
pnpm test:e2e -- --grep "public report"
```

public report page は Playwright e2e で次を確認する。手元ブラウザでの確認は補助とし、完了判定は public API response、redaction 検査、manifest 検査、viewport 別 screenshot で行う。

- `/reports/public/[projectSlug]/[reportId]`

### 完了条件

- public report JSON が `schema_version: "public-v1"` に合う。
- public API が redaction 済み public report JSON だけを返す。
- `is_public=false` の report が public API から取得できない。
- DB 停止中でも public report JSON を閲覧できる。
- report の公開状態変更時に public manifest / metadata が作成・更新・無効化される。
- manifest は `report_id`、`project_slug`、`public_report_uri`、`public_context_bundle_uri`、`artifact_version`、`etag`、`published_at`、`revoked_at` を持つ。
- manifest は `<project_slug>/reports/public/<report_id>/manifest.json` の固定パスにあり、DB 停止中でも `projectSlug` と `reportId` から解決できる。
- public report page の主要表示が e2e で検査され、private identifier や未公開 snippet が画面・API response に含まれない。
