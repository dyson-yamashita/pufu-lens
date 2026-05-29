# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## フェーズ別ロードマップ

### Phase 1: 基盤構築（2 週間）

- GCE VM 起動と PostgreSQL（pgvector + AGE）セットアップ
- カスタム Docker イメージのビルドと Artifact Registry 登録
- スキーマ初期化（`projects`、`raw_documents`、`documents`、`actors` まで）
- `ObjectStorage` 抽象とローカル FS / GCS 実装
- ログイン、管理者判定、Google / GitHub 連携の最小実装
- 単一プロジェクトでの GitHub Ingestion を実装し、`raw_documents → documents → AGE` の流れを動作確認

### Phase 2: マルチソース対応（2 週間）

- データソース管理 UI（Gmail / Drive / GitHub / Web）の実装
- Gmail / Drive Ingestion 追加（メール引用分解、Actor 名寄せ含む）
- Web ページ取り込み実装
- Collection Pipeline の source contract / skip / dedup 判定精度調整
- Exception Agent による失敗 raw の parser 修正補助
- Chat Agent + `raw-document-fetch` / `parsed-doc-fetch` ツール
- ナレッジグラフの拡張・エンティティ抽出精度調整

### Phase 3: マルチプロジェクト & フロントエンド（1.5 週間）

- プロジェクト作成 / メンバー管理 UI
- `/projects/[slug]/...` 配下のチャット・レポートページ
- レポート JSON API 配信
- Firebase App Hosting デプロイ・VPC access・GCS バケット設定

### Phase 4: 自動化・運用（1 週間）

- レポート自動生成ワークフロー（JSON 出力）
- Cloud Scheduler 設定（プロジェクトごと）
- Slack 通知
- Secret Manager 統合・本番運用開始

---
