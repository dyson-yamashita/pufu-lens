# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 運用コスト見積もり（月額）

### 1. GCE VM + Firebase App Hosting + Cloud Run 構成（推奨）

| コンポーネント                       | スペック                                                                   | 月額         |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------ |
| Firebase App Hosting（Next.js）      | Cloud Run / Cloud CDN / Cloud Build / Artifact Registry を含む利用量ベース | $0〜20       |
| Cloud Run（Mastra Server）           | リクエストベース                                                           | $5〜30       |
| Cloud Run Jobs（Ingestion / Report） | 日次実行                                                                   | $1〜5        |
| GCE VM（e2-medium）                  | 常時稼働                                                                   | $25〜35      |
| Persistent Disk SSD 50GB             | $0.17/GB                                                                   | $9           |
| GCS（元データ + parsed + レポート）  | 5GB 程度                                                                   | $0.15        |
| VPC コネクタ                         | $0.01/GB + $6                                                              | $6〜         |
| Secret Manager                       | 数バージョン                                                               | $1           |
| Cloud Scheduler                      | 数ジョブ                                                                   | 無料枠内     |
| **合計**                             |                                                                            | **$47〜107** |

GCE VM の概算は Tokyo リージョンの `e2-medium` オンデマンド単価（[Compute Engine general purpose pricing](https://cloud.google.com/products/compute/pricing/general-purpose)）を基準に、月間の常時稼働と価格変動を考慮した幅を持たせる。

LLM / embedding コストは利用量連動のため、上表には固定費として含めない。通常のデータ収集・parse は source 別の決定的な scanner / parser / validator で処理し、Agent に全候補を都度判定させない。これにより、取り込み件数に比例してチャットモデルのトークンを消費する経路を避ける。

LLM を使う主な場面は、チャット応答、レポート生成、embedding 生成、未知形式・低 confidence・parser 修正などの例外対応に限定する。ローカルテストと CI では deterministic embedding provider を使い、Gemini / OpenAI embedding は dry-run または小さな実データ検証に限定してコストと外部依存を抑える。

GCE VM 上の PostgreSQL は常時稼働させる。DB 依存機能（チャット、管理 UI、取り込み状況、データソース管理、手動 ingestion、レポート閲覧）と定期 `curate-workflow` / `ingest-workflow` / `generate-report` / `source-sync-dispatcher` / `report-schedule-dispatcher` job は時刻による利用制限や VM 起動制御を前提にしない。

public report / public chat は private report / private chat と同じ処理を使い、DB 上の `projects.visibility` と `reports.is_public` でアクセス権を確認する。時刻による利用制限は設けず、公開用 artifact は互換・検証用途として保存できるが、表示可否の正は DB metadata とする。

### 2. コスト最適化施策

- GCE VM の継続利用割引とリソース使用率の定期確認
- App Hosting / Cloud Run の最小インスタンス数を 0 に
- App Hosting の cached bandwidth を活かせるよう、静的アセットと公開レポートの cache header を適切に設定する
- GCS のライフサイクル管理（`raw/web/` を Nearline、180 日超を Coldline）
- 収集・parse 正常系は LLM ではなく source 別 parser / validator で処理する
- 失敗 raw を fixture 化し、parser 修正後に failed queue を retry する
- テスト時は deterministic embedding provider を既定にし、外部 embedding provider は明示指定時だけ使う

---
