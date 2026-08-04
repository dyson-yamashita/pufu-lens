# ActivityPub レポート連携計画

## 1. 概要

Pufu Lens の公開レポートを ActivityPub で配送し、別の Pufu Lens または Mastodon から購読できるようにする。ローカル project ごとに Actor を公開し、インスタンス内の全 project を購読する入口として集約 Actor `@all` も公開する。

ActivityPub のプロトコル処理には Fedify を利用する。Actor、follow、activity、外部 report、配送状態の正本は Pufu Lens の PostgreSQL に置き、配送は既存の source sync / report schedule dispatcher と同じ one-shot、DB lease、heartbeat、bounded retry の運用モデルへ統合する。

- tracking Issue: [#665](https://github.com/dyson-yamashita/pufu-lens/issues/665)
- status: `planned`
- 対象 runtime: Next.js 16 on Firebase App Hosting、Cloud Run Jobs、PostgreSQL

## 2. ゴール

MVP の完了条件は次のとおりとする。

1. 公開かつ federation を有効化した project を ActivityPub Actor として解決できる。
2. `@all` をフォローすると、そのインスタンスで federation を有効化した全 project の新規公開レポート通知を受け取れる。
3. project Actor をフォローすると、その project の新規公開レポート通知だけを受け取れる。
4. Pufu Lens Actor と Mastodon user の双方から Follow / Undo を行える。
5. 別の Pufu Lens Actor を project 単位で購読し、受信した report を「外部レポート」として参照できる。
6. 配送失敗が Web request をブロックせず、lease、retry、重複排除、監査可能な状態を PostgreSQL に保持する。
7. Mastodon から Actor を検索・followでき、home timeline に title、summary、report URL を表示できる。Step 6 の実機互換性確認を通過するまで MVP は完了しない。

## 3. MVP の対象外

- reply、Like、EmojiReact、Mastodon の boost 操作
- followers-only、direct message、非公開 report の federation
- Mastodon REST API、OAuth、Mastodon client から Pufu Lens へログインする機能
- 外部 report を data source、graph、embedding、chat、report 生成材料へ自動投入する機能
- report 更新・削除の `Update` / `Delete` / `Undo(Announce)` 配送
- remote media の proxy、thumbnail、link preview
- Cloudflare Workers、Cloudflare KV、Cloudflare Queues の本番導入
- ActivityPub C2S API

更新・削除は canonical report URL の表示結果には反映されるが、remote timeline 上の既配信項目を同期する契約は後続 Step とする。

## 4. Actor と activity の設計

### 4.1 Actor の単位

Actor はサーバーそのものではなく、サーバー上でフォローされる主体とする。

| Pufu Lens の概念           | ActivityPub                          | 用途                             |
| -------------------------- | ------------------------------------ | -------------------------------- |
| federation-enabled project | `Service` Actor                      | project 単位の report 配信と購読 |
| instance aggregate         | `Service` Actor `@all`               | 全 project report の集約配信     |
| public report              | `Article`                            | report の canonical object       |
| report 公開                | `Create(Article)`                    | project Actor の follower へ通知 |
| 集約配信                   | `Announce(Article)`                  | `@all` の follower へ通知        |
| 購読                       | `Follow` / `Accept` / `Undo(Follow)` | 独立した片方向の購読関係         |

project Actor の `preferredUsername` は専用 DB row に保存し、初期値は project slug とする。`all` は集約 Actor 用の予約名とし、衝突する場合は project の federation 有効化時に別名を明示する。username のインスタンス内一意性、集約 Actor が最大1件であること、project Actor が project ごとに最大1件であることは application の事前確認だけに依存せず DB 制約で保証する。公開後の Actor ID、username、canonical origin は remote follow を壊すため変更不可として扱う。

### 4.2 URL 契約

```text
acct:{preferredUsername}@{canonicalHost}
https://{canonicalHost}/activitypub/actors/{preferredUsername}
https://{canonicalHost}/activitypub/actors/{preferredUsername}/inbox
https://{canonicalHost}/activitypub/actors/{preferredUsername}/outbox
https://{canonicalHost}/activitypub/actors/{preferredUsername}/followers
https://{canonicalHost}/activitypub/actors/{preferredUsername}/following
https://{canonicalHost}/activitypub/reports/{reportId}
https://{canonicalHost}/activitypub/inbox
```

WebFinger は `acct:` resource から Actor URL を返す。Actor と `Article` は `Accept` による content negotiation で ActivityStreams JSON-LD を返し、通常の HTML report URL は既存の `/reports/public/{projectSlug}/{reportId}` を canonical user-facing URL とする。

### 4.3 配信契約

report 公開 transaction は `projects.visibility = 'public'` と `reports.is_public = true` を確認または更新し、同じ transaction 内で project Actor の一意な `Create(Article)` outbox row と `@all` Actor の一意な `Announce(Article)` outbox row を登録する。commit 後に dispatcher が outbox row から Activity を materialize して配送し、Web request は Activity の生成や remote HTTP response を待たない。

- `Article.id`: Pufu Lens 内で不変な ActivityPub report URL
- `Article.attributedTo`: project Actor URL
- `Article.name`: report title
- `Article.content`: HTML sanitize 済みの短い概要
- `Article.url`: 既存の public report URL
- `Article.published`: report の公開時刻
- `to`: ActivityStreams Public collection
- `cc`: project Actor の followers collection

同じ report に対して `@all` Actor は新しい Article を作らず、project Actor の canonical `Article` を object とする `Announce` を生成する。`Announce.actor` は `@all` Actor、`object` は canonical `Article`、`to` は ActivityStreams Public collection、`cc` は `@all` Actor の followers collection とする。recipient が shared inbox を公開している場合は remote shared inbox URL を優先し、未対応なら personal inbox へ fallback する。

同じ remote Actor が project Actor と `@all` の両方をフォローしている場合は `Create` を優先し、その remote Actor 向けの `Announce` delivery を作らない。異なる remote Actor が同じ server 上でそれぞれ project Actor と `@all` をフォローしている場合は、必要な audience を欠落させないよう両 Activity を shared inbox へ配送してよい。受信側 Pufu Lens は同じ project 内の `remote_object_uri` で統合する。この Actor 単位の優先規則、shared inbox の disjoint audience、受信側の object dedupe を fixture で固定する。

remote client の `Article` 表示互換性は Mastodon 実機で確認し、Step 6 を MVP completion の blocking gate とする。Mastodon の home timeline で title、summary、report URL を表示できなければ MVP は未完了とする。fallback は同じ stable object URI を使う `Create(Note)` と `Announce(Note)` へ instance 全体で切り替え、`Note.content` に title、summary、report URL を含める方式とする。`Article` と `Note` は二重配信せず、fallback 採用時は Actor / object contract、受信 mapping、fixture、Mastodon E2E を更新してから MVP 完了とする。

## 5. Fedify の責務と境界

### 5.1 Fedify に任せるもの

- `@fedify/next` による Next.js 16 との統合と content negotiation
- WebFinger、Actor、object、collection の dispatcher
- ActivityStreams vocabulary の serialize / parse
- HTTP Signature / HTTP Message Signature と Actor key の利用
- remote Actor / object の lookup と署名検証
- inbox listener の Activity 型 dispatch
- shared inbox の解決と signed POST
- Fedify document loader が行う private / loopback address 拒否

### 5.2 Pufu Lens に残すもの

- project の公開可否、federation 有効化、Actor username の業務ルール
- Actor key pair の暗号化永続化と rotation 方針
- follower / following、activity、external report、delivery の正本
- report 公開 transaction と activity enqueue の transactional outbox
- project membership による管理 UI / server action 認可
- HTML sanitize、block domain、rate limit、監査ログ
- delivery dispatcher の claim、lease、heartbeat、retry、運用メトリクス

Fedify の `MemoryKvStore` と `InProcessMessageQueue` は test 以外で使わない。Fedify が必要とする cache / idempotency state は PostgreSQL-backed KV を使う。業務データを Fedify の KV に保存しない。

Fedify 関連 package は SSRF 修正を含む同一 patch 版へ揃える。初期実装では 2026-08-04 時点の `@fedify/fedify`、`@fedify/next`、`@fedify/postgres`、`@fedify/vocab-runtime` の `2.3.4` を caret なしで完全固定し、lockfile 上の転移依存も 2.3.4 へ収束させる。少なくとも IPv4-mapped IPv6 bypass 修正を含む `@fedify/vocab-runtime >= 2.2.1`、special-use / tunneling address 修正を含む `>= 2.2.4`、NodeInfo redirect SSRF 修正を含む `@fedify/fedify >= 2.2.7` を下回る解決を禁止する。version 更新時も security changelog と lockfile の解決結果を同時確認する。

### 5.3 queue 統合方針

本番で `sendActivity(..., { immediate: true })` は使わない。Web request 内の同期配送も行わない。Web process が構築する Federation は常に `manuallyStartQueue: true` とし、`startQueue()` と queue task processor を呼ばない。queue consumer の開始または manual task 処理は `activitypub-dispatcher` Job entrypoint だけに限定する。

Pufu Lens の PostgreSQL queue adapter を Fedify の `MessageQueue` 契約に合わせて実装し、Fedify が生成する inbox / outbox message を `activitypub_queue_messages` に保存する。adapter は backend 側で retry を管理することを Fedify へ示し、Fedify retry と Pufu Lens retry の二重適用を防ぐ。Fedify version を固定し、adapter の enqueue、serialize、manual process 契約を contract test で保護する。

one-shot `activitypub-dispatcher` は due message を `FOR UPDATE SKIP LOCKED` で claim し、Fedify の queue task processor へ渡す。Cloudflare Workers の `queue()` handler と `processQueuedTask()` を使う構造には似ているが、binding は Cloudflare Queues / KV ではなく PostgreSQL であり、起動は Cloud Scheduler → 内部 OIDC API → Cloud Run Job とする。

## 6. データモデル

実装 Step では `infra/docker/postgres/init.sql` と migration を同時更新する。名称は実装時の既存命名規則に合わせられるが、責務は次の単位に分離する。

### 6.1 `activitypub_actors`

- `id`
- `project_id` nullable。集約 Actor は `NULL`
- `kind`: `project` / `aggregate`
- `preferred_username`
- `display_name`
- `enabled`
- `public_key_pem`
- `encrypted_private_key`
- `created_at` / `updated_at`

fresh DB の `init.sql` と migration の両方に次の制約を同じ定義で追加する。

- `preferred_username` の instance 内 `UNIQUE`
- `kind = 'aggregate'` を最大1件にする partial unique index
- `kind = 'project'` の `project_id` を一意にする partial unique index
- `(kind = 'aggregate' AND project_id IS NULL) OR (kind = 'project' AND project_id IS NOT NULL)` の `CHECK`
- aggregate Actor では `preferred_username = 'all'`、project Actor では `preferred_username <> 'all'` とする `CHECK`

project Actor は public project だけ有効化できる。この公開可否は transaction 内の project row lock と repository guard で検証する。秘密鍵の平文、PEM 全文、署名 header はログへ出さない。

### 6.2 `activitypub_follows`

- `id`
- `direction`: `inbound` / `outbound`
- `local_actor_id`
- `remote_actor_uri`
- `remote_inbox_uri`
- `remote_shared_inbox_uri` nullable
- `follow_activity_uri`
- `status`: `pending` / `accepted` / `rejected` / `undone`
- `created_at` / `accepted_at` / `undone_at` / `updated_at`

`direction + local_actor_id + remote_actor_uri` を一意にし、同じ Follow / Accept / Undo の再送を冪等に処理する。outbound follow の local Actor が project Actor の場合、受信 report の表示先 project はその `project_id` とする。

### 6.3 `activitypub_activities`

- `id`
- `activity_uri` unique
- `object_uri` nullable
- `activity_type`
- `actor_uri`
- `local_actor_id` nullable
- `direction`: `inbound` / `outbound`
- `payload_json`
- `processing_status`: `pending` / `running` / `processed` / `failed`
- `available_at`
- `worker_token` / `lease_expires_at` nullable
- `occurred_at` / `processed_at`

outbound row は report 公開 transaction 内で `pending` として作る transactional outbox でもある。payload は size limit 適用後の監査・再処理用とし、remote HTML は表示時に直接信用しない。`activity_uri` と `object_uri` で重複配送を排除する。

### 6.4 `activitypub_queue_messages`

- `id`
- `dedupe_key` unique
- `queue_kind`: `inbox` / `outbox`
- `ordering_key` nullable。outbox では必須
- `recipient_origin` nullable。outbox では必須
- `message_json`
- `status`: `pending` / `running` / `retry_wait` / `succeeded` / `retry_exhausted` / `permanent_failure`
- `available_at`
- `attempt_count`
- `worker_token` nullable
- `lease_expires_at` nullable
- `last_error_code` nullable
- `last_http_status` nullable
- `created_at` / `started_at` / `completed_at` / `updated_at`

`worker_token` と `lease_expires_at` は同時に NULL または非 NULL とする。outbox の `dedupe_key` は少なくとも `activity_uri + recipient_inbox_uri` から決定論的に作り、activity materialize 後・処理済み更新前に worker が停止しても同じ delivery message を増やさない。`ordering_key` は object URI、`recipient_origin` は remote inbox の origin を正規化して保存し、Fedify の queue enqueue と delivery 処理へ同じ `orderingKey` を伝搬する。message payload に private key、OAuth token、credential を入れず、処理時に Actor ID から解決する。

### 6.5 `federated_reports`

- `id`
- `project_id`
- `source_follow_id`
- `remote_object_uri`
- `remote_activity_uri`
- `remote_actor_uri`
- `object_type`
- `title`
- `summary_html_sanitized`
- `original_url`
- `published_at` / `remote_updated_at` nullable
- `received_at`

`project_id + remote_object_uri` を一意にする。`Announce` は announced object を Fedify の安全な document loader で解決し、`Article` と同じ内部形式へ変換する。外部 report は private project 内の参照データとして保存できるが、MVP では ingestion pipeline へ流さない。

## 7. dispatcher、lease、retry

### 7.1 transactional outbox と配送 queue

report 公開から remote delivery までは次の二段階に分ける。

1. report を public にする transaction 内で、project Actor の `Create` と集約 Actorの `Announce` を決定論的な `activity_uri` を持つ `activitypub_activities` outbound rowとして登録する。
2. dispatcher が pending activity を lease付きでclaimし、activity発生時点でacceptedだった followerを解決してFedifyへ渡す。followの `accepted_at` / `undone_at` を使い、公開後にfollowしたActorへ過去activityをpushしない。
3. Fedify の PostgreSQL queue adapter は delivery 単位の決定論的な `dedupe_key`、object 単位の `ordering_key`、正規化した `recipient_origin` で `activitypub_queue_messages` を upsert し、Fedify へ `orderingKey` を渡す。
4. activityに必要なdelivery messageがすべて永続化された後だけ、outbound activityを `processed` にする。
5. 別claimでdelivery messageをFedify queue task processorへ渡し、成功またはretry状態を更新する。

これにより、report transactionのrollbackではactivityが残らず、各段階のprocess停止では同じactivityまたはdeliveryを安全に再claimできる。DB commitとremote HTTP POSTを同一transactionに見せかけず、remote側の重複受信も同じ `activity.id` で冪等に扱える前提とする。

### 7.2 起動と上限

- Cloud Scheduler が1分または5分ごとに `POST /internal/schedules/activitypub-dispatcher:run` を designated Scheduler service account の OIDC token 付きで呼ぶ。OIDC audience は Mastra internal service の固定 URL とし、route は issuer、audience、subject / email allowlist を検証する。
- Scheduler service account には対象 Mastra service だけの `roles/run.invoker` を付与する。Mastra runtime service account には対象 `activitypub-dispatcher` Job だけの `run.jobs.run` / `run.jobs.runWithOverrides` 相当権限を付与し、他 Job や resource への権限を広げない。
- Mastra Server は body が空 object であることを検証し、同じ Job の active execution を検出した場合は新規起動せず accepted no-op として扱い、active でなければ `activitypub-dispatcher` Cloud Run Job を起動する。active execution 検出と DB lease の両方で duplicate run を防ぐ。
- Job entrypoint は `--once` だけを受け付け、それ以外の引数や常駐 queue consumer 起動を拒否する。1 run 最大100 messageまたは開始から45分の早い方で新規 claim を停止する。
- Cloud Run Job timeout は55分とし、10分を後処理に確保する。
- inbox / outbox は公平に claim し、一方の大量流入で他方を飢餓させない。

件数と間隔は負荷試験後に確定する。最初は既存の5分 Schedulerへ統合せず、ActivityPub backlogと失敗を独立観測できる専用 dispatcher とする。

### 7.3 claim と heartbeat

- `available_at <= now()` の message を `FOR UPDATE SKIP LOCKED` で候補にする。同じ `ordering_key + recipient_origin` に、より古い `created_at + id` を持つ未完了 message がある候補は claim しない。
- claim 時にランダムな `worker_token` と15分の leaseを設定する。
- 処理中は heartbeat で leaseを延長するが、開始から最大60分を超えない。
- 完了 / 失敗更新は message ID、worker token、非期限切れ lease の一致を必須とする。
- leaseを失った worker は成功・失敗状態を更新せず、後続 worker の結果を上書きしない。
- 同じ ordering sequence の先行 message が `succeeded` になるまで後続を配送しない。先行 message が `retry_exhausted` / `permanent_failure` へ遷移した場合は、後続を送らず同じ安全な failure 分類で終端させ、Create を欠いた Update / Delete を remote へ送らない。

### 7.4 retry と permanent failure

retry delay は初期値として1分、5分、30分、2時間、12時間を使い、最大5回後に `retry_exhausted` とする。network error、timeout、HTTP 408、429、5xx を retry 対象とし、`Retry-After` が安全な上限内なら優先する。404 / 410 は inbox消滅として `permanent_failure`、その他の4xxは分類をテストで固定する。

同じ remote origin への同時配送数を制限し、shared inbox がある場合は remote server 単位でまとめる。Create と将来の Update / Delete は同じ object URI を `orderingKey` として enqueue し、queue adapter が `ordering_key + recipient_origin` ごとに直列化する。

保存する error は分類 code、HTTP status、attempt、remote origin までとし、response body、署名、payload 本文、PII をログへ出さない。

## 8. 受信・セキュリティ

- federation endpoint は HTTPS の canonical origin だけを公開する。
- Fedify の signature verification と signature time window を本番で無効化しない。
- `allowPrivateAddress` と benchmark mode を本番で有効化しない。
- application 独自の remote fetch にも public URL validation を適用し、redirect は各 hop を再検証する。
- localhost、loopback、link-local、RFC 1918、IPv6 ULA、cloud metadata endpoint を拒否する。
- inbox body、JSON-LD document、HTML、collection page 数、redirect 数、remote response time に上限を設ける。
- remote `content` / `summary` は allowlist sanitize し、script、event handler、危険 URL scheme を除去する。
- external image はMVPで取得・直接表示しない。
- local Actor、remote Actor、activity ID、object ID の origin / attribution 整合を検証する。
- domain blocklist、Actor block、per-origin rate limitを導入できる repository 境界を用意する。
- unknown Activity は成功応答後に無視せず、bounded な監査 metadata を残して副作用なしで終了する。

private project や non-public report の存在は federation endpoint から区別できない `404` とする。project admin の federation 設定変更は既存 authz moduleを通し、server actionにSQLや鍵操作を置かない。

Activity型ごとの attribution は分けて検証する。`Create(Article)` は Createのactor、Articleの`attributedTo`、購読中remote Actorが一致することを要求する。`Announce(Article)` はAnnounceのactorが購読中remote Actorと一致することを要求するが、Articleの`attributedTo`は別Actorでもよい。後者は `@all` の正規集約動作に必要であり、dereferenceしたArticle自身のID origin、author、public addressing、canonical URLの整合を別途検証する。

## 9. UI と利用フロー

### 9.1 project federation 設定

project admin は project settings で次を管理する。

- federation の有効 / 無効
- Actor username、Actor address、公開プロフィール
- follower / following 件数と状態
- remote Actor address を入力する outbound Follow / Undo
- delivery backlog、最終成功、retry exhausted の安全な要約

一般 member は Actor address と購読状態を読み取り専用で確認する。private project では有効化操作を表示しない。

### 9.2 外部レポート

project report 一覧に「自分のレポート」と「外部レポート」を分けて表示する。外部レポートは title、source Actor、domain、published time、sanitized summary、original URLだけを表示し、Pufu Lens 内の report ID や public report と誤認させない。

外部 URL は明示操作で開き、`rel="noopener noreferrer"` を付ける。remote HTML、image、scriptをそのまま埋め込まない。

## 10. 実装 Step

各 Step の着手時に最新 `main` から Issue / branch / PR を分け、完了時にこの plan と `plan-status.md` を更新する。

### Step 1: Fedify integration spike と protocol contract

成果物:

- Fedify 関連 package を同一 patch `2.3.4` へ完全固定し、`@fedify/fedify`、`@fedify/next`、`@fedify/postgres`、`@fedify/vocab-runtime`、PostgreSQL KV / queue adapter の境界を決定
- Next.js 16 / Firebase App Hosting の Node runtime、middleware / proxy、canonical origin の疎通確認
- Actor / report / inbox route、identifier、Activity ID のcontract test
- manual queue processing と one-shot dispatcher の小さな実証

受け入れ条件:

- local fixture で WebFinger → Actor → Article を解決できる
- queue messageをDBへ保存し、別processのone-shot処理でsigned deliveryできる
- process restart後もkey、idempotency、queue messageが維持される
- lockfile 上の Fedify 関連転移依存が同一 patch へ収束し、SSRF 修正 version の下限を下回らない
- `http://[::ffff:7f00:1]/`、special-use / tunneling address、public URL から private address へ遷移する redirect を各 hop の再検証で拒否する
- Web process だけを起動する fixture で queue worker が開始されず、`startQueue()` / queue task processor が Job 以外から呼ばれない
- unsupported Fedify APIや runtime制約が判明した場合、Step 2前に設計を更新する

### Step 2: schema、Actor、鍵管理、公開 endpoint

成果物:

- Actor / follow / activity / queue / federated report の migration、fresh DB schema、runtime guard
- aggregate `@all` と project Actor のrepository / use-case
- WebFinger、Actor、followers、following、outbox、Article object dispatcher
- project admin の federation enable / disable API

受け入れ条件:

- `@all` と public project Actor をremote lookupできる
- private / disabled project は一貫して404になる
- 鍵がActor単位で一度だけ生成・暗号化保存され、再起動で変わらない
- `init.sql` と migration の Actor 制約が同期し、aggregate 重複、project 重複、username 衝突、kind / project 不整合を DB で拒否する
- project越境、不正slug、平文key logをテストで拒否する

### Step 3: Follow / Accept / Undo と購読管理

成果物:

- personal / shared inbox listener
- inbound Follow の保存と Accept 配送
- outbound Follow、Accept受信、Undo(Follow)
- follower / following collection pagination
- project settings の購読管理 UI

受け入れ条件:

- Pufu Lens A / B の片方向および相互followが成立する
- Mastodonからproject Actor / `@all` を検索・follow・unfollowできる
- duplicate / reordered Follow、Accept、Undo が冪等になる
- 非adminはoutbound follow設定を変更できない

### Step 4: 公開 report の transactional enqueue と outbound delivery

成果物:

- report公開transactionと同時にCreate / Announceの業務outboxを登録
- `Create(Article)` と `Announce(Article)` の生成
- shared inbox対応、recipient dedupe、dispatcher、lease、heartbeat、retry
- Cloud Scheduler、内部OIDC route、Cloud Run Job、workflow job entrypoint

受け入れ条件:

- DB commit前やrollback時にactivityを配送しない
- report公開可否の変更とCreate / Announce outbox row登録が同じtransactionでcommitまたはrollbackされる
- project followerにはCreate、`@all` followerにはAnnounceが届く
- 同じ remote Actor が project Actor と `@all` を follow する fixture では Create だけを配送し、異なる Actor が同じ shared inbox を使う fixture では必要な audience を欠落させない
- public解除前のprivate report、disabled projectはenqueueされない
- ordering key が同じ後続 message は先行成功まで claim されず、先行の終端失敗後も配送されない
- designated Scheduler identity / 固定 audience 以外を拒否し、active execution 時は no-op、Job は `--once` 以外を拒否する
- crash、timeout、429、5xx、lease expiry、duplicate起動のfixtureで欠落・二重副作用がない

### Step 5: inbound report と外部レポート表示

成果物:

- inbound `Create(Article)` / `Announce(Article)` の検証、dereference、内部mapping
- `federated_reports` repository と project-scoped query
- 外部レポート一覧 UI
- sanitize、size limit、block domain、original URL安全表示

受け入れ条件:

- project Actorがfollowしたremote ActorのArticleだけが対象projectへ保存される
- `@all` のAnnounceからcanonical Articleを1回だけ保存できる
- unrelated Actor、spoofed attribution、private address、unsafe HTMLを拒否する
- 外部reportがchat / graph / report生成候補へ混入しない

### Step 6: Mastodon / 2-instance E2E と互換性固定

成果物:

- Pufu Lens 2台とMastodonを使うE2E手順または再現可能なtest environment
- search、follow、Accept、Create / Article表示、Announce、Undoの互換性結果
- Fedify CLI / ActivityPub test toolを使うfixtureとfailure test
- Articleのrendering差異と採用したfallback判断の記録

受け入れ条件:

- 2台のPufu Lensでproject Actor / `@all` の購読シナリオが完走する
- Mastodon home timelineからtitle、summary、Pufu Lens report URLを確認できる
- `Article` で表示要件を満たせない場合は MVP を未完了のままにし、単一の `Note` fallback contract へ切り替えた全 protocol / mapping / E2E 検証を完了する
- Mastodon serverのInboxへPufu Lens dispatcherからsigned POSTされることをtraceで確認できる
- remote server停止後のretryと復旧後配送を確認できる

### Step 7: 運用、観測、コスト、ドキュメント

成果物:

- queue depth、oldest age、success / retry / permanent failure、origin別failureのmetrics / alert
- Actor key backup / rotation、domain block、retry exhausted対応、canonical domain変更禁止のrunbook
- system design、API、data model、security、deployment、cost docsの同期
- dependency updateとFedify security advisory確認手順

受け入れ条件:

- backlog増加、署名失敗、remote 429 / 5xx、permanent failureを本文なしで観測できる
- operatorがretry exhaustedを安全に再投入または破棄できる
- 月間request、Job実行時間、DB増分、network egressを計測できる
- production deploy checklistにcanonical origin、NTP、signature、SSRF、queue永続性が含まれる

## 11. テスト戦略

- unit: Actor mapping、username、activity ID、Article mapping、sanitize、retry分類、backoff、runtime guard
- DB integration: project scope、unique constraint、transactional outbox、SKIP LOCKED、lease lost、idempotency
- protocol contract: WebFinger、JSON-LD、signature、Follow / Accept / Undo、Create / Announce
- security: signature不正、古いDate、SSRF、redirect、oversize、malformed JSON-LD、unsafe HTML、spoofed attribution
- dispatcher: concurrent worker、crash recovery、heartbeat、retry exhausted、permanent failure、bounded runtime
- E2E: Pufu Lens A / B、Mastodon search / follow / timeline / unfollow

通常の `format:check`、`lint`、`typecheck`、`test` に加え、schema変更Stepでは `db:migrate --check` と `db:schema-drift`、UI変更StepではPlaywrightと画面キャプチャを必須とする。外部Mastodonを使うtestはCIの決定論的testと分離し、実行先・日時・versionを記録する。

## 12. コスト方針

Fedify 自体の導入で常時稼働processを追加しない。現行構成への主な増分は次の従量費とする。

- Firebase App Hosting: WebFinger、Actor、inbox、object lookupのrequest
- Cloud Run Jobs: ActivityPub dispatcherの起動時間
- PostgreSQL: Actor、follow、activity、queue、external report、Fedify KV
- network egress: remote inbox配送、remote Actor / Article lookup
- Secret Managerまたは既存暗号化基盤: Actor private key管理

Cloudflare Workers版のFedifyはbuilder pattern、Workers KV、Workers Queuesを使う別deployment optionであり、現行Pufu Lensと同じものではない。MVPではGCP / PostgreSQLの運用を維持して新しいcloud vendorとqueue課金を増やさない。実測後、dispatcherの起動頻度、batch size、retention、shared inbox率を調整する。

## 13. ロールアウトと停止

1. production routeを公開する前に固定canonical originとActor key backupを確定する。
2. internal test Actorだけを有効化し、Pufu Lens 2台で配送する。
3. staging Mastodonまたはtest instanceで互換性を確認する。
4. `@all` はinitially hidden / disabledとし、project Actorの実績確認後に有効化する。
5. domain / Actor単位のkill switchとoutbox enqueue停止を用意して段階公開する。

停止時も既存Actor URLを即時404へせず、少なくともActorとTombstone方針を決めてremote followerを孤立させない。canonical domainの変更やActor ID移行はMVP後の別planとする。

## 14. 参考資料

- [Fedify: Integration](https://fedify.dev/manual/integration)
- [Fedify: Federation](https://fedify.dev/manual/federation)
- [Fedify: Sending activities](https://fedify.dev/manual/send)
- [Fedify: Message queue](https://fedify.dev/manual/mq)
- [Fedify: Deployment](https://fedify.dev/manual/deploy)
- [Fedify: Changelog](https://fedify.dev/changelog)
- [ActivityPub W3C Recommendation](https://www.w3.org/TR/activitypub/)
- [Activity Vocabulary W3C Recommendation](https://www.w3.org/TR/activitystreams-vocabulary/)
