# Project Settings 連携管理と Data Source 選択制御計画

## 目的

project の Settings 画面から Google / GitHub 連携状態を確認・接続・再接続・解除できるようにし、未連携 provider に依存する data source は作成・選択・実行できないようにする。

特に次を満たす。

- Google 連携は Gmail / Drive data source の前提にする。
- GitHub 連携は GitHub data source の前提にする。
- Web data source は外部連携なしで作成できる。
- UI の選択肢を無効化するだけでなく、server action / API / workflow entrypoint でも同じ制約を検証する。
- OAuth token / refresh token / secret の実値は画面、ログ、fixture、test snapshot に出さない。

## 前提

- アプリログインは Auth.js session を使う。Google / GitHub data source 連携 OAuth とは責務を分ける。
- `oauth_connections` は project 単位で共有する provider 連携を表す。project admin が接続した Google / GitHub connection を、対象 project の data source が共有して使う。
- data source 作成時は、`gmail` / `drive` は Google connection、`github` は GitHub connection、`web` は `connection_id = null` を要求する。
- Settings 画面は project admin 向けの管理画面として扱う。connection は project scope の共有設定として表示し、個人アカウント連携ではなく「この project の収集に使う連携」として扱う。
- GitHub は OAuth App ではなく GitHub App installation を優先する。connection は installation id、対象 owner / repository、権限、installation token 取得に必要な secret reference を保持する。
- Google は source type 追加時の incremental authorization を採用する。初回から Gmail / Drive scope をまとめて要求せず、Gmail または Drive data source を追加するときに不足 scope だけを追加要求する。
- Step 2 以降の実装に着手するときは、`main` 最新化、Step 用ブランチ作成、GitHub Issue 作成を行う。

## 設計方針

### Settings 画面

`/projects/[projectSlug]/admin/settings` に Connections セクションを追加する。

- Google connection card:
  - 状態: `connected` / `not_connected` / `expired` / `scope_missing` / `error`
  - account email、scope summary、expires at、updated at を表示する
  - Connect / Reconnect / Disconnect を提供する
- GitHub connection card:
  - 状態: `connected` / `not_connected` / `scope_missing` / `error`
  - GitHub App installation owner、repository access summary、permission summary、updated at を表示する
  - Install / Reconfigure / Disconnect を提供する

token や secret id の実値は表示しない。scope は収集対象の理解に必要な human readable label に変換する。

### Data Source 選択制御

Data Sources 画面の Add Source では、project が必要な connection を持たない source type を選択できないようにする。

| source type | 必要な connection | 未連携時の UI                                   |
| ----------- | ----------------- | ----------------------------------------------- |
| `web`       | なし              | 選択可                                          |
| `github`    | GitHub            | 選択不可。Settings の GitHub Connect 導線を表示 |
| `drive`     | Google            | 選択不可。Settings の Google Connect 導線を表示 |
| `gmail`     | Google            | 選択不可。Settings の Google Connect 導線を表示 |

既存 data source の一覧表示は残す。ただし connection が失効・解除済みの data source は、状態を `connection_required` 相当に見せ、Collect / Test / Save の扱いを source type ごとに定義する。

### Server Side 検証

UI は補助にすぎないため、以下でも同じ制約を検証する。

- `createDataSource`
- `updateDataSource`
- collect / ingest 起動 action
- 将来追加する `/api/projects/[projectSlug]/data-sources` の POST / PATCH
- CLI / workflow entrypoint が DB の data source を読む箇所

未連携または scope 不足の場合は data source を作成せず、secret や provider response を含まないエラーを返す。

## Step 一覧

| step   | status      | 内容                                                                                | 完了条件                                                                       |
| ------ | ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Step 1 | `completed` | connection 状態 contract と Settings UI 設計を確定する                              | system / UI design に connection card、状態、scope、非表示情報が反映される     |
| Step 2 | `completed` | `oauth_connections` migration / repository / project connection 境界を実装する      | connection 一覧取得、作成、更新、解除の unit test が通る                       |
| Step 3 | `completed` | Google OAuth と GitHub App installation の start / callback / disconnect を実装する | callback が token / app secret を secret 管理し、画面やログへ実値を出さない    |
| Step 4 | `completed` | Settings に Connections セクションを追加する                                        | project admin が connection 状態を確認し、Connect / Reconnect へ進める         |
| Step 5 | `completed` | Data Source 作成 UI で未連携 source type を選択不可にする                           | 未連携 provider の option / tab / submit が e2e で選択不可と確認できる         |
| Step 6 | `active`    | server action / API / workflow 側の connection 必須検証を入れる                     | 直接 form submit / API 呼び出しでも未連携 source type の作成・実行が拒否される |
| Step 7 | `planned`   | 失効・scope 不足・解除済み connection の運用表示と検証を追加する                    | expired / scope_missing の表示、再接続導線、secret 漏れ検査が通る              |

## Step 1: Connection Contract と UI 設計

### 実装範囲

- `docs/designs/system/03-data-model.md` の `oauth_connections` と `data_sources.connection_id` の意味を、project 単位の共有 connection と project data source の紐づきとして明確化する。
- `docs/designs/system/05-api-design.md` に connection 一覧 / disconnect / scope validation の contract を追加する。
- `docs/designs/system/12-security.md` に token 保存先、ログマスク、disconnect 時の data source 扱いを追加する。
- `docs/designs/ui/ui-layout.md` に Settings の Connections セクションと Data Source 未連携状態を追加する。
- GitHub App installation と Google incremental authorization の導線を UI / API contract に反映する。

### 受け入れ条件

- Google / GitHub の connection 状態 enum と表示項目が定義されている。
- token / refresh token / secret id の表示禁止が明記されている。
- Gmail / Drive / GitHub / Web の source type と必要 connection の対応が明記されている。
- connection 解除時に既存 data source を無効化するか、enabled のまま `connection_required` として実行拒否するかが決まっている。
- Google の不足 scope は source type 追加時に incremental authorization で追加要求する contract が定義されている。
- GitHub は GitHub App installation を使い、installation owner / repository access / permissions の扱いが定義されている。

## Step 2: Connection Repository / Migration

### 実装範囲

- `oauth_connections` が未作成の環境向け migration を追加する。
- connection 一覧取得用 repository を追加し、対象 project の connection だけを返す。
- data source 作成時に選べる connection 候補を、対象 project に紐づく共有 connection に限定する。
- secret 実値は DB に保存せず、Secret Manager または local dev 用 secret reference を `access_token_secret` / `refresh_token_secret` に保存する。
- `oauth_connections` は `project_id` を持ち、project 削除時に connection metadata も削除されるようにする。
- GitHub App installation 用に installation id、account login、repository selection、permissions summary を metadata として保持する。

### 受け入れ条件

- 他 project の connection が Settings や Data Source 作成候補に出ない。
- `connection_id` が対象 project に属さない data source は作成できない。
- token secret reference と token 実値の境界が test で確認される。

## Step 3: OAuth Start / Callback / Disconnect

### 実装範囲

- `/api/connections/google/start` / `/api/connections/google/callback` を実装する。
- GitHub App installation start / setup callback を実装する。
- disconnect action を追加する。
- state parameter に project、session user、CSRF 防止情報を含め、callback で project admin 権限を再検証する。
- Google は Gmail / Drive の必要 scope を source type 追加時に incremental authorization で要求する。
- GitHub は GitHub App installation の installation id と repository access を検証し、必要な Issues / Pull requests / Contents などの権限不足を拒否する。

### 受け入れ条件

- 未ログインでは start / callback / disconnect が拒否される。
- project admin ではないユーザーの start / callback / disconnect が拒否される。
- callback の state 不一致、provider 不一致、scope 不足が拒否される。
- GitHub App installation の repository access または permission 不足が拒否される。
- token / provider raw response がログや画面に出ない。
- disconnect 後、該当 provider を必要とする新規 data source を作成できない。

## Step 4: Settings Connections UI

### 実装範囲

- Settings 画面に Connections セクションを追加する。
- provider ごとの状態 card、Connect / Reconnect / Disconnect 操作を追加する。
- `data-testid` を安定付与する。
  - `project-settings-connections-panel`
  - `connection-google-card`
  - `connection-google-connect-button`
  - `connection-github-card`
  - `connection-github-connect-button`
- モバイルでは 1 カラム、desktop では 2 カラムにする。

### 受け入れ条件

- project admin は Google / GitHub 連携状態を Settings で確認できる。
- token / refresh token / secret reference は表示されない。
- connection が未設定の場合、Data Sources への次アクションが明確に表示される。
- モバイル / デスクトップで表示が重ならない。

## Step 5: Data Source UI 選択制御

### 実装範囲

- Data Sources 画面で connection availability を読み込む。
- Add Source の `sourceType` 選択で、未連携 provider に依存する option を disabled にする。
- active tab が未連携 source type の場合は、作成フォームに Settings への接続導線を表示し、submit を無効化する。
- 既存 data source が connection を失っている場合は状態と detail panel に再接続導線を表示する。

### 受け入れ条件

- Google 未連携時、`gmail` / `drive` は選択不可。
- GitHub 未連携時、`github` は選択不可。
- Web は常に選択可能。
- disabled option だけに依存せず、submit button も適切に無効化される。
- e2e で未連携状態と連携済み状態の両方を確認する。

## Step 6: Server Side Enforcement

### 実装範囲

- `createDataSource` で source type に対応する connection を必須にする。
- `data_sources.connection_id` を対象 project の共有 connection として正しく保存する。
- `updateDataSource` で source type と connection の整合性を維持する。
- collect / ingest 起動時に connection 状態、scope、期限を検証する。
- connection 不足時のエラーを secret を含まない定型エラーにする。

### 受け入れ条件

- form を直接 submit しても、未連携 Gmail / Drive / GitHub data source は作成できない。
- `connection_id` を改ざんしても他 project の connection を使えない。
- connection 失効時の collect / ingest は実行前に拒否され、provider API へ不要な request を投げない。
- unit / server action test が通る。

### 対応状況

- `createDataSource` は project の connection availability を server action 側で確認し、未連携 provider の data source 作成を拒否する。
- `collectDataSource` / `collectAndIngestDataSource` は Drive / Gmail では Google connection token、GitHub では GitHub App installation token を取得できない場合に実行前に拒否する。
- `updateDataSource` は既存 data source の `source_type` を変更しないため、source type と connection の再選択経路は UI 上存在しない。
- Issue #363 で API route 追加時の同等 enforcement、workflow / CLI entrypoint が DB の data source を読む箇所での connection 状態・scope・期限検証、`connection_id` 改ざんや expired / scope_missing の server action test を追加する。

## Step 7: 運用・失効・Scope 不足の検証

### 実装範囲

- expired / scope_missing / revoked の表示と再接続導線を追加する。
- disconnect 時の既存 data source の表示と実行拒否を e2e に追加する。
- `.env.example` と deploy checklist に provider OAuth client、callback URL、secret 名を追記する。
- GitHub App id、private key secret、webhook secret、setup callback URL、installation 権限の確認手順を deploy checklist に追記する。
- Google incremental authorization で追加要求される scope と source type の対応を deploy checklist に追記する。
- ログ / snapshot / fixture に token、refresh token、secret が含まれないことを確認する。

### 受け入れ条件

- scope 不足 connection では対象 data source を作成・実行できない。
- 再接続後に対象 source type が選択可能になる。
- disconnect 後に対象 source type が選択不可になる。
- 運用手順に callback URL、必要 scope、secret 名、手動確認項目が残る。

## 検証方針

- unit / repository test:
  - 対象 project の connection だけが取得される。
  - source type と provider の対応が検証される。
  - `connection_id` / `project_id` の不一致を拒否する。
- server action / route test:
  - 未ログイン、非 member、非 admin、project admin の境界。
  - 未連携 provider の data source 作成拒否。
  - scope 不足 / expired connection の作成・実行拒否。
- e2e:
  - Settings で Google / GitHub connection card が表示される。
  - 未連携時、Data Source 作成で GitHub / Gmail / Drive を選択できない。
  - 連携済み fixture state では対象 source type を選択できる。
  - disconnect 後、対象 source type が再び選択不可になる。
- security:
  - token / refresh token / provider raw response / Secret Manager secret value が response、ログ、snapshot、fixture に出ない。
  - OAuth / GitHub App setup state 不一致と callback replay が拒否される。

## 未決事項

- disconnect 時に既存 data source を `enabled = false` にするか、enabled は維持して `connection_required` として実行拒否するか。

## 参照

- `docs/designs/system/03-data-model.md`
- `docs/designs/system/05-api-design.md`
- `docs/designs/system/12-security.md`
- `docs/designs/ui/ui-layout.md`
- `docs/plans/002-account-login-public-projects/overview.md`
