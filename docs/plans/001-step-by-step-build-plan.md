# Pufu Lens Step by Step 構築計画

この plan は Step ごとのファイルに分割した。全体像と Step の進捗は [overview](001-step-by-step-build-plan/overview.md) を参照する。

## 入口

- [overview.md](001-step-by-step-build-plan/overview.md)

## Step 別 plan

- Step 0: [開発基盤と品質ゲート](001-step-by-step-build-plan/step-00-foundation.md)
- Step 1: [ローカル DB / Storage の最小起動](001-step-by-step-build-plan/step-01-local-db-storage.md)
- Step 2: [Project 作成とテナント分離の確認](001-step-by-step-build-plan/step-02-project-tenancy.md)
- Step 3: [Ingestion Fixture とデータ契約](001-step-by-step-build-plan/step-03-ingestion-fixtures.md)
- Step 4: [Collection Pipeline のローカル収集パイプライン](001-step-by-step-build-plan/step-04-local-collection-pipeline.md)
- Step 5: [Raw Parse と parsed JSON 保存](001-step-by-step-build-plan/step-05-raw-parse.md)
- Step 6: [Actor 名寄せと引用チェーン](001-step-by-step-build-plan/step-06-actor-resolution.md)
- Step 7: [Document / Chunk / Embedding の決定的検証](001-step-by-step-build-plan/step-07-chunk-embedding.md)
- Step 8: [Graph / Relation 構築](001-step-by-step-build-plan/step-08-graph-relations.md)
- Step 9: [Ingestion Workflow の通し実行](001-step-by-step-build-plan/step-09-ingestion-workflow.md)
- Step 10: [実データソース接続を 1 種類ずつ追加](001-step-by-step-build-plan/step-10-real-data-sources.md)
- Step 10a: [scripts 実行形式の `.ts` 統一](001-step-by-step-build-plan/step-10a-scripts-ts-execution.md)
- Step 10b: [scripts strict typecheck 対応](001-step-by-step-build-plan/step-10b-scripts-strict-typecheck.md)
- Step 11: [管理 UI と取り込み状況の可視化](001-step-by-step-build-plan/step-11-admin-ui.md)
- Step 12: [Chat Agent の最小確認](001-step-by-step-build-plan/step-12-chat-agent.md)
- Step 13a: [Private Report 生成と閲覧](001-step-by-step-build-plan/step-13a-private-report.md)
- Step 13b: [Public Report 公開 artifact と配信](001-step-by-step-build-plan/step-13b-public-report-artifact.md)
- Step 13c: [Public Chat 限定 context と安全確認](001-step-by-step-build-plan/step-13c-public-chat-context.md)
- Step 14: [Scheduler / Cloud Run Job / Deploy 検証](001-step-by-step-build-plan/step-14-scheduler-deploy.md)
