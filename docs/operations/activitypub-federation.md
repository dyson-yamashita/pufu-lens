# ActivityPub Federation 運用手順

この runbook は Plan 017 Step 7 の production 運用境界を定める。コマンド例は対象環境と change record を確認してから実行し、本番 deploy、外部 ActivityPub server への送信、Secret Manager 更新は通常の change approval に従う。message body、Activity payload、HTTP Signature、Actor private key、暗号文、token、`DATABASE_URL` は監視・Issue・PR・運用ログへ記録しない。

## 監視とアラート

ActivityPub dispatcher は実行後に `activitypub_queue_metrics` と、rolling 24時間のfailure上位20 originおよび固定 `other` の `activitypub_origin_failure_metrics` を structured log へ出す。Web proxy は固定allowlistのroute kind、method、status、status classだけを持つ `activitypub_request`、POST inbox の 401 / 403 に `activitypub_inbox_authentication_failure` を出す。すべて `bodyless=true` で、host、path、query、Actor / report ID、header、bodyを含めない。log-based metricのlabelは `route_kind` と `status_class` だけを抽出し、methodとstatusは安全な切り分け用structured fieldとして保持する。

`deploy/examples/gcp-cloud-build/activitypub-observability/` は次を定義する。

| 分類            | metric / alert                                              | 初期しきい値                                                           |
| --------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| backlog         | total / pending depth、oldest age                           | total depth > 50 または oldest age > 3600秒が15分継続                  |
| retry           | retry_wait、retry exhausted                                 | retry_wait > 20が15分継続、retry exhausted > 0が5分継続                |
| delivery        | success、permanent failure、429、5xx                        | failure系 > 0が5分継続。successはidle時の誤報を避けるためdashboardのみ |
| origin          | top 20 origin + `other` のfailure distribution              | origin別 p95 > 10が15分継続                                            |
| inbound         | inbox 401 / 403                                             | 5分のrateが0超                                                         |
| capacity / cost | request count、dispatcher duration、ActivityPub table bytes | monthly baselineと比較し、予算アラートはBilling側で設定                |

しきい値は初期値であり、最低1か月のbaseline後に traffic とSLOに合わせて変更する。origin label は保存済み `recipient_origin` のみ、rolling 24時間のretry_wait / retry exhausted / permanent failure / 429 / 5xxを同じwindowで集計し、上位20件以外は `other` へ畳む。本文やrecipient URIをlabelにしない。

設定はまずdry-runする。dry-runは `gcloud` を呼ばない。

```bash
bash deploy/examples/gcp-cloud-build/activitypub-observability/apply.sh \
  --project '<project-id>' \
  --notification-channel 'projects/<project-id>/notificationChannels/<channel-id>'
```

差分、対象project、notification channelをレビューした承認済みchangeだけが `--apply` を付ける。scriptはmetric / policy検索失敗、重複、一致しないmetric名をfail closedにし、0件だけcreate、1件だけupdateする。本runbookの更新だけでは適用しない。

## 障害の切り分け

1. queue total depth、oldest age、retry_wait、retry exhaustedを確認する。
2. 429 / 5xx とorigin別failureを確認し、単一originか全体障害かを分ける。
3. inbox 401 / 403 増加時は時刻同期、署名 `Date`、key owner / Actor一致、公開鍵取得、canonical originを確認する。raw Signature headerは収集しない。
4. permanent failureではsafe error codeとHTTP statusだけを確認する。bodyをDB、log、ticketへ複製しない。
5. dispatcher snapshot自体が失敗した場合は `activitypub_operations_snapshot_failed` を調査し、DB接続、migration `0024_activitypub_operations`、relation権限を確認する。

## retry exhausted の調査、再投入、破棄

対象message IDは本文を表示しない安全なmetadata queryまたはアラートから取得する。最初にinspectし、出力の `updatedAt` をoptimistic lockに使う。

`DATABASE_URL` は実行前にSecret Manager連携、保護されたprocess環境、またはshell historyへ残らない承認済みのenv fileから注入する。コマンド行へ値を直接書かず、標準出力やticketにも記録しない。

```bash
pnpm activitypub:queue -- inspect \
  --message-id '<queue-message-uuid>'
```

inspectはqueue kind、recipient origin、status、attempt count、safe error code、HTTP status、時刻だけを返し、`message_json`、dedupe key、署名、bodyを返さない。statusが `retry_exhausted` でない、leaseが残る、`updatedAt` が変わった場合は操作を中止して再調査する。

remote復旧、domain block解除、設定修正など原因を除去し、再配送が許容される場合だけ再投入する。`change-ref` は `issue-682`、`incident-20260812` のような固定形式にする。

```bash
pnpm activitypub:queue -- requeue \
  --message-id '<queue-message-uuid>' \
  --confirm-message-id '<queue-message-uuid>' \
  --expected-updated-at '<updatedAt-exact-UTC-value>' \
  --change-ref 'incident-<id>' \
  --execute
```

再送が不要、remoteが恒久拒否、誤配送を止める必要がある場合は破棄する。破棄はpayloadを削除せず `permanent_failure` へ終端化し、safe error metadataを保持する。

```bash
pnpm activitypub:queue -- discard \
  --message-id '<queue-message-uuid>' \
  --confirm-message-id '<queue-message-uuid>' \
  --expected-updated-at '<updatedAt-exact-UTC-value>' \
  --change-ref 'incident-<id>' \
  --execute
```

両操作はrow lock、status / lease / `updated_at` 再検証、queue更新、`activitypub_queue_operator_actions` 監査行を同一transactionで処理する。`lease_expires_at` がDB時刻より未来の場合だけactive leaseとして拒否し、期限切れleaseはworker tokenと対で解除して操作を続行できる。監査tableはDB triggerでUPDATE / DELETEを拒否する。先行messageのterminal failureにより後続messageも終端化済みの場合、先行messageの再投入だけでは後続を復活させない。ordering key単位で影響範囲を調査し、後続を個別に操作する場合も別change-refとinspectを必須にする。

## Domain block

`ACTIVITYPUB_BLOCKED_DOMAINS` はカンマ区切りのhostname allowlist形式ではなくblocklistであり、exact hostとsubdomainを受信remote document / Actor解決で拒否する。

1. incident recordにdomain、根拠、期限、影響projectを記録する。URL、path、payloadは記録しない。
2. WebとActivityPub dispatcherの両runtimeに同じ正規化済みhostname一覧を設定する。
3. stagingでexact host / subdomain拒否、無関係domainの非拒否、redirect先の再検証を確認する。
4. 通常のdeploy approvalで反映し、新しいrevision / Job設定を確認する。
5. 既存のretry exhaustedは自動復活しない。原因と配送可否を確認して前節の手順を使う。

緊急停止でもSSRF guard、HTTPS限定、redirect hop検証を無効化しない。

## Actor key backup、復旧、rotation

### Backup / restore

Actor identityの復旧には、同一時点のPostgreSQL backupに含まれる `activitypub_actors.public_key_pem` / `encrypted_private_key` と、Secret Managerの `ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY` versionの両方が必要である。片方だけでは署名identityを復元できない。

- PostgreSQLは通常の暗号化backupで `activitypub_instance_config`、`activitypub_actors`、follow / activity / queue tablesを同一snapshotとして保存する。表のdumpや暗号文をticketへ貼らない。
- encryption key secretはSecret Managerのversion、replication、CMEK / IAM、復旧責任者をbackup inventoryへ記録する。secret値はexportしない。組織のDR要件でexportが必要な場合は承認済みoffline vaultへ暗号化保管し、標準出力やshell historyを経由しない。
- 四半期ごとに隔離環境へDB snapshotとsecret versionを復元し、外部送信を無効にしたまま既存Actorの公開鍵が一致し、private keyを復号できることを確認する。
- 復旧時は元の `ACTIVITYPUB_CANONICAL_ORIGIN` を使う。別domainで復旧して外部配送しない。

### Signing key / encryption key rotation

現行schemaはActorごとに単一の公開鍵と暗号化private JWKを持ち、自動rotationや旧鍵併存を実装していない。したがって手動SQLで鍵を置換せず、次のmaintenance changeとして扱う。

1. Schedulerと新規outbox enqueueを停止し、running leaseがなくqueueがdrain済みであることを確認する。
2. DB snapshotと現在のSecret Manager versionを取得し、復元試験済みであることを確認する。
3. signing key rotationは、旧公開鍵の互換期間、Actor endpointの新旧key公開、queued taskのkey ID、remote cacheを扱う実装・migration・hermetic E2Eを先に追加する。互換期間なしのin-place置換は禁止する。
4. encryption key rotationは、全 `encrypted_private_key` を旧鍵で復号し新鍵で再暗号化するversioned/batched toolとrollbackを先に追加し、全rowの再読込確認後にruntime secret versionを切り替える。secretだけ先に更新しない。
5. stagingでWebFinger、Actor、signed self-check、restart後再読込、queue drainを確認し、承認済みproduction changeで段階反映する。

鍵漏えい時は外部送信を停止し、影響Actor、公開期間、queueを保全してsecurity incidentとして扱う。安全なrotation実装がない状態で復旧不能な置換を行わず、backup restoreまたはforward fixを選ぶ。

## Follow / Accept / Undo の即時dispatcher起動

production Webは、新規Follow / Accept / UndoをPostgreSQL inbox queueへ保存した直後に、同じrequest内でActivityPub dispatcher Cloud Run Jobの起動を試みる。Webはqueueをclaimせず、Job API呼出しだけを行う。重複activity、Create / Announce、outbox enqueueでは即時起動しない。

- App Hosting runtimeに`ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED=1`、`PUFU_LENS_GCP_PROJECT_ID`、`PUFU_LENS_CLOUD_RUN_JOBS_REGION`、`PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAME`を設定する。
- App Hosting backend service accountが対象ActivityPub Job resourceで`run.jobs.run` / `run.jobs.runWithOverrides`を持つことを確認する。project全体へ権限を広げない。
- 正常時はInbox受信後にJob executionが開始し、Follow / Accept / Undoが5分Schedulerを待たず処理される。Mastodon側の表示更新やキャッシュには別の遅延があり得る。
- `activitypub_inbox_dispatcher_trigger`の`fallback`が出た場合は、固定`errorCode`（設定、token、timeout、network、HTTP）とJob IAM / API状態だけを調べる。Activity / Actor ID、payload、token、response body、例外本文をlogへ追加しない。
- 即時起動に失敗してもInbox rowは保持される。5分Schedulerでqueue depthが減ることを確認し、即時triggerを手動再送しない。同じFollowを利用者へ繰り返し送らせない。

## Canonical origin と Scheduler OIDC audience

`ACTIVITYPUB_CANONICAL_ORIGIN` はrequest headerから導出せず、productionで固定する。最初のoutbound activity以後はActor ID、activity ID、report object ID、署名key IDのoriginとして外部に永続化されるため、変更を禁止する。

- deploy前にWebとdispatcherの `ACTIVITYPUB_CANONICAL_ORIGIN` が同じ公開federation用HTTPS originを参照することを確認する。
- `ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE` はSchedulerが内部routeへ送るID tokenのaudienceであり、固定Mastra service URLへ設定する。公開canonical originとは役割が異なり、同じ値である必要はない。
- domain障害時も別originへ書き換えず、DNS / certificate / routingを元のoriginで復旧する。
- domain移行はActor移行、旧URL継続、remote follower、署名key、Tombstoneを設計する別planとし、環境変数変更だけで実施しない。

## 初回production rollout

1. 公開WebのHTTPS originをcanonical originとして固定し、DNS、TLS、障害復旧の責任者を記録する。`AUTH_URL`と同じ公開originを使う場合も、request Hostから導出しない。
2. Mastra Cloud Run serviceの`status.url`とdesignated Scheduler SAの`uniqueId`をGCPから取得する。OIDC audienceやnumeric subjectを手入力で推測しない。
3. canonical base64の32-byte `ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY` secretをstdinから作成し、ENABLED version、replication、runtime access、App Hosting backend accessを確認する。値を表示・記録しない。
4. Cloud Build triggerへcanonical origin、Mastra audience、Scheduler subject、Actor key secret名を設定する。substitutionにはsecret名だけを置き、payloadを置かない。
5. `apps/web/apphosting.yaml`の`ACTIVITYPUB_ENABLED=1`、canonical origin、DB pool上限、Actor key secret referenceに加え、Inbox即時trigger flag、GCP project、Jobs region、ActivityPub dispatcher Job名が対象environmentと一致することを確認する。
6. 最新`main`と一致するpending buildだけを承認する。validationはHTTPS origin、Scheduler identity、secret metadata / ENABLED versionをruntime変更前にfail closedで検証する。
7. deploy成功後、Cloud BuildのGET-only smokeで`@all` WebFingerとActorを確認する。各GETはbody読取を含め15秒、JSON bodyは1 MiBを上限とする。Follow、Inbox POST、dispatcher手動実行、外部配送はこの確認では行わない。
8. 最初のActor作成またはoutbound前に、DB snapshotとsecret versionを同一復旧単位として記録する。失敗時もcanonical originやsecretを別値へ変更せず、forward fixまたは同一設定でrollbackする。

Cloud Buildがruntime変更前のvalidationで失敗した場合は、失敗buildを再承認せず、trigger、Scheduler identity、secret metadataを修正して最新`main`から新しいbuildを開始する。runtime rollout後に失敗した場合は、作成済みActor、queue、migration、revisionを確認してrollback判断を記録する。

## Fedify dependency / security advisory

Fedify関連packageは同一patchへ厳密固定する。更新は通常のdependency PRとして次を実施する。

1. Fedify公式changelog、GitHub Security Advisories、npm advisory、Node.js要件を確認し、対象CVE / GHSAと影響範囲をIssueへ記録する。
2. `packages/activitypub/package.json` と `apps/web/package.json` の `@fedify/*`、`pnpm-workspace.yaml` のoverride、`pnpm-lock.yaml` の直接・転移依存を同じversionへ更新し、Webの `next` versionとpeer dependencyの組合せも確認する。root `package.json` のNode engine契約も更新版の要件を満たすことを確認する。
3. local、Cloud Build CI（`node:24-bookworm`）、deploy / Job image（`node:22-bookworm`）、Firebase App Hosting（nodejs22以上）で `node --version` を確認し、root engine `>=22.6.0` または更新後Fedifyの要件を満たさないruntimeが1つでもあれば停止する。
4. `pnpm install --frozen-lockfile`、`pnpm audit --prod`、`pnpm test:activitypub`、`pnpm test:activitypub:db`、`pnpm test:activitypub:e2e`、`pnpm test:activitypub:web` を実行する。
5. WebFinger、HTTP Signature / Date、Follow / Accept / Undo、Create / Announce、queue serializer、SSRF / redirect / domain block、本文なしlogのcontract差分をレビューする。
6. stagingでproduction runtimeと同じNode.js versionを使い、外部送信なしのself-check後に通常のdeploy approvalへ進む。

advisory確認不能、breaking serializer変更、署名検証弱化、未解決high / criticalがある場合は更新またはrolloutを停止する。

## 月次コスト計測

毎月同じUTC期間とproject / region / service / job filterで次を記録し、前月とrolling 3か月baselineを比較する。

| 項目                | metric                                                                                                                                                                      | 記録値                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| ActivityPub request | `logging.googleapis.com/user/activitypub_request_count`（補助: `run.googleapis.com/request_count`）                                                                         | route kind / status class別count                        |
| dispatcher          | `logging.googleapis.com/user/activitypub_dispatcher_duration_ms`、`run.googleapis.com/container/billable_instance_time`、`run.googleapis.com/job/completed_execution_count` | 実行回数、p50 / p95 duration、billable instance seconds |
| PostgreSQL          | `logging.googleapis.com/user/activitypub_total_business_table_bytes`                                                                                                        | 月初 / 月末の最大値と増分bytes                          |
| egress              | `run.googleapis.com/container/network/sent_bytes_count`、`resource.type=cloud_run_job`、`kind=internet`                                                                     | ActivityPub dispatcherの送信bytes                       |

request数だけでなく、429 / 5xx、shared inbox率、queue depth、retry回数を併記して増加理由を説明する。DB増分は `activitypub_fedify_kv`、queue、instance config、actors、follows、activities、federated reports、operator audit tableの合計であり、本文を集計ログへ出さない。budget超過時はdispatcher頻度、batch上限、retention、retry、shared inbox利用を順に評価し、SLOや配送契約を変える場合は別changeとしてレビューする。

## Production deploy gate

本番有効化前の正規チェックは [Deploy Checklist](deploy-checklist.md) の「ActivityPub production gate」を使う。少なくともcanonical origin不変、NTP / UTC、署名検証、SSRF、domain block、PostgreSQL queue永続性、Actor key復旧、metrics / alertsを記録できないreleaseは承認しない。
