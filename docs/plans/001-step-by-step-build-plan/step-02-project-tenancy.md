# Step 2: Project 作成とテナント分離の確認

### 実装する機能

- `scripts/create-project.ts`
  - `projects` 行を作成
  - `graph_name` を slug から生成
  - AGE graph を作成
  - storage prefix を作成
- seed 用のサンプル project を 2 件作成できる script
- project slug / graph name の validation

### 確認できること

- project 単位で DB 行、graph、storage prefix が分離される。
- 不正 slug や graph name が弾かれる。
- 以降の ingestion が必ず `project_id` を持って動く土台ができる。

### 確認方法

```bash
pnpm tsx scripts/create-project.ts --slug sample-a --name "Sample A"
pnpm tsx scripts/create-project.ts --slug sample-b --name "Sample B"
psql "$DATABASE_URL" -c "SELECT slug, graph_name, storage_prefix FROM projects ORDER BY slug;"
find "$STORAGE_ROOT" -maxdepth 2 -type d | sort
```

### 完了条件

- 2 project の DB / graph / storage が分離される。
- 同じ slug の再作成が安全に失敗または idempotent に処理される。

## Step 2 確認記録

- 実施日: 2026-05-30
- 対象 commit: `feature/issue-7-project-tenancy` の PR 作成前 head
- 実装範囲: `scripts/create-project.ts`、project slug / graph name validation、sample project seed、storage prefix 作成、plan status 更新
- 実行コマンド:
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `docker compose config`
  - `docker compose up -d postgres`
  - `DATABASE_URL="$DATABASE_URL" STORAGE_ROOT=/private/tmp/pufu-lens-storage pnpm seed:projects`
  - `psql "$DATABASE_URL" -c "SELECT slug, graph_name, storage_prefix FROM projects WHERE slug IN ('sample-a', 'sample-b') ORDER BY slug;"`
  - `psql "$DATABASE_URL" -c "SELECT name FROM ag_catalog.ag_graph WHERE name IN ('graph_sample_a', 'graph_sample_b') ORDER BY name;"`
  - `find /private/tmp/pufu-lens-storage -maxdepth 2 -type d`
- 自動テスト結果: `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` が成功。
- 補助的な手動確認: `pnpm create-project --slug bad_slug --name "Bad"` が不正 slug を拒否することを確認。
- DB 確認: `sample-a` / `sample-b` の `slug`、`graph_name`、`storage_prefix` が分離して登録されることを確認。
- Storage 確認: `/private/tmp/pufu-lens-storage/sample-a/{raw,parsed,reports}` と `/private/tmp/pufu-lens-storage/sample-b/{raw,parsed,reports}` が作成されることを確認。
- ログ / secret 確認: CLI 出力は project slug、graph name、storage prefix URI のみで、token / secret / PII は出力しない。
- 未確認リスク: Docker volume 上の sample project はローカル確認用に残っている。必要に応じて手動で compose volume を初期化する。
- 次 step に進む判断: Step 2 の完了条件を満たしたため、PR merge 後に Step 3 へ進める。
