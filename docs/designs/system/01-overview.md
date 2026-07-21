# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 目次

- [概要](01-overview.md)
- [システムアーキテクチャ](02-architecture.md)
- [データモデル](03-data-model.md)
- [ストレージ抽象化](04-storage.md)
- [API デザイン](05-api-design.md)
- [Ingestion ワークフロー](06-ingestion-workflow.md)
- [チャット機能](07-chat.md)
- [レポート生成](08-reporting.md)
- [定期実行（Cloud Scheduler）](09-scheduler.md)
- [ディレクトリ構成](10-directory-structure.md)
- [デプロイメント](11-deployment.md)
- [ネットワーク・セキュリティ](12-security.md)
- [運用コスト見積もり（月額）](13-cost.md)
- [フェーズ別ロードマップ](14-roadmap.md)
- [将来の拡張](15-future.md)
- [技術スタック サマリー](16-tech-stack.md)
- [参考リンク](17-references.md)

## 概要

プロジェクトに関連するデータソース（Gmail / Google Drive / GitHub / Web ページ）を横断的に取り込み、ナレッジグラフとして PostgreSQL に格納する。チャット UI から自然言語で問い合わせ・分析を行い、定期的にプロジェクトレポート（JSON）を自動生成する。Chat生成モデルはMastra model router経由でGoogle、OpenAI、Anthropicなどを選択でき、EmbeddingはGeminiまたはOpenAIを選択できる。回答生成とEmbeddingのproviderは独立して設定し、document ingestionとquery検索だけは同じembedding spaceを共有する。Web にはログイン機能を設け、ログイン済み管理者が Google / GitHub 連携とデータソース設定を管理する。

複数のプロジェクトを並行して扱えるよう、データソース設定・取り込み済みデータ・ナレッジグラフ・レポートは **プロジェクト単位で論理的に分離** される。元データはオブジェクトストレージに原本保存し、そこから parse → DB / グラフ DB に展開する。Chat Agent は DB / グラフ DB に加え、ストレージ上の元データも参照できる。

### 主要機能

- マルチプロジェクト管理（プロジェクト単位でデータソース・DB スコープ・ストレージ・レポートを分離）
- Gmail / Drive / GitHub / Web からのデータ取り込み（Ingestion）と元データのオブジェクトストレージ保存
- 管理者ログイン、Google / GitHub 連携、データソース設定管理
- Collection Pipeline によるデータソース単位の定期監視・原本収集・収集候補の決定的な skip / dedup 判定
- Exception Agent による未知形式、低 confidence、parser 修正の補助
- ナレッジグラフ（Apache AGE）+ ベクトル検索（pgvector）+ 原本ストレージによる三層知識基盤
- provider選択可能なMastra Agentによるチャット対応（グラフ / ベクトル / 原本ストレージ横断）
- 定期実行による JSON レポート自動生成・API 配信

---
