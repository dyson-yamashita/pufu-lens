# 定期レポート実行計画

## 目的

プロジェクトごとにレポートの定期作成周期を設定し、設定された周期に従って private report を自動生成する。周期は `none` / `weekly` / `monthly` / `annually` のいずれかとし、project admin がレポート一覧画面で確認・変更できるようにする。

定期レポート生成では、対象期間のデータだけでなく、ひとつ前の同周期の定期レポートを参照し、前回からの変更分、増分、減分、継続課題を明示したレポートを生成する。手動生成レポートや異なる周期のレポートは前回定期レポートとして扱わない。

## 用語と確定仕様

- 周期値は UI 表示では `none` / `weekly` / `monthly` / `annually` とする。実装上の enum も typo を避けて `monthly` / `annually` を正とする。
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
- `run_time`: wall-clock 実行時刻。初期値は DB 稼働時間内の 10:00 `Asia/Tokyo`。
- `next_run_at`: UTC instant。`none` の場合は `NULL`。
- `last_success_at` / `last_failure_at` / `retry_count` / `last_error_code`: 運用表示用。secret、raw 本文、provider response 本文は保存しない。
- `lease_token` / `leased_until`: 多重 worker 排他用。
- `created_by` / `updated_by`: project admin 操作の監査用。

### `reports` metadata 追加

既存 `reports` に次の metadata を追加するか、互換性を優先して別テーブル `report_generation_runs` を追加する。実装 Step 1 で migration 影響を比較し、既存 report 一覧 query の複雑さが小さい方を採用する。

- `generation_kind`: `manual` / `scheduled` / `scheduled_backfill`。
- `schedule_frequency`: `weekly` / `monthly` / `annually` / `NULL`。
- `previous_scheduled_report_id`: 同じ project + 同じ frequency の直前定期 report。
- `schedule_run_id`: dispatcher run / backfill run の追跡 ID。

同じ project、frequency、period の定期レポートは一意にし、retry や worker 多重起動で重複生成しない。手動 report はこの一意制約の対象外にする。

## 期間計算

- 期間境界は schedule timezone の calendar period で計算し、DB 保存や due 判定は UTC instant に変換する。
- `weekly` は週開始を月曜、週終了を日曜とする。
- `monthly` は calendar month、`annually` は calendar year とする。
- 定期実行時は、実行日時の直前に完了した period を対象にする。例: 月曜 10:00 の `weekly` 実行では直前の月曜〜日曜を生成対象にする。
- Backfill 開始日は project の最古 document `occurred_at`、最古 raw/document link、または project 作成日のうち実装上安全に取得できる最も古い日時を採用する。データがない period は生成しないか、空レポートを許容するかを Step 2 の受け入れ条件で確定する。初期方針は「候補 document が 0 件の period は skipped として履歴に残し、report は作らない」。

## 前回定期レポート参照と差分生成

Report workflow の input に `previousScheduledReportId` と `scheduleFrequency` を追加する。workflow は DB で project 境界を検証して前回 report metadata を読み、Object Storage から前回 report JSON を取得する。

Provider に渡す前回 report context は bounded にする。

- 前回 summary。
- 前回 sections の見出しと要約。
- 前回の主要な `pufu_sources` の title / doc type / occurred_at / redaction 済み snippet。
- 前回から継続している課題・リスクの抽出結果。

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
- 次回実行予定、前回成功、前回失敗、backfill 状態。
- 周期変更 selector と保存 button。
- `none` 以外への初回設定時は「完了済み過去期間を非同期で作成する」ことを説明する。
- 既存定期レポートがある状態で周期変更する場合は「変更時の即時作成は行わず、次回定期実行から反映する」ことを説明する。
- project admin のみ変更可能。project member は読み取り表示のみ。

レポート一覧 table には定期生成か手動生成か、周期、前回との差分あり/なしを比較できる表示を追加する。詳細画面では差分 summary、増分、減分、継続項目を標準 section の上部または context panel に表示する。

## Dispatcher / Job 方針

- Cloud Scheduler は 5 分ごとなど固定間隔で report schedule dispatcher を起動する。
- Dispatcher は due な `project_report_schedules` を `FOR UPDATE SKIP LOCKED` で claim し、lease token と期限で多重実行を防ぐ。
- 1 run の最大 claim 件数と最大実行時間を設定し、長い backfill は chunked queue として複数 run に分割する。
- 失敗時は 15 分、1 時間、6 時間の順に retry し、その後は次の通常周期へ戻す。ただし重複 period の一意制約により retry は idempotent にする。
- ローカル検証用に `pnpm report-schedule:dispatch --once` 相当の one-shot CLI を用意し、本番と同じ DB lease / retry / period 計算を使う。
- 通常の `pnpm dev` や `docker compose up` では自動起動しない。

## Step 構成

| Step | status    | 内容                                                                  | 完了条件                                                                                             |
| ---- | --------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1    | `planned` | schedule / run metadata の DB model と migration を追加する。         | fresh / 既存 DB migration、runtime guard、period 一意制約、project 境界 query が検証済みになる。     |
| 2    | `planned` | 期間計算、前回定期 report 解決、backfill 対象列挙を実装する。         | weekly / monthly / annually の完了済み period、初回 backfill、周期変更時の非 backfill が検証済み。   |
| 3    | `planned` | report workflow に前回参照と差分生成 context を追加する。             | 前回 report を bounded context として参照し、change / increments / decrements が JSON に保存される。 |
| 4    | `planned` | report schedule dispatcher、内部 API、local one-shot CLI を実装する。 | due claim、lease、retry、idempotency、backfill 分割、secret 非露出が確認できる。                     |
| 5    | `planned` | レポート一覧 UI で周期設定と実行状態を管理できるようにする。          | admin は周期を保存でき、member は読み取りのみ。初回/backfill/変更時挙動の説明と状態が表示される。    |
| 6    | `planned` | レポート一覧・詳細表示、E2E、運用ドキュメントを整備する。             | 定期/手動の区別、差分表示、public 境界、dispatcher 運用、障害時確認手順が検証・文書化される。        |

## テスト計画

- `project_report_schedules` と report metadata の migration / schema drift test。
- `frequency` enum の runtime guard と typo 値拒否 test。
- weekly / monthly / annually の period 計算 unit test。timezone と DST 影響を含める。
- 初回設定時の backfill 対象列挙 test。現在進行中 period を含めないことを確認する。
- 周期変更時に即時 backfill / 初回作成をしない regression test。
- 同一 project + frequency + period の定期 report 重複拒否 test。
- 前回定期 report 解決 test。手動 report、異なる frequency、project 越境 report を参照しないことを確認する。
- 前回 report JSON の bounded context 化と private locator / secret / PII 非保存 test。
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
