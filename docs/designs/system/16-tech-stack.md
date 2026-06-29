# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 技術スタック サマリー

| カテゴリ        | 採用技術                                                       |
| --------------- | -------------------------------------------------------------- |
| Agent Framework | Mastra                                                         |
| LLM             | Gemini API（Google AI / Vertex AI、初期構築の既定 provider）   |
| Frontend        | Next.js + AI SDK + Auth.js                                     |
| Database        | PostgreSQL 18 + pgvector + PGroonga + Apache AGE + pgcrypto    |
| Object Storage  | ローカル: Docker Volume / クラウド: Google Cloud Storage       |
| MCP             | Google MCP、GitHub MCP                                         |
| Web Hosting     | Firebase App Hosting（Next.js）                                |
| Compute         | Cloud Run、Cloud Run Jobs                                      |
| Database Host   | GCE VM（Container-Optimized OS）                               |
| Scheduler       | Cloud Scheduler                                                |
| Secrets         | Secret Manager                                                 |
| Auth            | Auth.js、OAuth、GitHub App、Service Account、Workload Identity |
| Monorepo        | pnpm workspaces / Turborepo                                    |

---

補足：

- PostgreSQL は Apache AGE / pgvector / PGroonga を同梱したカスタム Docker イメージで運用する。
- Cloud SQL は Apache AGE を前提にできないため、本番 DB の第一候補にはしない。
- AGE を使う DB 接続では、接続確立時に `LOAD 'age'` と `SET search_path = ag_catalog, "$user", public` を実行する。
- Gemini の生成モデルと embedding モデルは `GEMINI_CHAT_MODEL` / `GEMINI_EMBEDDING_MODEL` で固定し、モデル更新時は再現性と embedding 再生成要否を確認する。
- `gemini-embedding-001` は 2026-07-14 に提供終了予定のため、embedding model の既定値は推奨後継の `gemini-embedding-2` とする。
- `gemini-embedding-2` は出力次元を指定できるため、DB の `vector(1536)` に合わせて embedding 呼び出し時は `GEMINI_EMBEDDING_DIMENSIONS=1536` 相当の設定を必須にする。次元を変更する場合は `document_chunks.embedding` / `report_chunks.embedding` の migration と全 embedding の再生成を同じ step で扱う。
