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
- Chat生成モデルはMastra model routerの `PUFU_LENS_CHAT_MODEL` で選び、Google、OpenAI、Anthropicなどのprovider-qualified modelを指定する。
- Embeddingは `PUFU_LENS_EMBEDDING_PROVIDER` / `PUFU_LENS_EMBEDDING_MODEL` / `PUFU_LENS_EMBEDDING_DIMENSIONS` をingestionとquery検索で共有する。実装済みproviderはGeminiとOpenAI、`deterministic` はテスト専用とする。
- DBの `vector(1536)` に合わせてembedding出力を1536次元に固定する。providerまたはmodelを変更する場合は、既存vectorと同じ空間として比較せず、全embeddingの再生成要否を確認する。
