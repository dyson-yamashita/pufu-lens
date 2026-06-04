# Step 12: Chat Agent の最小確認

### 実装する機能

- `vector-search`
- `graph-query`
- `document-fetch`
- `raw-document-fetch`
- `parsed-doc-fetch`
- Gemini chat provider
- `/api/projects/[projectSlug]/chat`
- `/projects/[projectSlug]/chat`

### 確認できること

- 構築済みデータから質問に回答できる。
- Gemini を使った回答生成を小さな fixture データで確認できる。
- 回答が document_id / canonical_uri などの情報源を含む。
- 必要に応じて raw / parsed を辿れる。
- 他 project の document を参照しない。
- 業務時間外は DB 依存のチャットを実行せず、利用不可メッセージを返す。

### 確認方法

```bash
pnpm test -- --run chat
GEMINI_CHAT_MODEL="${GEMINI_CHAT_MODEL}" pnpm test -- --run chat:gemini
pnpm chat:eval --project sample-a --fixture fixtures/chat/private-chat-eval.json
pnpm dev
```

`chat:eval` では次のような質問と期待条件を fixture 化し、回答本文、source、tool call、拒否条件を検査する。

- 「直近の未解決 Issue を要約して」
- 「この仕様変更に関係する PR とメールを教えて」
- 「同じ内容を参照している Web / Drive / GitHub の資料はある？」

### 完了条件

- 回答に source が含まれる。
- project 越境アクセスがテストで失敗する。
- raw document の取得にはサイズ上限と権限チェックがある。
- Gemini API key / Vertex AI 認証情報がサーバ側だけで使われ、ブラウザに露出しない。
- 業務時間外は Chat API が `db_outside_business_hours` を返し、UI が入力欄を disabled にする。
- private chat は user + project 単位の rate limit を持つ。
- `chat:eval` が期待 source、拒否条件、project 越境防止、営業時間外の応答を自動検査する。

## Step 12 確認記録

- 実施日: 2026-06-03、2026-06-04
- 対象 Issue: #44
- 実装範囲: Chat コア、Gemini chat provider、extractive fallback provider、rate limit、業務時間外判定、project member 確認、`vector-search` / `graph-query` / `document-fetch` / `raw-document-fetch` / `parsed-doc-fetch` の最小 tool call、Chat API、Chat UI、`chat:eval` CLI と fixture を追加。2026-06-04 に `chat:eval` の HTTP status / error / case 別 project 検査、project 越境拒否 fixture、営業時間外 fixture、Chat API の共通 error response を追加。
- 実行コマンド:
  - `pnpm --filter @pufu-lens/web test`
  - `node --experimental-strip-types --check scripts/chat-eval.ts`
  - `pnpm --filter @pufu-lens/web typecheck`
  - `pnpm scripts:typecheck`
  - `pnpm format:check`
- 自動テスト結果: Chat unit test で source 付き回答、tool call、project 越境拒否、raw document fetch のサイズ上限、営業時間外 `db_outside_business_hours`、user + project 単位 rate limit を確認。2026-06-04 に `chat:eval` で通常回答、project 越境拒否、営業時間外応答を確認。
- 補助的な手動確認: `pnpm --filter @pufu-lens/web dev` でローカル server を起動し、`pnpm chat:eval --project step12-smoke --fixture fixtures/chat/private-chat-eval.json` と `PUFU_LENS_CHAT_ENFORCE_BUSINESS_HOURS=true PUFU_LENS_CHAT_NOW=2026-06-07T12:00:00+09:00` 起動時の `pnpm chat:eval --project step12-smoke --fixture fixtures/chat/private-chat-outside-business-hours-eval.json` を実行。
- DB 確認: `step12-smoke` project を作成し、system user を project member に追加した上で `pnpm ingest:run --project step12-smoke --source github --fixture --embedding-provider deterministic` を実行。`step12-smoke` は documents 2 件、chunks 4 件、`sample-b` は documents 0 件で project 越境拒否の eval を確認。
- Storage 確認: `/tmp/pufu-lens-step12-storage/step12-smoke` に raw / parsed fixture を保存し、ingestion workflow が collect / parse / resolve / chunk / graph まで完了することを確認。
- ログ / secret 確認: Gemini API key は API route 内の server-side provider だけに渡し、Chat UI へ props として渡さない構成を typecheck / 実装確認で確認。
- 未確認リスク: 実 Gemini API 応答、Graph AGE query の本格 Cypher 利用、raw / parsed 本文取得、ブラウザ e2e は未実施。ローカル既存 `sample-a` は過去 smoke の parsed URI が実ファイルと不整合だったため、既存データを消さずに `step12-smoke` で検証した。
- 次 step に進む判断: 最小 Chat API / UI、自動テスト、実 DB に対する `chat:eval` は確認済み。実 Gemini API smoke とブラウザ e2e 後に Step 12 完了判定する。
