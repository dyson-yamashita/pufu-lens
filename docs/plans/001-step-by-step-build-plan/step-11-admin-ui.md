# Step 11: 管理 UI と取り込み状況の可視化

### 実装する機能

- Next.js のプロジェクト一覧 / プロジェクト詳細
- データソース管理 UI
- 取り込み status UI
  - raw count
  - queue count
  - failed count
  - last checked
  - last indexed
  - retry action
- Parser Registry UI
  - parser profile 一覧
  - active parser version
  - draft / review_requested / approved / rejected の状態
  - validation report
  - approve / reject action
  - held queue の確認
- `data-testid` を主要操作に付与
- UI デザインは `docs/designs/ui/ui-design.md` と `docs/designs/ui/ui-layout.md` に合わせる

### 確認できること

- CLI / DB を見なくても ingestion の状態を把握できる。
- 失敗データを UI から再試行できる。
- held データを UI で確認し、parser version 承認後に retry できる。
- project を切り替えたときにデータが混在しない。

### 確認方法

```bash
pnpm dev
pnpm test -- --run web
pnpm test:e2e
pnpm test:e2e -- --project desktop
pnpm test:e2e -- --project mobile
```

Playwright e2e で次の画面を確認する。手元ブラウザでの確認は補助とし、完了判定は `data-testid`、API mock / fixture、viewport 別 screenshot、操作後の DB / API 状態で行う。

- `/projects`
- `/projects/[projectSlug]/admin/data-sources`
- `/projects/[projectSlug]/admin/ingestion`
- `/projects/[projectSlug]/admin/parser-profiles`

### 完了条件

- desktop / mobile でテキストや UI が重ならない。
- `sample-a` と `sample-b` の ingestion status が分離される。
- retry 操作で failed queue が再処理される。
- approve 操作なしでは held queue が parsed / indexed に進まない。
- 主要 UI 操作が `data-testid` 経由の e2e で通り、viewport 別 screenshot に重なりやレイアウト崩れがない。

## Step 11 確認記録

- 実施日: 2026-06-02
- 対象 Issue: #36
- 実装範囲: Next.js 管理 UI 基盤、プロジェクト一覧、データソース管理、取り込み status、Parser Registry UI、DB 読み取り、failed / held queue retry、parser version approve / reject action、主要 `data-testid`、Playwright e2e。
- 実行コマンド:
  - `pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 --filter @pufu-lens/web test`
  - `pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 --filter @pufu-lens/web typecheck`
  - `pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 --filter @pufu-lens/web build`
  - `pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 --filter @pufu-lens/web test:e2e`
  - `pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 format:check`
  - `pnpm --config.store-dir=/Users/yoshiharu/Library/pnpm/store/v11 typecheck`
- 自動テスト結果: web admin data test、web typecheck、web build、Playwright e2e desktop / mobile 4 件、全体 format check、全体 typecheck が成功。
- 補助的な手動確認:
  - Browser で `/projects`、`/projects/sample-a/admin/data-sources`、`/projects/sample-a/admin/ingestion`、`/projects/sample-a/admin/parser-profiles`、`/projects/sample-b/admin/data-sources` を開き、代表 `data-testid` が各 1 件取得できることを確認。
  - Browser で `/projects/step11-ui-smoke/admin/data-sources` の screenshot を取得し、狭い viewport でナビ、メトリクス、表が重ならないことを確認。
- DB 確認:
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens` で dev server を起動し、UI が DB の project / data source / queue / parser profile を読むことを確認。
  - `step11-ui-smoke` project で failed queue の Retry を UI から実行し、`ingestion_queue.status='pending'`、`attempts=0`、`last_error IS NULL`、`raw_documents.ingest_status='fetched'` になることを確認。
  - `step11-ui-smoke` project で `review_requested` parser version の Approve を UI から実行し、対象 version が `approved` かつ `parser_profiles.active_version_id` になり、held queue / raw が `pending` / `fetched` に戻ることを確認。
  - `step11-ui-smoke` project で `review_requested` parser version の Reject を UI から実行し、対象 version が `retired` になることを確認。
- Storage 確認: Step 11 は UI / DB 操作が対象であり、Storage 実体の追加確認は不要。Step 10 の Web URL smoke test で raw / parsed storage を確認済み。
- ログ / secret 確認: token / secret 値は DB query / UI 表示対象に含めず、OAuth token / refresh token / secret を画面に出していない。
- 未確認リスク: 実 workflow の再実行自体は UI の Retry 後に別 job / CLI が処理する前提で、この Step では queue reset までを確認。外部 OAuth 連携 UI は後続 source 実装で扱う。
- 次 step に進む判断: 管理 UI から project / source / ingestion / parser profile の状態を確認でき、retry / approve / reject の主要操作と desktop / mobile e2e が通ったため Step 11 は完了。
