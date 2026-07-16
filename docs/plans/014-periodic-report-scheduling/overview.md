# 定期レポート実行計画

## 目的

プロジェクトごとにレポートの定期作成周期を設定し、設定された周期に従って private report を自動生成する。周期は `none` / `weekly` / `monthly` / `annually` のいずれかとし、project admin がレポート一覧画面で確認・変更できるようにする。

定期レポート生成では、対象期間のデータだけでなく、ひとつ前の同周期の定期レポートを参照し、前回からの変更分、増分、減分、継続課題を明示したレポートを生成する。手動生成レポートや異なる周期のレポートは前回定期レポートとして扱わない。

## 用語と確定仕様

- 周期値は UI 表示・DB・runtime guard の enum ともに `none` / `weekly` / `monthly` / `annually` の 4 値だけを許可する。`moxthly` / `annualy` / `yearly` などの typo・別名は受理せず、月次は `monthly`、年次は `annually` を正とする。
- `none` は定期作成なし。手動レポート生成は従来どおり利用できる。
- `weekly` は週次、`monthly` は月次、`annually` は年次の定期レポートを生成する。
- 周期設定は project 単位でひとつだけ保持する。data source schedule とは独立した report schedule として扱う。
- 初回設定で対象 project に同周期の定期レポートが存在しない場合、過去分を backfill する。ただし現在進行中の期間は作らず、完了済み期間だけを対象にする。
  - `weekly`: 過去の利用可能データ開始日から先週までの週次レポートを作成する。
  - `monthly`: 過去の利用可能データ開始日から先月までの月次レポートを作成する。
  - `annually`: 過去の利用可能データ開始日から前年までの年次レポートを作成する。
- 既に定期レポートが存在する project で周期を変更した場合は、変更時点での即時 backfill / 初回作成は行わず、次回の定期実行から新しい周期で生成する。
- `none` から有効周期へ初めて切り替えた場合だけ、同周期の定期レポート有無を見て backfill を enqueue する。過去に同周期の定期レポートがある場合は即時 backfill せず、次回定期実行のみ予約する。
- 定期生成された report は metadata で手動生成と区別できるようにし、周期、対象期間、前回定期 report id、schedule run id を追跡できるようにする。
- Backfill は大量生成になり得るため、UI 操作の transaction 内では report 本体を生成しない。設定保存後に job / queue として非同期実行し、一覧画面に状態を表示する。

## 既存設計との関係

既存の report は JSON を Object Storage に保存し、metadata と検索用 chunk を PostgreSQL に保存する。定期レポートでもこの保存方針を維持する。public / private の境界も既存 report と同じで、定期生成直後は private report とし、公開可否は既存の `is_public` metadata 更新に従う。

既存の Cloud Scheduler / dispatcher は source sync 用の DB 管理 schedule を持つ。定期レポートも project ごとの DB schedule を持ち、Cloud Scheduler resource を project ごとに増やさず、既存の dispatcher 型 one-shot job で due schedule を claim する方針に寄せる。

## データモデル方針

### `project_report_schedules`

Project ごとの定期レポート設定と実行状態を保持する。

- `project_id`: project への FK。1 project 1 row。
- `frequency`: `none` / `weekly` / `monthly` / `annually`。
- `timezone`: 初期実装では `Asia/Tokyo` 固定。将来変更可能にするため column は持つ。
- `run_time`: PostgreSQL `TIME NOT NULL DEFAULT TIME '10:00'`。`data_source_schedules.daily_time` と同じ wall-clock 型を使い、初期値は DB 稼働時間内の 10:00 `Asia/Tokyo` とする。
- `next_run_at`: `TIMESTAMPTZ` の UTC instant。`none` の場合は `NULL`。
- `last_started_at` / `last_succeeded_at` / `last_failed_at` / `retry_count` / `last_error`: 運用表示用。既存 `data_source_schedules` と命名を揃え、`last_error` には secret、raw 本文、provider response 本文を含まない安全な短い error code / summary だけを保存する。
- `worker_token` / `lease_expires_at`: 多重 worker 排他用。既存 dispatcher と同じ命名・lease pair 制約を使う。
- `created_by` / `updated_by`: project admin 操作の監査用。

### `report_schedule_period_runs`

定期実行・backfill の各 period は、report が生成されない場合も専用テーブルに必ず 1 row を保存する。この履歴モデルは必須とし、`reports` metadata で代用しない。実装 Step 1 では次の物理 model と既存 query / migration への影響を確定する。

- `id`: period run identity。report、dispatcher、UI、運用ログはこの ID で同じ実行対象を追跡する。
- `schedule_id` / `project_id`: schedule と project への FK。DB constraint と query の両方で project 境界を固定する。
- `frequency`: `weekly` / `monthly` / `annually`。`none` は実行対象ではないため保存しない。
- `period_start` / `period_end`: schedule timezone の calendar period を表す `DATE`。同じ project + frequency + period は一意にする。
- `run_kind`: `scheduled` / `scheduled_backfill`。
- `status`: `pending` / `running` / `succeeded` / `skipped` / `retry_wait` / `retry_exhausted`。意図的な skip と retry 枯渇を成功・失敗から区別する。
- `attempt_count` / `next_attempt_at` / `last_error`: retry・手動再実行の状態。`last_error` は安全な短い summary だけを保持する。
- `worker_token` / `lease_expires_at`: chunked queue worker の claim / heartbeat 用。
- `report_id`: 生成済み report への nullable FK。1 period run につき最大 1 report とする。
- `skip_reason` / `notification_sent_at`: report を作らなかった理由と、project admin への通知結果を記録する。
- `created_at` / `updated_at` / `started_at` / `completed_at`: UI と運用監視に必要な時刻。

Backfill 対象列挙は period run row を `pending` で一括作成し、dispatcher は最大 claim 件数ごとに古い row から処理する。retry・worker crash・手動再実行でも同じ row の `attempt_count` と状態を更新し、別 run identity を作らない。これにより skipped period、chunked queue の残数、retry / re-execution、UI の backfill 進捗、idempotency を report の有無にかかわらず追跡する。

### `reports` metadata 追加

既存 `reports` には定期生成結果の検索・前回参照に必要な metadata を追加し、`report_schedule_period_runs` を実行履歴の正本とする。

- `generation_kind`: `manual` / `scheduled` / `scheduled_backfill`。
- `schedule_frequency`: `weekly` / `monthly` / `annually` / `NULL`。
- `previous_scheduled_report_id`: 同じ project + 同じ frequency の直前定期 report。
- `schedule_period_run_id`: `report_schedule_period_runs.id` への FK。同じ period run に複数 report を関連付けない。

同じ project、frequency、period の定期レポートは一意にし、retry や worker 多重起動で重複生成しない。手動 report はこの一意制約の対象外にする。作成時は period run を先に claim し、report insert は `schedule_period_run_id` の一意制約と `ON CONFLICT DO NOTHING RETURNING id` を使う。競合時は既存 report を project + period run 境界で再取得し、整合する生成済み report なら run を `succeeded` として正常終了する。不整合な report の競合だけを failure とし、単純な一意制約違反による不要な retry / alert を発生させない。

## 期間計算

- 期間境界は schedule timezone の calendar period で計算し、DB 保存や due 判定は UTC instant に変換する。
- `weekly` は週開始を月曜、週終了を日曜とする。
- `monthly` は calendar month、`annually` は calendar year とする。
- 通常定期実行の対象 period は dispatcher の現在時刻から逆算せず、永続化済み `next_run_at` が表す calendar slot から決定する。例: 月曜 10:00 の `weekly` slot は直前の月曜〜日曜を表す。
- Dispatcher は due slot ごとに `report_schedule_period_runs` を `ON CONFLICT DO NOTHING` で永続化してから `next_run_at` を 1 period 進める。停止期間が複数 slot にまたがる場合も、1 run の上限内で古い slot から順に row を作り、次回 dispatcher が残りを継続する。
- 通常実行と backfill は、同じ project + frequency について最古の未完了 period run から処理する。後続 period が存在しても `retry_wait` / `retry_exhausted` の period を暗黙に飛ばさない。
- Backfill 開始日は project の最古 document `occurred_at`、最古 raw/document link、または project 作成日のうち実装上安全に取得できる最も古い日時を採用する。初期方針は「候補 document が 0 件の period は `skipped` として `skip_reason` を履歴に残し、report は作らない」。意図的に skip する場合は project admin へ通知し、`notification_sent_at` を記録する。

## 前回定期レポート参照と差分生成

Report workflow の input に `previousScheduledReportId` と `scheduleFrequency` を追加する。workflow は DB で project 境界を検証して前回 report metadata を読み、Object Storage から前回 report JSON を取得する。

Provider に渡す前回 report context は次の上限と共通 builder で bounded にする。文字数は Unicode code point 数で数え、全体は最大 16,000 文字かつ対象 Bedrock model の tokenizer で最大 6,000 token とする。

- 前回 summary: 最大 2,000 文字、1 件。
- 前回から継続している課題・リスク: 最大 10 件、各 400 文字。
- 前回 sections の見出しと要約: 最大 10 件、見出し各 120 文字、要約各 600 文字。
- 前回の主要な `pufu_sources`: 最大 20 件、title 各 160 文字、redaction 済み snippet 各 400 文字。doc type / occurred_at を併記する。

選択順は summary、継続課題、sections、sources の優先順位とする。同種内は report JSON の配列順を正とし、sources だけは `occurred_at DESC, source id ASC` で固定する。まず PII / private locator を除去し、各 field を上限の code point 境界で切って末尾に `…` を付ける。その後 provider 呼び出し直前に文字数と token 数を検証し、全体上限を超える場合は低優先の sources、sections、継続課題の各末尾から順に item を除外する。それでも超える場合は summary を token 境界で縮める。同じ入力は常に同じ context になることを unit test で固定し、予算内に収まらない payload を provider へ送信しない。

新しい report JSON には、通常の `sections` に加えて optional field として差分情報を保存する。

```jsonc
{
  "recurrence": {
    "frequency": "weekly",
    "previous_report_id": "...",
    "change_summary": "前回からの主要な変化...",
    "increments": ["増えた活動・成果..."],
    "decrements": ["減った活動・解消した課題..."],
    "continued_items": ["継続中の課題..."]
  }
}
```

Public report 表示でも private report JSON を同じように描画するため、差分 field には private raw locator、内部 storage URI、token、secret、メールアドレスなどを保存しない。

## UI 方針

`/projects/[projectSlug]/reports` のヘッダー周辺に「定期レポート設定」カードまたは popover を追加する。

- 現在の周期: `none` / `weekly` / `monthly` / `annually`。
- 次回実行予定、前回成功、前回失敗、period run の pending / running / skipped / retry exhausted と backfill 残数。
- 周期変更 selector と保存 button。
- `none` 以外への初回設定時は「完了済み過去期間を非同期で作成する」ことを説明する。
- 既存定期レポートがある状態で周期変更する場合は「変更時の即時作成は行わず、次回定期実行から反映する」ことを説明する。
- project admin のみ変更可能。project member は読み取り表示のみ。

レポート一覧 table には定期生成か手動生成か、周期、前回との差分あり/なしを比較できる表示を追加する。詳細画面では差分 summary、増分、減分、継続項目を標準 section の上部または context panel に表示する。

## Dispatcher / Job 方針

- Cloud Scheduler は 5 分ごとなど固定間隔で report schedule dispatcher を起動する。
- Dispatcher は due な `project_report_schedules` と処理対象の `report_schedule_period_runs` を `FOR UPDATE SKIP LOCKED` で claim し、`worker_token` と `lease_expires_at` で多重実行を防ぐ。
- 1 run の最大 materialize / claim 件数と最大実行時間を設定し、長い backfill と dispatcher 停止後の catch-up は複数 run に分割する。各 run は最古の未完了 period から処理する。
- 失敗時は同じ period run を 15 分、1 時間、6 時間の順に retry する。上限到達後は `retry_exhausted` にして project admin へ通知し、手動の re-enqueue または理由付き `skipped` への変更が行われるまで後続 period を先に生成しない。通常周期へ暗黙に戻して未生成 period を飛ばさない。
- retry / worker 多重起動で report insert が競合した場合は、整合する既存 report を取得して成功扱いにする。`ON CONFLICT` で競合を吸収した事実は debug metric に残しても warning / failure alert にはしない。
- ローカル検証用に `pnpm report-schedule:dispatch --once` 相当の one-shot CLI を用意し、本番と同じ DB lease / retry / period 計算を使う。
- 通常の `pnpm dev` や `docker compose up` では自動起動しない。

## Step 構成

| Step | status      | 内容                                                                          | 完了条件                                                                                                                                                |
| ---- | ----------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `completed` | schedule / period run / report metadata の DB model と migration を追加する。 | Issue #579。fresh / 既存 DB migration、runtime guard、period run・report の一意制約、project 境界 query、report なしの skipped 履歴を検証済み。         |
| 2    | `completed` | 期間計算、前回定期 report 解決、通常 / backfill 対象列挙を実装する。          | Issue #581。完了済み period、bounded catch-up / backfill、次回 slot、最古未完了優先、初回 backfill 判定、同一 project・frequency の前回参照を検証済み。 |
| 3    | `planned`   | report workflow に前回参照と差分生成 context を追加する。                     | 前回 report を明示的な件数・文字数・token 予算内で決定的に参照し、change / increments / decrements が JSON に保存される。                               |
| 4    | `planned`   | report schedule dispatcher、内部 API、local one-shot CLI を実装する。         | due claim、lease、retry、idempotency、backfill 分割、secret 非露出が確認できる。                                                                        |
| 5    | `planned`   | レポート一覧 UI で周期設定と実行状態を管理できるようにする。                  | admin は周期を保存でき、member は読み取りのみ。初回/backfill/変更時挙動の説明と状態が表示される。                                                       |
| 6    | `planned`   | レポート一覧・詳細表示、E2E、運用ドキュメントを整備する。                     | 定期/手動の区別、差分表示、public 境界、dispatcher 運用、障害時確認手順が検証・文書化される。                                                           |

## テスト計画

- `project_report_schedules`、`report_schedule_period_runs`、report metadata の migration / schema drift test。
- `frequency` enum の runtime guard と typo 値拒否 test。
- weekly / monthly / annually の period 計算 unit test。timezone と DST 影響を含める。
- 初回設定時の backfill 対象列挙 test。現在進行中 period を含めないことを確認する。
- 周期変更時に即時 backfill / 初回作成をしない regression test。
- report が生成されない skipped period、chunked backfill の残数、retry / manual re-enqueue 状態を period run に保持する test。
- dispatcher の停止・遅延後も `next_run_at` 由来の全 due period を古い順に materialize し、未完了 period を飛ばさない test。
- retry exhausted が後続 period の生成を止め、理由付き skip または re-enqueue で再開する test。
- 同一 project + frequency + period の period run / 定期 report 重複拒否と、整合する既存 report の競合を成功扱いにする test。
- 前回定期 report 解決 test。手動 report、異なる frequency、project 越境 report を参照しないことを確認する。
- 前回 report JSON の件数・文字数・token 予算、選択順、決定的 truncation と private locator / secret / PII 非保存 test。
- dispatcher の claim、lease 切れ、retry、idempotency、backfill 分割 test。
- project admin / member / non-member の UI・server action 認可 test。
- report 一覧・詳細・public report 表示の regression test。
- local one-shot CLI が due schedule だけを処理し、due 無しでは外部 API / provider を呼ばず成功終了する test。

## セキュリティ・運用上の注意

- 周期設定変更は project admin のみ許可し、server action / route handler は project slug や project id を DB で検証する。
- 前回 report 参照時も project id と report id の一致を DB で確認し、ブラウザ入力の report id を信用しない。
- report workflow trace、schedule error、run log に raw 本文全文、OAuth token、secret、provider response 本文、メールアドレス等の PII を保存しない。
- Backfill は provider token とコストを消費するため、対象 period 数、生成数、失敗数を UI と運用ログで確認できるようにする。
- DB 業務時間外制約があるため、初期実装の既定実行時刻は DB 稼働時間内にする。夜間実行が必要な場合は DB VM 起動制御を別途設計する。
- server action に SQL、外部 process 起動、dispatcher orchestration を蓄積せず、domain module / repository / runner に分割する。

## 完了条件

- Project admin がレポート一覧画面で `none` / `weekly` / `monthly` / `annually` を設定できる。
- 初回設定時、同周期の定期 report がなければ完了済み過去 period の backfill が非同期に作成される。
- 周期変更時は即時作成せず、次回定期実行から新周期が反映される。
- 定期 report は前回同周期 report を参照して、変更分、増分、減分、継続項目を保存・表示できる。
- Dispatcher は多重起動、retry、backfill 大量生成に対して idempotent に動作する。
- private / public report の既存境界、project 認可、secret / PII 非露出、DB 業務時間外方針を維持する。
