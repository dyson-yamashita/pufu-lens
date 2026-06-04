# Step 13d: Mastra Agent / Workflow 登録

### 背景

Step 12 と Step 13a は、Mastra runtime へ載せる前に Next.js / CLI 側で server-side core と確認経路を先に作った Step である。現状 `apps/mastra/src/index.ts` は scaffold のみで、Mastra `Agent` / `Workflow` の登録実体はない。

この Step では、既存 core を再利用して `apps/mastra` に Agent / Workflow を登録し、Mastra Studio / Playground で観察できる状態にする。二重実装を避けるため、DB / Storage / provider / schema validation は既存の `apps/web/src/chat.ts` と `apps/web/src/report.ts` の境界を移動または共有できる形に整理する。

### 実装する機能

- `apps/mastra` の Mastra runtime 初期化
- `project-chat-agent`
- `vector-search` tool
- `graph-query` tool
- `document-fetch` tool
- `raw-document-fetch` tool
- `parsed-doc-fetch` tool
- `generate-report` workflow
- 必要に応じた `report-agent`
- Mastra Agent / Workflow を `apps/mastra/src/index.ts` から登録・export
- Next.js API / CLI から Mastra 経由と core 直接実行を切り替えるための境界整理
- Mastra 用 unit test / smoke test

### 確認できること

- `apps/mastra` に `project-chat-agent` と `generate-report` workflow が登録されている。
- Mastra Studio / Playground で chat agent の tool call と workflow step graph を観察できる。
- chat agent は指定 project の data だけを参照し、project 越境を拒否する。
- `generate-report` workflow は report JSON schema `v1` に合う JSON を生成し、Object Storage と DB に保存する。
- Gemini API key / OAuth token / raw 本文全文が Mastra trace と log に漏れない。
- Step 12 / 13a の Next.js / CLI core と Mastra 側が二重実装にならない。
- 通常の ingestion / collection は引き続き Agent / LLM を呼ばず、deterministic path のまま動く。

### 確認方法

```bash
pnpm --filter @pufu-lens/mastra test
pnpm --filter @pufu-lens/mastra typecheck
pnpm test
pnpm scripts:typecheck
pnpm chat:eval --project sample-a --fixture fixtures/chat/private-chat-eval.json
pnpm report:generate --project sample-a --period weekly
```

Mastra Studio / Playground では次を補助確認する。

- `project-chat-agent` が `vector-search` → `graph-query` → `document-fetch` / `raw-document-fetch` / `parsed-doc-fetch` の tool call を trace に残す。
- `generate-report` workflow が period 解決、context 取得、report JSON 生成、storage 保存、DB 登録、report chunk 登録を step として観察できる。
- 失敗時に error が step 単位で確認でき、secret / raw 本文全文が trace に出ない。

### 完了条件

- `apps/mastra` が scaffold ではなく Mastra Agent / Workflow 登録を持つ。
- `project-chat-agent` と `generate-report` workflow が自動テストまたは scripted smoke で実行できる。
- Mastra UI で Agent / Workflow の入出力、tool call、step graph、trace を確認できる。
- private chat / private report の project member 認可、業務時間外 `db_outside_business_hours`、project 越境拒否が維持される。
- Gemini API key / OAuth token / secret / raw 本文全文が browser、API response、Mastra trace、log に露出しない。
- Step 14 の Scheduler / Cloud Run Job / Deploy 検証に進めるよう、`generate-report` workflow id、job entrypoint、internal API の呼び出し境界が明確になっている。
