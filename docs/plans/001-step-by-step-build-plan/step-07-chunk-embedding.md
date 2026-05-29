# Step 7: Document / Chunk / Embedding の決定的検証

### 実装する機能

- `documents` 行の最小 upsert
- `chunkAndEmbed`
- `document_chunks` への upsert
- ローカルテスト用の deterministic embedding provider
  - 入力テキストとモデル名から hash ベースで固定長 vector を生成し、同じ入力なら必ず同じ出力を返す
  - 意味検索の品質検証ではなく、chunk / DB 書き込み / 冪等性テスト専用として扱う
- Gemini embedding provider interface
- Gemini embedding の出力次元を DB の `vector(1536)` に合わせる設定
  - `GEMINI_EMBEDDING_DIMENSIONS=1536` 相当を provider 実装で必須にし、未指定時は起動時 validation で失敗させる
- chunk size / overlap / content hash の設定

### 確認できること

- 本物の Gemini API 費用をかけずに chunk と vector 保存を検証できる。
- `document_chunks.document_id` の参照先となる `documents` 行が先に作られる。
- 同じ parsed JSON から同じ chunk / hash が生成される。
- 再実行しても chunk が重複しない。
- テスト実行時の embedding 結果が外部 API、モデル更新、レート制限に左右されない。
- Gemini embedding の dry-run で、返却 vector の次元が 1536 と一致することを検査できる。

### 確認方法

```bash
pnpm ingest:chunk --project sample-a --limit 10 --embedding-provider deterministic
pnpm ingest:chunk --project sample-a --limit 3 --embedding-provider gemini --dry-run
pnpm embedding:check --provider gemini --dimensions 1536
psql "$DATABASE_URL" -c "SELECT doc_type, title, graph_node_id FROM documents ORDER BY created_at DESC;"
psql "$DATABASE_URL" -c "SELECT document_id, chunk_index, left(content, 80), embedding_model FROM document_chunks ORDER BY document_id, chunk_index;"
pnpm test -- --run chunk
```

### 完了条件

- chunk 数、順序、hash が snapshot と一致する。
- parsed JSON から `documents` が idempotent に作成される。
- 同じ対象を再実行しても `document_chunks` が増殖しない。
- embedding provider を deterministic / Gemini で切り替えられる。
- Gemini 利用時の embedding 次元と `document_chunks.embedding` の次元が一致する。
- DB schema と異なる embedding 次元では validation error になる。
