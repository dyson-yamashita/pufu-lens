# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 運用コスト見積もり（月額）

### 1. GCE VM + Firebase App Hosting + Cloud Run 構成（推奨）

| コンポーネント                       | スペック                                                                   | 月額        |
| ------------------------------------ | -------------------------------------------------------------------------- | ----------- |
| Firebase App Hosting（Next.js）      | Cloud Run / Cloud CDN / Cloud Build / Artifact Registry を含む利用量ベース | $0〜20      |
| Cloud Run（Mastra Server）           | リクエストベース                                                           | $5〜30      |
| Cloud Run Jobs（Ingestion / Report） | 日次実行                                                                   | $1〜5       |
| GCE VM（e2-custom-small-3072）       | 2 vCPU / 3 GiB、常時稼働                                                   | $14〜24     |
| Persistent Disk Balanced 20GB        | 現行 VM の再構築可能な boot disk                                           | $2          |
| Persistent Disk SSD 50GB             | $0.17/GB                                                                   | $9          |
| GCS（元データ + parsed + レポート）  | 5GB 程度                                                                   | $0.15       |
| Direct VPC egress                    | 専用 subnet を使用。Connector の常時 instance 課金なし                     | 利用量依存  |
| Secret Manager                       | 数バージョン                                                               | $1          |
| Cloud Scheduler                      | 数ジョブ                                                                   | 無料枠内    |
| **従量ネットワーク・LLM除外小計**    |                                                                            | **$32〜92** |

GCE VM の概算は Taiwan リージョンの `e2-custom-small-3072` オンデマンド単価（[Compute Engine general purpose pricing](https://cloud.google.com/products/compute/pricing/general-purpose)）を基準に、月間の常時稼働と価格変動を考慮した幅を持たせる。2026-08-03 の固定費削減では Serverless VPC Access Connector 廃止、VM 縮小、停止済み旧 VM の 20 GB boot disk 廃止により、Direct VPC egress のデータ転送、LLM、Cloud Run などの従量費を除く固定費を約 $27 / 月削減する見込みである。現行 VM の 20 GB boot disk は変更前後とも必要なため、削減額には含めない。実績は Billing Report の 7 日間比較で確認する。

LLM / embedding コストは利用量連動のため、上表には固定費として含めない。通常のデータ収集・parse は source 別の決定的な scanner / parser / validator で処理し、Agent に全候補を都度判定させない。これにより、取り込み件数に比例してチャットモデルのトークンを消費する経路を避ける。

LLM を使う主な場面は、チャット応答、レポート生成、embedding 生成、未知形式・低 confidence・parser 修正などの例外対応に限定する。新規レポート生成では、レポート本文生成に加えて、同じプロジェクト資料の要約・レポート本文を入力とする専用 Mastra Agent のプ譜生成を 1 回実行する。既存レポートの表示時には再生成しないため、表示アクセスによる追加の LLM コストは発生しない。ローカルテストと CI では deterministic embedding provider を使い、Gemini / OpenAI embedding は dry-run または小さな実データ検証に限定してコストと外部依存を抑える。

チャット合成へ渡す source は重複除外後に最大 10 件とする。各 source の snippet は取得時の上限内に保ち、source 数の増加による入力 token と応答コストは利用量メトリクスで監視する。

GCE VM 上の PostgreSQL は常時稼働させる。DB 依存機能（チャット、管理 UI、取り込み状況、データソース管理、手動 ingestion、レポート閲覧）と定期 `curate-workflow` / `ingest-workflow` / `generate-report` / `source-sync-dispatcher` / `report-schedule-dispatcher` job は時刻による利用制限や VM 起動制御を前提にしない。

public report / public chat は private report / private chat と同じ処理を使い、DB 上の `projects.visibility` と `reports.is_public` でアクセス権を確認する。時刻による利用制限は設けず、公開用 artifact は互換・検証用途として保存できるが、表示可否の正は DB metadata とする。

### 2. コスト最適化施策

- GCE VM の継続利用割引とリソース使用率の定期確認
- Direct VPC 専用 subnet の IP 使用率を監視し、Cloud Run の最大 instance 数、rollout 時の旧新 revision、全 9 Job の同時 task 数、IP 解放待ちを含む余裕を維持する
- App Hosting / Cloud Run の最小インスタンス数を 0 に
- App Hosting の cached bandwidth を活かせるよう、静的アセットと公開レポートの cache header を適切に設定する
- GCS のライフサイクル管理（`raw/web/` を Nearline、180 日超を Coldline）
- 収集・parse 正常系は LLM ではなく source 別 parser / validator で処理する
- 失敗 raw を fixture 化し、parser 修正後に failed queue を retry する
- テスト時は deterministic embedding provider を既定にし、外部 embedding provider は明示指定時だけ使う

---
