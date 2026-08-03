# GCP 固定費削減移行計画

- status: `completed`
- 作成日: 2026-08-01
- 親 Issue: [#663](https://github.com/dyson-yamashita/pufu-lens/issues/663)
- 対象 project / region / zone: `pufu-lens` / `asia-east1` / `asia-east1-b`

## 1. 目的

本番環境の可用性、PostgreSQL データ、認証情報を保護しながら、次の固定費を削減する。

| 対象                  | 現状                                           | 目標                        |    月額削減概算 |
| --------------------- | ---------------------------------------------- | --------------------------- | --------------: |
| Serverless VPC Access | `mastra-connector` (`e2-micro`, min 2 / max 3) | Direct VPC egress           |       約 $14.16 |
| 稼働 DB VM            | `pg-ai-cos` (`e2-medium`)                      | `e2-custom-small-3072` 相当 |       約 $10.86 |
| 停止済み旧 DB         | `pg-ai` と 20 GB boot disk `pg-ai`             | 削除                        |        約 $2.00 |
| 合計                  |                                                |                             | **約 $27 / 月** |

金額は 2026-08-01 時点の概算であり、実施後は Billing Report の 7 日間実績と対象リソースの消滅を使って確認する。

## 2. 現状と判断根拠

### 2.1 移行前リソース

- VPC Connector `mastra-connector`
  - network: `default`
  - CIDR: `10.8.0.0/28`
  - machine type: `e2-micro`
  - min / max instances: 2 / 3
- 稼働 DB VM `pg-ai-cos`
  - machine type: `e2-medium`
  - private IP: `10.140.0.3`
  - boot disk: `pg-ai-cos` (`autoDelete=true`)
  - data disk: `pg-ai-data` (`autoDelete=false`)
- 停止済み旧 VM `pg-ai`
  - 2026-07-15 から `TERMINATED`
  - 20 GB boot disk `pg-ai` のみ接続
  - data disk `pg-ai-data` は接続されていない
- firewall `pg-ai-allow-connector`
  - source: `10.8.0.0/28`
  - target tag: `pg-ai`
  - allow: TCP 5432

### 2.2 DB サイズ縮小の根拠

直近 17 日の観測値は次のとおりで、2 vCPU / 3 GiB の候補を試す余地がある。

- CPU: 平均約 0.9%、p95 約 2.9%、最大約 14.7%
- memory: 平均約 1.26 GB、最大約 1.47 GB

ただしピーク時間帯、scheduler、ingest、report 生成が重なる可能性があるため、縮小後の監視と明示的なロールバック条件を設ける。

### 2.3 公式仕様上の前提

- Cloud Run service / job は Connector なしの Direct VPC egress を利用できる。各 instance が subnet の IP を消費するため、最大 instance 数と job task 数から CIDR 容量を見積もる。
- Direct VPC では一時的な接続 reset が起こり得るため、DB client の retry / reconnect を検証する。
- Firebase App Hosting は `apphosting.yaml` の `vpcAccess.networkInterfaces` で Direct VPC egress を設定できる。
- Compute Engine の machine type 変更には VM の停止が必要である。
- DB snapshot は PostgreSQL の write を静止または flush した application-consistent な状態で取得する。

参考:

- [Cloud Run Direct VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)
- [Firebase App Hosting の VPC 接続](https://firebase.google.com/docs/app-hosting/vpc-network)
- [Compute Engine の machine type 変更](https://docs.cloud.google.com/compute/docs/instances/changing-machine-type-of-stopped-instance)
- [application-consistent Persistent Disk snapshot](https://docs.cloud.google.com/compute/docs/disks/creating-linux-application-consistent-pd-snapshots)

## 3. 移行後の構成

- Firebase App Hosting、Mastra Server、DB migration Job、workflow / dispatcher Job は、同じ専用 subnet を使う Direct VPC egress に統一する。
- egress は `PRIVATE_RANGES_ONLY` / `private-ranges-only` とし、外部 API 通信を VPC/NAT 経路へ変更しない。
- PostgreSQL の TCP 5432 は Direct VPC 専用 subnet の CIDR からだけ許可する。
- `mastra-connector` と `pg-ai-allow-connector` は、全 runtime の検証と soak 完了後に削除する。
- `pg-ai-cos` は `e2-custom-small-3072` で稼働し、`pg-ai-data` と private IP を維持する。
- 旧 `pg-ai` VM と boot disk `pg-ai` は存在しない。

## 4. 安全原則

1. **旧経路を先に消さない。** Direct VPC を追加し、全 runtime の疎通を確認するまで Connector と旧 firewall を維持する。
2. **変更を分割する。** Direct VPC、DB resize、旧リソース削除を同じ maintenance 操作にまとめない。
3. **DB の正を固定する。** resize と同時に schema、PostgreSQL image、data disk、private IP を変更しない。
4. **復旧可能にする。** resize 前に論理 backup と `pg-ai-data` snapshot を取得し、復元先と保持期間を記録する。
5. **secret を露出しない。** `DATABASE_URL` は host の一致だけをプロセス内で判定し、値を terminal、CI log、Issue、PR に出力しない。
6. **削除直前に対象を再解決する。** VM、disk、Connector、firewall の名前、状態、依存関係を read-only command で再確認する。
7. **各 Step を止められるようにする。** 成功条件を満たさなければ次 Step へ進まず、記載したロールバックを実施する。

## 5. Step と Issue 分割

親 Issue #663 は全体進捗と完了条件を管理する。当初は Step ごとの Issue / PR を想定したが、ユーザーから全 Step の本番実行と完了後 PR 作成が明示されたため、#663 と同一 branch / PR に実行記録を集約した。

| Step | 内容                                                                       | 状態        | Issue / PR   |
| ---- | -------------------------------------------------------------------------- | ----------- | ------------ |
| 1    | Direct VPC の設定契約、テスト、関連ドキュメントを更新                      | `completed` | #663 / 本 PR |
| 2    | 専用 subnet を作成し、全 runtime を Direct VPC へ切替、旧 Connector を廃止 | `completed` | #663 / 本 PR |
| 3    | DB backup / snapshot 後に `pg-ai-cos` を resize                            | `completed` | #663 / 本 PR |
| 4    | 旧 `pg-ai` VM / boot disk を削除し、削減結果を確認                         | `completed` | #663 / 本 PR |

Step 2〜4 は本番変更または削除を含むため、実行日時、担当者、対象 commit、対象 GCP project を記録し、開始前に明示的な本番作業確認を行う。

## 6. Step 1: 設定契約・テスト・ドキュメント

### 6.1 実装

- Cloud Build substitutions を Connector 固有の `_VPC_CONNECTOR` から `_VPC_NETWORK` / `_VPC_SUBNET` へ変更する。
- DB migration Job、Mastra Server、全 workflow / dispatcher Job に次を設定する。
  - `--network=<network>`
  - `--subnet=<subnet>`
  - `--vpc-egress=private-ranges-only`
- `apps/web/apphosting.yaml` と OSS example を `vpcAccess.networkInterfaces` へ変更する。
- Firebase CLI の固定版で Direct VPC 構文を deploy / dry-run できることを確認し、未対応なら builder image と `_FIREBASE_TOOLS_VERSION` を同じ PR で更新する。
- `scripts/infra-check.ts` の契約を `VPC_NETWORK` / `VPC_SUBNET` へ変更する。
- transition 中だけ必要な Connector fallback は Cloud Build の既定経路に残さず、rollback 手順として明示する。

### 6.2 自動検証

- deploy config test で、DB migration Job、Mastra Server、全 workflow / dispatcher Job に Direct VPC の 3 flag が付くことを検査する。
- App Hosting config test で `networkInterfaces`、network、subnetwork、`PRIVATE_RANGES_ONLY` を検査する。
- `infra:check` test で新しい環境変数を必須とし、`VPC_CONNECTOR` を要求しないことを検査する。
- resource 一覧を 1 箇所で定義し、Job の追加時に Direct VPC 設定漏れが test failure になるようにする。

実行する検証:

```bash
pnpm scripts:test
pnpm deploy:dry-run
pnpm format:check
pnpm lint
pnpm typecheck
```

### 6.3 完了条件

- Direct VPC の network / subnet が deploy input から全対象 resource まで伝播する。
- Connector 名を設定しなくても dry-run と test が成功する。
- Step 2 の provisioning、検証、rollback を運用ドキュメントだけで実施できる。

## 7. Step 2: Direct VPC への本番切替

### 7.1 事前検証

- `default` network の subnet / secondary range / route / peering と重複しない専用 CIDR を選ぶ。
- Cloud Run service の最大 instance 数と、同時実行される全 Job task 数に余裕を加えて必要 IP 数を計算する。
- subnet は `asia-east1` に作成し、Private Google Access、組織ポリシー、Direct VPC quota、`roles/compute.networkUser` の付与先を確認する。
- 現行 Connector、firewall、Cloud Run service/jobs、App Hosting の sanitized 設定を rollback 記録として保存する。
- `pg-ai-cos` の private IP と target tag が変わっていないことを確認する。

### 7.2 並行経路の作成

1. Direct VPC 専用 subnet を作成する。
2. 専用 subnet CIDR から target tag `pg-ai` の TCP 5432 だけを許可する firewall rule を追加する。
3. 既存 `pg-ai-allow-connector` と `mastra-connector` は残す。
4. Cloud Build trigger の substitutions を network / subnet へ更新する。

firewall に `default` subnet 全体を許可せず、専用 CIDR を source にする。可能なら Cloud Run revision / execution に network tag を付与して範囲をさらに限定するが、App Hosting を含む全 runtime で一貫して運用できるかを先に確認する。

### 7.3 切替順序

1. DB migration Job を Direct VPC へ変更し、DB 接続を伴う check を成功させる。
2. Mastra Server の新 revision を Direct VPC で deploy し、traffic 移行前後の error rate を確認する。
3. workflow / dispatcher Jobs を Direct VPC へ変更する。
4. Firebase App Hosting を Direct VPC へ変更する。
5. 全 resource の実設定を API で確認し、Connector annotation がないことを確認する。

最初の DB migration Job を疎通ゲートとし、失敗時は service / App Hosting を切り替えない。

### 7.4 本番検証

#### 構成検証

- `gcloud run services describe` で network、subnet、egress を確認する。
- `gcloud run jobs describe` で全 Job の network、subnet、egress を確認する。
- App Hosting backend の rollout と生成された Cloud Run revision の VPC 設定を確認する。
- `pnpm infra:check --env production` を成功させる。

#### 機能検証

- `pnpm deploy:smoke --env production` を成功させる。
- Web login、project 表示、private / public chat、report 表示を確認する。
- Admin data source ingest を 1 回実行する。
- DB migration Job、source sync dispatcher、report dispatcher、ingest workflow を各 1 回以上実行する。
- Scheduler を複数周期観測し、予定どおり Job が開始・完了することを確認する。

#### 障害・性能検証

- Cloud Logging で DB connection error、VPC error、timeout、403、instance startup failure を検索する。
- scale-to-zero 後または新 revision の cold start で DB 接続 retry / reconnect を確認する。
- subnet の IP 使用量と Direct VPC quota に余裕があることを確認する。
- 最低 30 分、可能なら 24 時間 soak し、error rate と主要 API latency が baseline から悪化していないことを確認する。

### 7.5 Connector 廃止

soak と全検証の完了後にのみ、次の順で実施する。

1. 全 resource が Direct VPC を使用し、Connector の利用者がないことを再確認する。
2. `mastra-connector` を削除する。
3. smoke、cold start、Scheduler を再確認する。
4. `pg-ai-allow-connector` を削除する。
5. 新 firewall が専用 subnet CIDR だけを許可していることを確認する。

### 7.6 ロールバック

- Connector 削除前: 対象 resource を記録済みの `mastra-connector` 設定へ戻して再 deploy する。
- Connector 削除後: 同じ network、CIDR `10.8.0.0/28`、machine type、min/max で Connector と firewall を再作成し、旧設定を再 deploy する。
- subnet IP 枯渇時: Connector fallback を優先し、場当たり的に firewall source を拡大しない。

## 8. Step 3: DB VM の resize

### 8.1 事前条件

- Direct VPC 移行が安定し、Connector 廃止後の問題がないこと。
- `e2-custom-small-3072` が `asia-east1-b` で利用可能であること。
- 7〜30 日分の CPU、memory、OOM、swap、container restart、DB connection、disk 使用量を記録済みであること。
- maintenance window を設定し、scheduler と write 処理を抑止または監視できること。
- 復旧担当者が論理 backup と snapshot の場所、保持期限、復元手順を確認済みであること。

### 8.2 backup

1. `pg_isready`、extension、schema migration、主要 row count、synthetic monitor の baseline を記録する。
2. PostgreSQL の論理 backup を取得し、restore command を dry-run 相当で検証する。
3. write を静止し、PostgreSQL / filesystem を flush して `pg-ai-data` の application-consistent snapshot を取得する。
4. snapshot の source disk、size、status、storage location、保持期限を記録する。
5. backup / snapshot が `READY` になるまで resize しない。

backup や secret の内容自体は Issue / PR / CI log に貼らない。

### 8.3 resize

1. `pg-ai-cos` を停止し、`TERMINATED` を確認する。
2. machine type を `e2-custom-small-3072` へ変更する。
3. machine type、boot disk、`pg-ai-data`、network interface、private IP、metadata が意図どおりであることを停止状態で確認する。
4. VM を起動し、startup script、disk mount、PostgreSQL container、health check を確認する。
5. Cloud Run / App Hosting の connection pool が再接続できることを確認する。

### 8.4 検証

- machine type が `e2-custom-small-3072` である。
- `pg-ai-data` が同じ mount point に接続され、private IP が変わっていない。
- `pg_isready`、extension、schema version、主要 row count が baseline と一致する。
- migration check、synthetic monitor、chat、report、ingest、Scheduler が成功する。
- PostgreSQL / OS log に OOM、filesystem、recovery、connection exhaustion error がない。
- CPU、memory、swap、container restart、DB connections、API latency を最低 60 分、できれば次の定期 Job 完了まで観測する。

### 8.5 ロールバック条件

次のいずれかに該当したら、追加調整を続けず `e2-medium` へ戻す。

- OOM kill または PostgreSQL container restart が発生する。
- memory 使用率が継続して 85% を超える、または swap による latency 悪化がある。
- CPU p95 が継続して 70% を超える。
- DB connection failure、connection pool exhaustion、主要 API latency の許容できない悪化がある。
- extension、schema、row count、disk mount に不整合がある。

ロールバックは VM を停止し、machine type を `e2-medium` に戻して起動する。data corruption が疑われる場合だけ、write を再開せず backup / snapshot からの復旧へ切り替える。

## 9. Step 4: 旧 VM / boot disk の削除と費用確認

### 9.1 削除ゲート

- `pg-ai` が `TERMINATED` のままである。
- 接続 disk は 20 GB boot disk `pg-ai` だけで、`pg-ai-data` は接続されていない。
- Cloud Run、Jobs、App Hosting、secret、運用手順が旧 VM / 旧 IP を参照していない。
- `DATABASE_URL` の host が現行 `pg-ai-cos` の private IP と一致することを、値を出力せず判定できている。
- boot disk に復旧不能な mutable data がない。予期しない data があれば削除を中止し、保全用 Issue を作る。
- 現行 VM `pg-ai-cos` と data disk `pg-ai-data` が削除対象に含まれていない。

### 9.2 削除と検証

1. 実行直前に project、zone、VM 名、disk 名、auto-delete 設定を再確認する。
2. 旧 VM `pg-ai` を削除し、auto-delete の 20 GB boot disk `pg-ai` が削除されたことを確認する。
3. `pg-ai-cos` と `pg-ai-data` が存在し、稼働していることを確認する。
4. smoke、chat、report、ingest、Scheduler を再確認する。

旧 boot disk はアプリデータの正ではないため、必要時は COS image、`infra/gcp/postgres-startup.sh`、sanitized metadata から VM を再作成する。予期しない mutable data が見つかった場合は削除せず、復旧方針を別途決める。

### 9.3 費用確認

- `mastra-connector`、旧 firewall、旧 VM、20 GB boot disk が存在しないことを resource inventory で確認する。
- `pg-ai-cos` の machine type が目標値であることを確認する。
- 実施後 7 日の Billing Report で Serverless VPC Access、Compute Engine core / RAM、Persistent Disk の実績を実施前 7 日と比較する。
- traffic や実行回数の差を注記し、概算 $27 / 月との差を説明する。
- snapshot の保持費用を削減効果から差し引き、保持期限到来時に削除判断を行う。

## 10. ドキュメント更新マトリクス

Step 1 の実装 PR で、実装とドキュメントを同時に更新する。Step 2〜4 の本番結果は運用記録と plan status に反映する。

| 対象                                                      | 必要な変更                                                     | 更新 Step |
| --------------------------------------------------------- | -------------------------------------------------------------- | --------- |
| `.env.example`                                            | `VPC_CONNECTOR` を network / subnet の設定契約へ置換           | 1         |
| `apps/web/apphosting.yaml`                                | `connector` を `networkInterfaces` へ変更                      | 1         |
| `deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml`  | 全 service / job を Direct VPC flag へ変更                     | 1         |
| `deploy/examples/gcp-cloud-build/apphosting.example.yaml` | OSS 用 Direct VPC 例へ変更                                     | 1         |
| `deploy/examples/gcp-cloud-build/README.md`               | substitutions、IAM、subnet、firewall、rollback を更新          | 1         |
| `docs/deployment/gcp-cloud-build.md`                      | provisioning、切替順序、検証、troubleshooting、rollback を更新 | 1         |
| `docs/operations/deploy-checklist.md`                     | Direct VPC、backup、resize、削除、結果記録欄を追加             | 1         |
| `docs/designs/system/11-deployment.md`                    | 正準構成を Direct VPC と縮小後 VM へ更新                       | 1         |
| `docs/designs/system/13-cost.md`                          | Connector 廃止、VM、disk、月額見積もりを更新                   | 1 / 4     |
| `docs/designs/system/07-chat.md`                          | DB machine type の記述を更新                                   | 1         |
| `.codex/skills/gcp-deploy/SKILL.md`                       | 新規環境でも Connector を再作成しない手順へ更新                | 1         |
| `scripts/infra-check.ts` と関連 test                      | Direct VPC の設定・実リソース検査へ更新                        | 1         |
| `docs/plans/plan-status.md`                               | Step / Issue / PR と完了状態を記録                             | 各 Step   |

GCP architecture diagram を正式に tracked artifact とする場合は、Connector node を Direct VPC / 専用 subnet へ変更し、元データから PNG / SVG を再生成する。現在の未追跡 diagram はユーザー作業として保護し、この計画書 PR では変更しない。

UI 変更はないため `docs/designs/ui/*` と画面キャプチャは対象外とする。

## 11. 各 Step 共通の記録

Issue または運用記録には secret を含めず、次を残す。

- 実施日時、担当者、project / region / zone
- 対象 commit、Cloud Build ID、App Hosting rollout ID
- 変更前後の sanitized resource 設定
- backup / snapshot の識別子、status、保持期限
- 実行した check、smoke、synthetic monitor と結果
- soak 時間、CPU / memory / error / latency の結果
- ロールバックの要否と判断根拠
- 削除した resource と削除後 inventory
- 実施前後の費用比較

## 12. 全体完了条件

- 全 App Hosting / Cloud Run service / Cloud Run Jobs が Direct VPC で private PostgreSQL へ接続できる。
- `mastra-connector` と `pg-ai-allow-connector` が削除されている。
- `pg-ai-cos` が `e2-custom-small-3072` で安定稼働し、ロールバック条件に抵触しない。
- 旧 `pg-ai` VM と 20 GB boot disk `pg-ai` が存在しない。
- DB data、schema、AGE / pgvector / PGroonga、auth、chat、report、ingest、Scheduler に回帰がない。
- 実装、deploy 設定、system design、operation docs、OSS example、deploy skill に Connector 前提の drift が残っていない。
- 実施内容、backup / snapshot、検証、削減後費用が追跡可能な形で記録されている。

## 13. 実施結果（2026-08-03）

### 13.1 Direct VPC egress

- `default` network の `asia-east1` に専用 subnet `pufu-lens-serverless`（`10.9.0.0/25`、Private Google Access 有効）を作成した。
- firewall `pg-ai-allow-direct-vpc` は source `10.9.0.0/25`、target tag `pg-ai`、TCP 5432 のみに限定した。
- Mastra Server、Firebase App Hosting、DB migration、workflow / dispatcher の全 9 Job を `private-ranges-only` の Direct VPC へ移行した。全 resource で Connector annotation がないことを API から確認した。
- production Cloud Build trigger は `_VPC_NETWORK=default`、`_VPC_SUBNET=pufu-lens-serverless`、Firebase Tools `15.25.1` へ更新した。
- App Hosting rollout `pufu-lens-web-build-2026-08-03-001` と Mastra revision `mastra-server-00093-6zd` が 100% traffic で Ready になった。
- 公開 Projects、Overview、Reports、Chat、Graph をブラウザで確認し、Graph は 50 documents / 280 rows を取得した。browser console の warning / error は 0 件だった。
- source sync / report schedule Dispatcher の 5 分周期を複数回確認し、切替後も連続成功した。切替後 30 分の soak で Cloud Run revision / Job の error log は 0 件だった。
- 全利用者が Direct VPC であることを再確認後、`mastra-connector` と `pg-ai-allow-connector` を削除した。削除後の DB migration execution `db-migrate-mwlmv` が成功した。

### 13.2 PostgreSQL VM resize

- resize 前に `pg_isready`、PostgreSQL 18.1、projects 3 件、reports 9 件を baseline として記録した。
- 論理 backup `gs://pufu-lens-prod/backups/postgres/pufu-lens-pre-resize-20260803T011606Z.dump` を作成した。size は 44,489,515 bytes、SHA-256 は `ffa340913ece35b2722738881cf6667052e8b51b4f87345f15e37ebfd4cee5cb` で、`pg_restore --list` が成功した。
- VM 停止後に data disk snapshot `pg-ai-data-pre-resize-20260803t014704z` を作成し、50 GB、`asia-east1`、`READY` を確認した。`retain-until=2026-08-10` label を付け、安定確認後に削除判断する。
- `pg-ai-cos` を `e2-medium` から `e2-custom-small-3072`（2 vCPU / 3,072 MiB）へ変更した。data disk `pg-ai-data`、private IP `10.140.0.3`、PostgreSQL image / schema は変更していない。
- 起動後に PostgreSQL 18.1、AGE、pgvector、PGroonga、projects 3 件、reports 9 件、data disk 接続を確認した。container memory limit は 2.908 GiB、確認時の使用量は約 51 MiB だった。
- resize 後の DB migration execution `db-migrate-jbtkg` と公開 Projects 表示が成功した。60 分の post-resize soak では Cloud Run / Job / GCE error log、OOM、container restart は 0 件だった。最終確認時は CPU 0%、memory 約 89 MiB / 2.908 GiB で、rollback 条件に該当しなかった。

### 13.3 旧 VM / disk 削除と最終 inventory

- 削除直前に旧 `pg-ai` が `TERMINATED`、接続 disk が 20 GB `pd-balanced` boot disk `pg-ai` だけ、`autoDelete=true` であることを確認した。
- `DATABASE_URL` は値を表示せず、host が現行 VM の `10.140.0.3` と一致することだけを判定した。
- 旧 `pg-ai` VM を削除し、boot disk `pg-ai` も削除された。
- 最終 Compute inventory は `pg-ai-cos`（`RUNNING`、`e2-custom-small-3072`、`10.140.0.3`）、boot disk `pg-ai-cos` 20 GB、data disk `pg-ai-data` 50 GB のみである。
- Serverless VPC Access Connector は 0 件。PostgreSQL firewall は Direct VPC 用 `pg-ai-allow-direct-vpc` と IAP 管理用 `pg-ai-allow-iap` のみである。

### 13.4 検証結果

- `pnpm scripts:test`: 151 tests、147 pass / 4 skip / 0 fail
- `pnpm deploy:dry-run`: pass
- `pnpm format:check`: pass
- `pnpm lint`: pass
- `pnpm typecheck`: pass
- `db-migrate-64n78`、`db-migrate-mwlmv`、`db-migrate-jbtkg`: success
- Direct VPC 切替後の Cloud Run / GCE error log: 0 件
- `pnpm infra:check --env production`: pass（identifier / provider contract のみ。secret 値は使用・出力していない）
- post-resize 60 分 soak: Dispatcher 12 周期以上 success、PostgreSQL restart 0、error log 0 件
- 概算削減額: 約 $27 / 月。実績値は 2026-08-10 以降に Billing Report の前後 7 日を比較する。
