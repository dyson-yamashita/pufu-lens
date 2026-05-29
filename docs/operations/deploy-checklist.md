# Deploy Checklist

このファイルは、staging / production の初回手動作業と検証結果を
記録するための運用チェックリストである。secret の実値、OAuth token、
API key、DB password は記録しない。

## 環境

- 対象環境:
- GCP project:
- region:
- billing account:
- 実施日:
- 対象 commit:

## 初回手動作業

- [ ] 必要な GCP API を有効化した。
- [ ] Artifact Registry repository を作成した。
- [ ] GCS bucket を作成した。
- [ ] PostgreSQL VM / VPC / firewall / connector を作成した。
- [ ] Cloud Run / Cloud Run Jobs / Firebase App Hosting の service account を確認した。
- [ ] Secret Manager に runtime secret を作成した。
- [ ] Google AI API key または Vertex AI 認証方式を設定した。
- [ ] Google OAuth / GitHub App の callback URL を設定した。
- [ ] Cloud Scheduler の OIDC service account を作成した。

## Secret 記録

- `DATABASE_URL`: PostgreSQL 接続。実値は記録しない。
- `AUTH_SECRET`: Auth.js。実値は記録しない。
- `GEMINI_API_KEY`: Google AI API key 利用時のみ。実値は記録しない。
- `GEMINI_CHAT_MODEL`: Chat / report model。モデル名のみ記録可。
- `GEMINI_EMBEDDING_MODEL`: embedding model。モデル名のみ記録可。
- `GEMINI_EMBEDDING_DIMENSIONS`: embedding 次元。既定は `1536`。

## IAM 記録

- principal:
- role:
- scope:
- 理由:

## 検証結果

```bash
pnpm deploy:dry-run
pnpm infra:check --env staging
pnpm deploy:smoke --env staging
```

- `deploy:dry-run`:
- `infra:check`:
- `deploy:smoke`:
- Cloud Run Job 単発実行:
- Cloud Scheduler OIDC 実行:
- GCS prefix 作成:
- Secret Manager 参照:
- PostgreSQL VPC 内接続:
- public report manifest 解決:
- secret / token / PII のログ漏れ確認:

## 未完了項目

- [ ] なし
