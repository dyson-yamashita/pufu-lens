# Source Sync Scheduling 運用手順

GitHub / Drive / Gmail の日次差分同期と、Web の手動差分同期を安全に確認・復旧するための手順をまとめる。dispatcher は DB 上の due schedule を1件ずつ claim し、対象 data source の collect と ingest を直列実行する。

## キック経路

| 環境     | 起動経路                                                              | 実行単位         |
| -------- | --------------------------------------------------------------------- | ---------------- |
| 本番     | Cloud Scheduler（5分間隔）→ OIDC 付き Mastra 内部 API → Cloud Run Job | due schedule 1件 |
| ローカル | `pnpm schedule:dispatch --once`                                       | due schedule 1件 |

source ごとの Cloud Scheduler resource は作らない。Web source は自動 schedule を持たず、管理画面または既存の collect / ingest 導線から手動実行する。

## ローカル確認

### 前提

- `DATABASE_URL` はローカル PostgreSQL を指す。
- Object Storage、connection secret 復号鍵、provider credentials はローカル検証専用値を使う。
- 対象の GitHub / Drive / Gmail data source と有効な connection が存在する。
- 本番 DB、Object Storage、credentials をローカル dispatcher から参照しない。

通常の `pnpm dev` と `docker compose up` はdispatcherを自動起動しない。外部 API へのアクセスを意図したときだけ次を明示実行する。

```bash
pnpm schedule:dispatch --once
```

due schedule が無い場合は外部 provider を呼ばず正常終了する。継続確認では `cron` / `launchd` などのhost schedulerから5分ごとにone-shotを呼び、CLIを常駐させない。

## 正常性の確認

機密値を表示しない集計だけを確認する。

```sql
SELECT enabled, retry_count, next_run_at, last_started_at,
       last_succeeded_at, last_failed_at, last_error
FROM data_source_schedules
ORDER BY next_run_at;
```

更新版の同期後は次を確認する。

1. 同じ `logical_source_id` に異なる `source_version` の `raw_documents` が残る。
2. `documents.id` は維持され、`raw_document_id` が最新版へ切り替わる。
3. 現在の `document_chunks` は最新版だけを参照し、旧chunkは `document_chunk_history` に退避される。
4. 変更なしの再実行ではraw、queue、chunkを増やさない。
5. 検索・チャットsmokeでは更新後だけに含まれる固有語を問い合わせ、旧本文ではなく最新版が候補になる。

## 障害・再試行

- collect / ingest失敗時は `retry_count` と `last_failed_at` を更新し、15分、1時間、6時間の順で再試行した後、通常の日次周期へ戻る。
- `last_error` は `collect` / `ingest` とexit codeだけを含む安全な要約とする。provider response、raw本文、token、secret、メール本文や宛先を保存しない。
- heartbeat失敗またはlease喪失時は実行中childを停止し、旧workerは成功・失敗を確定しない。lease期限後の別workerによる再claimに任せる。
- disabled schedule / disabled source はclaimされない。意図的な停止かを管理画面で確認してから再有効化する。
- connection失効・scope不足はconnectionを修復してから再実行する。schedule errorへOAuth応答本文を転記しない。

多重起動を疑う場合は同じscheduleの `worker_token` と `lease_expires_at` を確認するが、token値自体をIssue、PR、chat、恒久ログへ貼らない。手動でleaseやworker tokenを書き換えず、実行中workerがないことを確認したうえでlease期限切れを待つ。

## 本番確認

1. Cloud Schedulerの直近実行が成功し、OIDC service accountがMastra Serverの `roles/run.invoker` を持つことを確認する。
2. Mastra runtime service accountがdispatcher Jobに対する `roles/run.jobsExecutorWithOverrides`、または `run.jobs.run` と `run.jobs.runWithOverrides` を含むcustom roleを持つことを確認する。
3. Cloud Run Jobの構造化logではevent名、schedule ID、source type、件数だけを確認する。
4. DB停止時間帯に起動していないことを確認する。夜間実行が必要ならDB起動・停止を別運用として用意する。

Cloud SchedulerやJobを手動実行する前に、同じdue scheduleを処理中のexecutionがないこととDB稼働を確認する。手動実行でもsource IDやcredentialをJob overrideへ渡さず、dispatcherにDBから解決させる。

## 自動回帰テスト

```bash
pnpm scripts:test
pnpm --filter @pufu-lens/ingestion test
pnpm --filter @pufu-lens/mastra test
```

主な保証範囲は、due / enabled条件と `SKIP LOCKED`、lease / heartbeat / retry、source単位のcollect→ingest、safe error、raw複数版、document ID維持、最新版chunk置換、旧chunk履歴である。実provider、OIDC、Cloud Run、検索品質はstaging smokeとして別途確認する。
