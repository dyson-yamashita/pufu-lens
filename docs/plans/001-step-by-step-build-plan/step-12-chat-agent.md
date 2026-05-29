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
