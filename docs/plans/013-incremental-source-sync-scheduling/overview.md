# Incremental Source Sync / Scheduling 計画

## 目的

GitHub / Drive / Gmail / Web の新規・更新データを差分取り込みし、raw の版履歴を保持しながら検索・チャットでは各論理データの最新版だけを参照できるようにする。

GitHub / Drive / Gmail には data source 作成時に日次スケジュールを設定し、DB 管理の dispatcher から collect と ingest を自動実行する。Web は自動スケジュールを作らず、手動実行時の本文差分取り込みだけを行う。

## 確定仕様

- raw は版ごとに保持し、document ID は論理データ単位で維持する。
- 最新版の取り込み時は現在の chunk を `document_chunk_history` へ退避し、検索・チャット対象を最新版へ置き換える。
- GitHub / Drive / Gmail の data source 作成時に、毎日 10:00 `Asia/Tokyo` の有効なスケジュールを transaction 内で作成する。
- 既存の有効な GitHub / Drive / Gmail data source にも同じ日次スケジュールを backfill する。
- data source 作成直後の即時 Collect & Ingest は維持する。
- Web はスケジュール対象外とするが、手動実行時に canonical URL と content hash で更新を検出する。
- 削除、Gmail label 除外、Drive folder 外移動などの削除差分は対象外とし、追加・更新だけを同期する。
- OAuth token、secret、raw 本文全文、外部 API response 本文を schedule status、log、error に残さない。

## 差分・版管理

`raw_documents` は既存の `source_id` に加えて、同じ実体の版を束ねる `logical_source_id` と、provider revision または content hash に基づく `source_version` を持つ。同一 project 内の `(source_type, logical_source_id, source_version)` を一意にする。既存の `(project_id, source_type, source_id)` 一意制約は、版を含む `source_id` に対する互換制約として維持し、GitHub / Web の新しい `source_id` は logical ID と source version から生成する。

既存の `lookupRawDocument(sourceId)` は raw 版の完全一致取得として残す。差分判定では新しい `lookupLatestRawDocument(logicalSourceId)` を使い、固定 logical ID を既存の単一行取得へ渡さない。

| source type | logical source ID              | source version                                  |
| ----------- | ------------------------------ | ----------------------------------------------- |
| Gmail       | thread ID                      | latest message ID                               |
| Drive       | file ID                        | head revision ID、version、または checksum      |
| GitHub      | repository + issue / PR number | provider `updated_at` と取得内容の content hash |
| Web         | normalized configured URL      | response body の content hash                   |

`documents` は project、doc type、logical source ID を一意にし、document ID を維持したまま最新版 raw を指す。旧 raw は削除しない。

`data_sources` は source type 別の同期カーソルと最終成功日時を保持する。カーソルは候補列挙と対象候補の保存・queue 投入がすべて成功した場合だけ進める。API 失敗、候補処理失敗、limit 到達など部分実行では進めず、次回実行で overlap を含めて再走査する。provider cursor が無効な場合は最終成功日時からの走査へ fallback し、重複は版一意制約と content hash で除外する。

## ソース別の差分取り込み

- Gmail は新着 message を含む thread を取得し、latest message ID が変わった thread だけ新しい raw 版として保存する。
- Drive は最終成功以降に更新された対象 file を取得し、revision/version が未取り込みの場合だけ本文を保存する。
- GitHub は `updated_at` 順に issue / PR を走査し、comments、reviews、diff を含む取得内容の hash が変わった場合だけ新しい raw 版を保存する。
- Web は normalized configured URL を安定した logical ID として手動実行ごとに fetch し、content hash が異なる場合だけ新しい raw 版を保存する。canonical URL は alias / canonical URI として保存し、欠落時は最終 URL、取得失敗時は configured URL を使う。redirect や canonical URL の変更だけでは logical ID を変更せず、別 configured URL との自動統合は行わない。
- content hash が同じ場合は raw / queue を増やさず、`raw_document_data_sources.last_seen_at` を更新する。
- CLI / Cloud Run Job の `dataSourceId` 指定を repository の検索条件まで伝播し、指定外 data source を処理しない。

## スケジュール

`data_source_schedules` は data source ごとの実行時刻、timezone、有効状態、次回実行、lease、前回成功・失敗、再試行回数、マスク済み error を保持する。日次の wall-clock time と timezone は別カラムで保持し、`next_run_at`、lease、実行履歴は `TIMESTAMPTZ` の UTC instant として保存する。dispatcher の due 判定は UTC の `now()` との比較だけで行う。data source 削除時は cascade する。

管理 UI では project admin が schedule の ON / OFF、日次実行時刻、次回実行、前回結果を確認・更新できる。timezone は初期実装では `Asia/Tokyo` 固定とする。

dispatcher は 5 分ごとに起動し、`FOR UPDATE SKIP LOCKED` と期限付き lease で due schedule を排他的に取得する。collect と対象 `dataSourceId` の ingest を直列実行し、処理中は worker token を照合して heartbeat で lease を延長する。lease 期間と最大延長時間は workflow の最大実行時間より長くし、heartbeat が停止した場合だけ別 worker が回収できるようにする。失敗時は 15 分、1 時間、6 時間の順に再試行した後、通常の日次周期へ戻す。

Cloud Scheduler は OIDC 保護された Mastra Server の内部 endpoint を呼び、そこから dispatcher 用 Cloud Run Job を起動する。source ごとの Cloud Scheduler resource は作成しない。

### ローカル実行

ローカル環境では Cloud Scheduler、OIDC、Mastra Server、Cloud Run Jobs API を経由せず、本番と同じ dispatcher 実装を one-shot CLI から直接起動する。

```bash
pnpm schedule:dispatch --once
```

1 回の実行で DB 上の due schedule を lease 付きで取得し、対象 data source の collect と ingest を行って終了する。due schedule が無い場合は成功として終了し、未来の schedule や disabled schedule は実行しない。本番とローカルで due 判定、lease、heartbeat、retry、実行結果更新の実装を分岐させない。

ローカルで継続的に動かす場合は CLI 内に常駐 loop を持たせず、開発者の `cron` / `launchd` などから 5 分ごとに one-shot CLI を呼ぶ。多重起動時の排他は DB lease で保証する。ローカルの自動起動は既定で有効化せず、通常の `pnpm dev` や `docker compose up` が意図せず外部 API を収集しないようにする。

実行にはローカル PostgreSQL、ローカル用 Object Storage 設定、対象 data source の connection と secret 復号設定が必要である。Google token refresh や GitHub App token 発行が必要な source では、既存 collect CLI と同じ provider credentials のローカル用設定を使用する。本番 DB、Object Storage、credentials へローカル dispatcher から直接接続してはならない。credential 値は引数、標準出力、標準エラー出力、アプリケーションログ、schedule error に含めない。

## Step 構成

| Step | status      | 内容                                                                                       | 完了条件                                                                                         |
| ---- | ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1    | `completed` | logical ID、版 ID、同期カーソルの DB model と migration を追加する。Issue #512 / PR #513。 | fresh / 既存 DB の migration、runtime guard、repository contract、schema drift test が通る。     |
| 2    | `completed` | 各 collector の差分取得と document / chunk の最新版置換を実装する。Issue #516 / PR #517。  | 各 source の新規・更新・変更なし・再実行で raw 履歴と最新版参照が正しくなる。                    |
| 3    | `completed` | schedule model、自動作成、既存 backfill、管理 UI を実装する。Issue #518 / PR #519。        | 非 Web source に schedule が作られ、admin が状態・時刻・ON/OFF を安全に管理できる。              |
| 4    | `active`    | dispatcher、内部 API、Cloud Scheduler、local CLI、deploy 設定を実装する。Issue #520。      | due schedule の排他実行、retry、OIDC、Cloud Run Job、local one-shot、deploy smoke が確認できる。 |
| 5    | `planned`   | E2E、運用検証、設計書・runbook を整備する。                                                | source 更新から検索反映までの E2E と障害・再試行・secret 非露出の手順が検証済みになる。          |

## Migration 方針

- fresh DB の正準 DDL と差分 migration を同時に更新する。
- 既存 raw の logical ID / source version は source type と既存 metadata から backfill する。必要な metadata が欠ける行は、検証済みの隔離 fallback として `legacy:<既存 source_id>` を logical ID、既存 `content_hash` を source version に設定し、別の legacy 行と統合しない。該当件数は migration 検査結果へ出す。
- backfill 後に `NOT NULL` と一意制約を有効化し、事前検査で衝突を明示する。
- Storage Recovery artifact の自然キーへ logical ID / source version を追加できる契約にし、既存 `sourceId + contentHash` の復元情報を失わない。
- migration は transaction 内で実行し、既存 project / data source の tenant 境界を変更しない。

## テスト計画

- logical ID / source version の runtime guard と source type 別生成規則の unit test。
- 同じ logical ID の複数 raw 版と同一版重複拒否の DB test。
- existing DB / fresh DB の migration、backfill、schema drift test。
- 各 source の初回、新規、更新、変更なし、途中失敗、retry test。
- cursor が完全成功時だけ進み、部分失敗や limit 到達では進まない test。
- document ID を維持して raw 参照と chunk が最新版に置換され、旧 chunk が history に残る test。
- schedule 自動作成、既存 backfill、Web 除外、作成直後の即時 ingest 維持の test。
- dispatcher の多重起動、lease 切れ、retry、disabled schedule / source、失効 connection の test。
- local one-shot が due schedule だけを処理し、due 無しでは外部 API を呼ばず成功終了する test。
- admin 不足、project 越境、改ざん data source ID を拒否する server action / E2E test。
- OIDC、Cloud Run Job override、secret / token / raw 本文非露出の deploy dry-run / smoke test。

## 完了条件

- 各 source の新規・更新を再実行可能な差分処理として取り込める。
- raw の版履歴が保持され、検索・チャットは最新版だけを参照する。
- GitHub / Drive / Gmail が日次で自動同期され、Web は手動差分同期できる。
- schedule と dispatcher の失敗が可視化・再試行され、重複 worker で同じ schedule を同時処理しない。
- project 認可、SQL row runtime guard、app/package 境界、secret / PII 非露出のルールを満たす。
- migration、unit、integration、E2E、typecheck、format、lint、deploy smoke が通る。

## 実装時の注意

- 各 Step は最新 `main` から Issue 番号付き branch を作り、ready PR として完了させる。
- Step 開始時に Issue 番号、status、更新日をこの plan と `plan-status.md` に反映する。
- collection の cursor 更新と raw / link / queue 保存の成功境界を曖昧にしない。
- server action に SQL、外部 process 実行、schedule orchestration を蓄積せず、domain module / repository / runner に分割する。
- DB query row は `readonly unknown[]` から runtime guard を通し、構造未検証 cast を追加しない。
- OAuth token refresh failure や provider error は安全な状態へ正規化し、secret や raw response を保存しない。
