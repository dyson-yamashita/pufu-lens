# Synthetic Monitor 運用手順

外部 Synthetic Monitor から Pufu Lens の ingestion / schedule / report pipeline を **読み取り専用** で観測するための手順です。monitor はデータを変更せず、stage ごとの `ok` / `pending` / `failed` / `not_found` だけを返します。

関連ドキュメント:

- API 一覧: [API デザイン](../designs/system/05-api-design.md)
- 認証境界: [セキュリティ](../designs/system/12-security.md)
- 契約: [synthetic-monitor-v1.json](../contracts/synthetic-monitor-v1.json)
- deploy 時の環境変数: [Deploy Checklist](deploy-checklist.md)

## エンドポイント

| 項目          | 値                                                                 |
| ------------- | ------------------------------------------------------------------ |
| Method        | `POST`                                                             |
| Path          | `/internal/monitoring/v1/observations`                             |
| Host          | Mastra Server の内部 URL（Cloud Run `--no-allow-unauthenticated`） |
| Content-Type  | `application/json`                                                 |
| Authorization | `Bearer <Google ID token>`                                         |

## 認証と project scope

1. monitor 専用 Google service account が Google ID token を取得する。
2. token の `aud` は `SYNTHETIC_MONITOR_OIDC_AUDIENCE`（Mastra service URL）と一致すること。
3. token の `email` は `SYNTHETIC_MONITOR_SERVICE_ACCOUNTS` に含まれる `*.iam.gserviceaccount.com` であること。
4. request の `projectSlug` は `SYNTHETIC_MONITOR_PROJECT_SLUGS` に含まれる dedicated project だけ許可される。allowlist 外は `403 monitor project scope denied`。

認証は request body parse より先に実行されます。未認証 caller へ validation oracle を開きません。

## Limits

| 制限                  | 値                           |
| --------------------- | ---------------------------- |
| sources 数            | 最大 20                      |
| request body          | 最大 64 KiB                  |
| request timeout       | 30 秒                        |
| SQL statement timeout | 5 秒 / read-only transaction |
| report artifact read  | 最大 2 MiB                   |
| expectedRelations     | 最大 10 件 / source          |
| minCount 上限         | 1,000,000                    |

## Request 例

Gmail:

```json
{
  "projectSlug": "sample-a",
  "sources": [
    {
      "kind": "gmail",
      "threadId": "thread-example",
      "expectedMessageId": "message-example",
      "expectedRelations": [{ "type": "SENT", "minCount": 1 }]
    }
  ]
}
```

Drive:

```json
{
  "projectSlug": "sample-a",
  "sources": [
    {
      "kind": "drive",
      "fileId": "file-example",
      "expectedRevisionId": "rev-example"
    }
  ]
}
```

GitHub:

```json
{
  "projectSlug": "sample-a",
  "sources": [
    {
      "kind": "github",
      "repository": "org/repo",
      "resourceType": "issue",
      "number": 42,
      "expectedVersion": "2026-07-01T00:00:00.000Z:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
  ]
}
```

Web:

```json
{
  "projectSlug": "sample-a",
  "sources": [
    {
      "kind": "web",
      "canonicalUrl": "https://example.com/docs",
      "expectedContentHash": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
  ]
}
```

Optional report 観測:

```json
{
  "projectSlug": "sample-a",
  "sources": [
    {
      "kind": "gmail",
      "threadId": "thread-example",
      "expectedMessageId": "message-example"
    }
  ],
  "report": {
    "frequency": "weekly",
    "periodStart": "2026-07-07",
    "periodEnd": "2026-07-13"
  }
}
```

任意 query 文字列、storage URI、provider path、SQL、Cypher は request に含めません。

## Response 例

```json
{
  "contractVersion": "synthetic-monitor-v1",
  "projectSlug": "sample-a",
  "observations": [
    {
      "index": 0,
      "kind": "gmail",
      "raw": { "status": "ok" },
      "currentDocument": { "status": "ok" },
      "chunks": { "status": "ok", "embeddingComplete": true },
      "graph": {
        "status": "ok",
        "documentNodePresent": true,
        "relations": {
          "AUTHORED": 0,
          "COMMENTED_ON": 0,
          "MENTIONS": 0,
          "OWNS": 0,
          "REPLY_TO": 0,
          "RELATED_TO": 0,
          "REVIEWED": 0,
          "SAME_AS": 0,
          "SENT": 1
        }
      },
      "schedule": { "status": "ok", "enabled": true, "retryCount": 0, "nextRunDue": false }
    }
  ],
  "report": {
    "schedule": { "status": "ok", "frequency": "weekly", "nextRunDue": false },
    "periodRun": { "status": "ok", "runStatus": "succeeded" },
    "artifact": { "status": "ok", "schemaVersion": "v1" }
  }
}
```

response には thread ID、message ID、storage URI、report 本文、OAuth token、email、snippet、provider payload を含めません。

## Stage 判定

### Source pipeline

| Stage           | `ok`                                         | `pending`                                      | `failed`              | `not_found`     |
| --------------- | -------------------------------------------- | ---------------------------------------------- | --------------------- | --------------- |
| raw             | 指定 version が `indexed`                    | ingest 中                                      | ingest 失敗           | raw なし        |
| currentDocument | latest raw と document が一致                | latest version 不一致                          | -                     | document なし   |
| chunks          | embedding 完了                               | chunk 0 件 / embedding 未完了                  | repository error 等   | document 未到達 |
| graph           | node 存在 + expectedRelations 充足           | -                                              | relation 不足 / error | node 未到達     |
| schedule        | enabled かつ retry 0、lease なし、due でない | active lease あり、または `next_run_at <= now` | retryCount > 0        | schedule なし   |

Web source は schedule stage を返しません。

### Report

| Stage     | 主な意味                                                  |
| --------- | --------------------------------------------------------- |
| schedule  | project report schedule の frequency / `next_run_at` due  |
| periodRun | `report_schedule_period_runs.status`                      |
| artifact  | Object Storage artifact の schema / report / project 整合 |

`periodRun.status` mapping:

- `succeeded` → `ok`
- `pending` / `running` / `retry_wait` → `pending`
- `skipped` / `retry_exhausted` → `failed`
- row なし → `not_found`

## 部分成功と再試行

- source ごとに独立して観測します。1 source の repository / AGE error はその source だけ `failed` にし、他 source の結果は維持します。
- optional `report` の error も source observations を失いません。report の各 stage だけ `failed` になります。
- monitor 側の再試行は通常 30 秒 timeout 内で HTTP を再送します。`pending` は一時状態、`failed` は調査対象です。

## HTTP 利用手順

1. monitor service account で Google ID token を取得する（audience は Mastra URL）。
2. dedicated project slug を含む JSON body を組み立てる。
3. Mastra 内部 URL へ POST する。

```bash
curl -sS -X POST "https://mastra.example.internal/internal/monitoring/v1/observations" \
  -H "Authorization: Bearer ${MONITOR_ID_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"projectSlug":"sample-a","sources":[{"kind":"gmail","threadId":"thread-example","expectedMessageId":"message-example"}]}'
```

`${MONITOR_ID_TOKEN}` には実 token をログやドキュメントへ保存しません。401 / 403 / 400 / 503 の error body も token や provider payload を含みません。

## ローカル確認

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  pnpm --filter @pufu-lens/web test:db
```

Synthetic Monitor 専用 unit test:

```bash
pnpm --filter @pufu-lens/web exec node --experimental-strip-types --test src/synthetic-monitor*.test.ts
pnpm --filter @pufu-lens/mastra test
```
