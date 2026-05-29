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
- `data-testid` を主要操作に付与
- UI デザインは `docs/designs/ui/ui-design.md` と `docs/designs/ui/ui-layout.md` に合わせる

### 確認できること

- CLI / DB を見なくても ingestion の状態を把握できる。
- 失敗データを UI から再試行できる。
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

### 完了条件

- desktop / mobile でテキストや UI が重ならない。
- `sample-a` と `sample-b` の ingestion status が分離される。
- retry 操作で failed queue が再処理される。
- 主要 UI 操作が `data-testid` 経由の e2e で通り、viewport 別 screenshot に重なりやレイアウト崩れがない。
