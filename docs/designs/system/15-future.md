# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 将来の拡張

### 1. GKE への移行検討トリガー

以下のいずれかが該当した場合、GCE VM から GKE Autopilot + CloudNativePG への移行を検討する：

- 複数の Agent / サービスを統一管理したい
- PostgreSQL の HA（自動フェイルオーバー）が必要
- インフラを完全に IaC で管理したい
- チーム拡大によりオペレーション標準化が必要

### 2. 機能拡張候補

- プロジェクト単位での **物理 DB 分離**（`projects.database_url` を持たせ、Mastra ツールがプロジェクトごとに接続切り替え）
- Slack / Teams 統合（Bot から直接質問）
- 過去レポートの差分分析（pgvector で類似レポート検索）
- ダッシュボード機能（メトリクス可視化）
- Actor の手動マージ / 分割 UI（誤名寄せ対応）
- メール添付 / Drive バイナリの OCR・要約
- `data_sources.config` の拡張：Gmail query、Drive MIME / ファイル名フィルタ、GitHub include / labels / states、Web の RSS / Sitemap / クロール深度・許可/除外パス（初期実装は最小キーのみ）

### 3. 検討中の代替構成

| 構成 | メリット | デメリット |
|---|---|---|
| Cloud SQL（AGE 無し） | 完全マネージド | グラフクエリ不可 |
| GKE Autopilot | HA・スケーラブル | 運用コスト増 |
| EDB BigAnimal on GCP | AGE 対応マネージド | コスト高 |
| Azure HorizonDB | AGE 対応マネージド | クロスクラウド |
---
