# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 技術スタック サマリー

| カテゴリ        | 採用技術                                                       |
| --------------- | -------------------------------------------------------------- |
| Agent Framework | Mastra                                                         |
| LLM             | Gemini API（Google AI / Vertex AI、初期構築の既定 provider）   |
| Frontend        | Next.js + AI SDK + Auth.js                                     |
| Federation      | Fedify 2.3.4（ActivityPub、Actor・Follow・report delivery）    |
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
- Fedify 関連 package は `2.3.4` へ完全固定し、Fedify 自体は Node.js `>=22` を要求する。repository root の engine は root scripts の `node --experimental-strip-types` 利用に合わせて `>=22.6.0` とする。Web は Next.js 16 `proxy.ts` convention と `manuallyStartQueue: true` を使い、Follow / Accept / Undo と report Create / Announce の受信・配送処理を PostgreSQL-backed one-shot process に分離する。production ActivityPub endpoint は `ACTIVITYPUB_ENABLED=1` の明示設定時だけ有効で、queue処理は専用 Cloud Run Jobに限定する。新規Follow / Accept / Undo inbox rowのcommit後はWeb runtimeが同Jobを即時起動し、5分ごとのCloud Schedulerをフォールバックとするが、Web process自身はconsumerにならない。外部reportはproject-scopedな参照表示に閉じ、ingestion / chat / graph / report生成へ流さない。
- Fedify更新時は `packages/activitypub/package.json`、`apps/web/package.json`、`pnpm-workspace.yaml` のoverride、`pnpm-lock.yaml` の直接・転移依存を同一patchへ揃え、Webの固定Next.js versionとのpeer dependencyも確認する。公式changelog、GitHub Security Advisories、npm advisory、Node.js要件を確認し、local、Cloud Build CI（Node.js 24）、deploy / Job imageとFirebase App Hosting（Node.js 22系）がroot engine `>=22.6.0` と更新版の要件を満たすことを `node --version` で検証する。`pnpm audit --prod`に加えてprotocol / DB / hermetic E2E、HTTP Signature、SSRF / redirect / domain block、queue serializer、本文なしlogのcontractを検証する。手順と停止条件は `docs/operations/activitypub-federation.md` を正とする。
- Cloud SQL は Apache AGE を前提にできないため、本番 DB の第一候補にはしない。
- AGE を使う DB 接続では、接続確立時に `LOAD 'age'` と `SET search_path = ag_catalog, "$user", public` を実行する。
- Chat回答とプ譜の生成モデルはMastra model routerの `PUFU_LENS_CHAT_MODEL` で選び、Google、OpenAI、Anthropicなどのprovider-qualified modelを指定する。
- Embeddingは `PUFU_LENS_EMBEDDING_PROVIDER` / `PUFU_LENS_EMBEDDING_MODEL` / `PUFU_LENS_EMBEDDING_DIMENSIONS` をingestionとquery検索で共有する。実装済みproviderはGeminiとOpenAI、`deterministic` はローカル・テスト・development用途とし、`NODE_ENV=production` では共有runtimeで選択を拒否する。
- DBの `vector(1536)` に合わせてembedding出力を1536次元に固定する。providerまたはmodelを変更する場合は、既存vectorと同じ空間として比較せず、全embeddingの再生成要否を確認する。
