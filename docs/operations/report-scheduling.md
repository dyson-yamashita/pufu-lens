# 定期レポート Scheduling 運用手順

週次・月次・年次レポートの dispatcher を安全に確認し、障害を切り分けるための手順をまとめる。dispatcher は DB 上の due slot を period run に materialize し、project・frequency ごとに最古の未完了 period を claim してレポートを生成する。1 回の起動では materialize と claim をそれぞれ最大 10 件、開始から最大 45 分まで処理する。

## キック経路

| 環境     | 起動経路                                                               | 実行単位              |
| -------- | ---------------------------------------------------------------------- | --------------------- |
| 本番     | Cloud Scheduler（5 分間隔）→ OIDC 付き Mastra 内部 API → Cloud Run Job | 最大 10 件・45 分     |
| ローカル | `pnpm report-schedule:dispatch --once`                                 | 同じ DB lease / retry |

project ごとの Cloud Scheduler resource は作らない。`project_report_schedules` と `report_schedule_period_runs` を状態の正本とし、通常実行と backfill は同じ dispatcher を使う。

## ローカル確認

### 前提

- `DATABASE_URL` はローカル PostgreSQL を指す。
- Storage 設定と report provider credentials はローカル検証専用値を使う。
- 対象 project に有効な `weekly` / `monthly` / `annually` schedule が存在する。
- 本番 DB、Storage、credentials をローカル dispatcher から参照しない。

通常の `pnpm dev` と `docker compose up` は dispatcher を自動起動しない。外部 provider 呼び出しとコスト発生を意図したときだけ、次を明示実行する。

```bash
pnpm report-schedule:dispatch --once
```

`--once` は必須であり、CLI は常駐 loop を持たない。due schedule が無い場合は report provider を呼ばず正常終了する。完了 log の `materialized`、`claimed`、`succeeded`、`skipped`、`failed`、`leaseLost` は件数だけを確認し、生成本文や credential を log へ追加しない。

## DB 状態の確認

project slug と bounded な運用 metadata だけを確認する。`worker_token`、report 本文、Storage URI は取得しない。

```sql
SELECT project.slug,
       schedule.frequency,
       schedule.timezone,
       schedule.run_time,
       schedule.next_run_at,
       schedule.last_started_at,
       schedule.last_succeeded_at,
       schedule.last_failed_at,
       schedule.retry_count,
       schedule.last_error,
       schedule.lease_expires_at
FROM project_report_schedules AS schedule
JOIN projects AS project ON project.id = schedule.project_id
ORDER BY project.slug;
```

```sql
SELECT project.slug,
       period_run.frequency,
       period_run.period_start,
       period_run.period_end,
       period_run.run_kind,
       period_run.status,
       period_run.attempt_count,
       period_run.next_attempt_at,
       period_run.last_error,
       period_run.skip_reason,
       period_run.lease_expires_at,
       period_run.started_at,
       period_run.completed_at
FROM report_schedule_period_runs AS period_run
JOIN projects AS project ON project.id = period_run.project_id
WHERE period_run.status <> 'succeeded'
ORDER BY project.slug, period_run.frequency, period_run.period_start, period_run.id
LIMIT 200;
```

確認時は次を区別する。

- `pending`: 最古の未完了 period であれば次の dispatcher が claim する。長時間残る場合は、より古い未完了 period と Scheduler / Job 起動を確認する。
- `running`: `lease_expires_at` が未来なら処理中である。Job の存在を確認し、手動で lease を解除しない。期限切れ後は別 worker が再 claim できる。
- `retry_wait`: `next_attempt_at` 以降に再試行する。15 分、1 時間、6 時間の順で待機するため、時刻前の再実行を異常と判断しない。
- `retry_exhausted`: 自動では後続 period を追い越さない。原因を解消しても専用の retry 操作がない間は DB の status / attempt count を手作業で変更せず、Issue に project、frequency、period、safe error と調査結果を記録して復旧機能の追加または承認済み forward fix へエスカレーションする。
- `skipped`: 対象 period に document が無い場合など、report を生成しない終端状態である。`skip_reason` の安全な要約を確認する。report を作る目的で ad hoc に status を戻さない。
- `succeeded`: `report_id` を持つ終端状態である。一覧では `scheduled` / `scheduled_backfill` と周期が表示され、前回 report がある場合は詳細に差分が表示される。

同じ project・frequency では最古の `pending` / `running` / `retry_wait` / `retry_exhausted` を先に解決する。後続 period を先に成功・skip 扱いにする DB 更新は禁止する。

## 障害・再試行

- provider または生成処理の失敗は `retry_wait` へ移り、3 回の retry 後は `retry_exhausted` になる。`last_error` は最大 1,000 文字の安全な要約だけを保存する。
- document が無い period は `skipped` とし、provider を呼ばない。
- heartbeat 失敗、lease 喪失、45 分の runtime 超過では旧 worker が後続 worker の状態を上書きしない。`leaseLost` と `report_schedule_lease_lost` event を確認し、期限切れを待つ。
- 同じ `schedule_period_run_id` の report insert は冪等である。再実行時に整合する report が既にあれば成功扱いになる。
- 初回 backfill は完了済み period だけを bounded に登録する。大量 backfill では 1 回あたりの上限を外さず、Cloud Scheduler の継続起動で順に処理する。provider quota と生成コストを事前に確認する。
- raw 本文、provider response、OAuth token、secret、API key、メール本文・宛先を DB error、Cloud log、Issue、PR、chat に貼らない。

## 本番確認

1. Cloud Scheduler の直近実行が成功し、OIDC service account が Mastra Server の `roles/run.invoker` を持つことを確認する。
2. Mastra runtime service account が dispatcher Job の `run.jobs.run` と `run.jobs.runWithOverrides` を実行できることを確認する。
3. Mastra の内部 API `POST /internal/schedules/report-schedule-dispatcher:run` には空の JSON object だけが渡されていることを確認する。project、period、credential を override に入れない。
4. Cloud Run Job の構造化 log で safe event 名、project ID、period run ID、件数を確認する。本文や worker token は恒久ログへ転記しない。
5. DB の schedule と period run が上記の状態遷移に従い、private/public の既存アクセス境界が維持されていることを確認する。

```bash
gcloud scheduler jobs describe "$SCHEDULER_JOB" \
  --project "$PROJECT_ID" \
  --location "$REGION" \
  --format='yaml(httpTarget.uri,httpTarget.oidcToken,lastAttemptTime,status)'

gcloud run jobs executions list \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --job "$DISPATCHER_JOB"

gcloud run services get-iam-policy "$MASTRA_SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION"

gcloud run jobs get-iam-policy "$DISPATCHER_JOB" \
  --project "$PROJECT_ID" \
  --region "$REGION"
```

Cloud Scheduler や Job を手動実行する前に、同じ period を処理中の execution と非期限切れ lease が無いことを確認する。障害対応でも schedule、period run、lease、worker token を直接書き換えない。

## 自動回帰テスト

```bash
pnpm scripts:test
pnpm --filter @pufu-lens/web test
pnpm --filter @pufu-lens/web typecheck
pnpm --filter @pufu-lens/web test:e2e -- report-ui.spec.ts
```

主な保証範囲は due materialize、最古 period の claim、lease / heartbeat、retry、skip、冪等 report insert、一覧の生成種別、private/public の差分表示と公開境界である。実 provider、OIDC、Cloud Run、quota、生成品質は staging smoke として別途確認する。
