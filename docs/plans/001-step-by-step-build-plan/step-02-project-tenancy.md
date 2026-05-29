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
