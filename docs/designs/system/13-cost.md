# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 運用コスト見積もり（月額）

### 1. GCE VM + Firebase App Hosting + Cloud Run 構成（推奨）

| コンポーネント | スペック | 月額 |
|---|---|---|
| Firebase App Hosting（Next.js） | Cloud Run / Cloud CDN / Cloud Build / Artifact Registry を含む利用量ベース | $0〜20 |
| Cloud Run（Mastra Server） | リクエストベース | $5〜30 |
| Cloud Run Jobs（Ingestion / Report） | 日次実行 | $1〜5 |
| GCE VM（e2-medium） | 業務時間のみ | $13〜33 |
| Persistent Disk SSD 50GB | $0.17/GB | $9 |
| GCS（元データ + parsed + レポート） | 5GB 程度 | $0.15 |
| VPC コネクタ | $0.01/GB + $6 | $6〜 |
| Secret Manager | 数バージョン | $1 |
| Cloud Scheduler | 数ジョブ | 無料枠内 |
| **合計** | | **$35〜105** |

LLM / embedding コストは利用量連動のため、上表には固定費として含めない。通常のデータ収集・parse は source 別の決定的な scanner / parser / validator で処理し、Agent に全候補を都度判定させない。これにより、取り込み件数に比例してチャットモデルのトークンを消費する経路を避ける。

LLM を使う主な場面は、チャット応答、レポート生成、embedding 生成、未知形式・低 confidence・parser 修正などの例外対応に限定する。ローカルテストと CI では deterministic embedding provider を使い、Gemini embedding は dry-run または小さな実データ検証に限定してコストと外部依存を抑える。

GCE VM 上の PostgreSQL はコスト最適化のため業務時間のみ起動する。業務時間外は DB 依存機能（チャット、管理 UI、取り込み状況、データソース管理、手動 ingestion、private レポート閲覧）は利用不可にし、UI では営業時間外メッセージを表示する。定期 `curate-workflow` / `ingest-workflow` / `generate-report` job も DB 依存のため、初期構築では DB 稼働時間内に実行する。夜間実行が必要になった場合は、VM 起動・job 実行・VM 停止を 1 つの運用単位として自動化する。

公開済みレポートの閲覧は DB 稼働確認に依存させず、Object Storage 上の report JSON と公開用 manifest / metadata を取得して表示する。そのため業務時間外でも、public report は閲覧できる。private report は project member 認可に DB が必要なため、業務時間外は利用不可にする。

### 2. コスト最適化施策

- GCE VM の業務時間外停止
- App Hosting / Cloud Run の最小インスタンス数を 0 に
- App Hosting の cached bandwidth を活かせるよう、静的アセットと公開レポートの cache header を適切に設定する
- GCS のライフサイクル管理（`raw/web/` を Nearline、180 日超を Coldline）
- 収集・parse 正常系は LLM ではなく source 別 parser / validator で処理する
- 失敗 raw を fixture 化し、parser 修正後に failed queue を retry する
- テスト時は deterministic embedding provider を既定にし、Gemini embedding は明示指定時だけ使う

---
