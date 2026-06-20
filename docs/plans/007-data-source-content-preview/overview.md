# Data Source Content Preview 計画

## 目的

`/projects/[projectSlug]/admin/data-sources` の選択中データソース詳細で、収集済み raw document、parse / index 済み document、代表 snippet、状態を確認できるようにする。

特に次を満たす。

- CLI や DB を直接見なくても、対象 data source にどの document が入っているか確認できる。
- raw / parsed / indexed の状態差分、failed / held の理由、最終取得・最終 index 時刻を同じ画面で追える。
- Gmail / Drive / GitHub / Web の source type 差を吸収し、共通の document preview と source metadata を表示する。
- raw 本文全文、OAuth token、secret、メールアドレスなどの機微情報を無制限に画面へ出さない。
- 将来の Chat / Graph 連携へつなげられるよう、documentId / rawDocumentId / canonicalUri / source type を UI 上の操作起点として整理する。

## 前提

- Data Sources 画面は project admin 向けの管理画面として扱う。
- 画面入口は既存の `/projects/[projectSlug]/admin/data-sources?dataSourceId=...` を使う。
- project は URL の `projectSlug` から server side で解決し、request body や query string の project id は信用しない。
- data source は `data_sources`、raw document との関連は `raw_document_data_sources`、解析済み document は `documents`、snippet は `document_chunks` を主に参照する。
- Object Storage 上の raw / parsed 本文の直接表示は初期実装の対象外とし、DB metadata と短い snippet に限定する。
- Step に着手するときは、`main` 最新化、Step 用ブランチ作成、GitHub Issue 作成を行う。

## 設計方針

### 表示範囲

選択中 data source の detail panel に、設定フォームとは分離した content preview を追加する。

初期表示では次を扱う。

- summary metrics:
  - raw document count
  - parsed / indexed count
  - failed / held queue count
  - last checked
  - last indexed
- document list:
  - title
  - doc type
  - ingest status
  - canonical URI
  - created / fetched / indexed timestamp
  - short snippet
  - rawDocumentId / documentId の compact 表示
- failed / held item:
  - status
  - attempts
  - last error の短い要約
  - retry 導線は既存 ingestion UI と整合させる

### UI

既存 detail panel の中に、設定編集と確認ビューを混ぜすぎないように区切りを置く。初期実装では query string 連動 tab は増やさず、Settings / Content / Queue を同一 detail panel 内の section として表示する。

実装構成:

```text
Selected Source Detail
├─ Header: source type / name / status
├─ Settings: 既存の name / scope / collect 操作
├─ Content: document preview table / snippet
└─ Queue: failed / held / pending summary
```

desktop では現在の split layout を維持し、右 panel 内で content preview を表示する。mobile では一覧と詳細が縦積みになるため、preview table は横スクロールではなく compact list を優先する。

主要 `data-testid`:

- `data-source-content-panel`
- `data-source-content-document-row`
- `data-source-content-snippet`
- `data-source-content-empty`
- `data-source-queue-preview`

### データ取得

`apps/web/src/admin-db.ts` に data source content preview 用の loader を追加する。

想定する関数:

```typescript
getDataSourceContentPreview(projectSlug, dataSourceId);
```

この loader は次を守る。

- project slug と data source id の組み合わせを DB で検証する。
- 対象 project に属する data source だけを返す。
- limit / ordering を固定し、初期実装では最新 20 件程度に制限する。
- raw / parsed storage URI は内部参照として扱い、画面にそのまま出さない。
- snippet は `document_chunks.content` または `documents.summary` 由来の短い文字列に制限する。
- fallback fixture でも最低限の preview を表示できるようにする。

### セキュリティ / プライバシー

- raw 本文全文、parsed JSON 全文、OAuth token、refresh token、secret reference 実値は表示しない。
- canonical URI は表示してよいが、社内 URL やメールアドレスを含む可能性を考慮し、将来 public 経路へ流用しない。
- error message は provider response 全文を出さず、短い要約にする。
- private admin UI のみで提供し、public project / public report / public chat の公開情報とは分ける。
- Chat や Graph へ連携する場合も、server side で project member / admin 判定を再実行する。

## Step 一覧

| step   | status      | 内容                                                    | 完了条件                                                                       |
| ------ | ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Step 1 | `completed` | preview contract と UI 設計を docs に反映する           | Issue #148。system / UI design に表示項目、非表示情報、detail panel 構成が残る |
| Step 2 | `completed` | data source content preview loader を実装する           | project scoped query、limit、snippet、fallback の unit test が通る             |
| Step 3 | `completed` | Data Sources detail panel に Content / Queue 表示を足す | 選択中 data source の document と queue 状態を UI で確認できる                 |
| Step 4 | `completed` | Chat / Graph への導線と追加 preset の要否を整理する     | 初期実装では導線を置かず、後続 plan 候補として分離する判断を記録済み           |
| Step 5 | `completed` | e2e / visual / security 検証を追加する                  | PR #150 で unit / typecheck / build / e2e 部分確認を実施し、未確認リスクを記録 |

## Step 1: Preview Contract と UI 設計

### 実装範囲

- `docs/designs/system/03-data-model.md` に data source content preview が参照する table と境界を追記する。
- `docs/designs/system/05-api-design.md` に、初期実装は server component / loader 経由であり REST API を増やさない方針を追記する。
- `docs/designs/system/12-security.md` に preview で表示してよい情報 / 表示しない情報を追記する。
- `docs/designs/ui/ui-layout.md` に Data Sources detail panel の Settings / Content / Queue section 構成を追記する。

### 受け入れ条件

- document preview の表示項目と非表示項目が明文化されている。
- raw / parsed 本文全文を初期実装で表示しない方針が明記されている。
- data source id は project slug と組み合わせて検証することが明記されている。
- UI のタブ / panel / empty state / mobile 表示方針が決まっている。

## Step 2: Preview Loader

### 実装範囲

- `apps/web/src/admin-db.ts` に `getDataSourceContentPreview` を追加する。
- `raw_document_data_sources` から対象 data source の raw document を取得する。
- `documents` / `document_chunks` を left join し、indexed 済み document の metadata と短い snippet を返す。
- `ingestion_queue` から failed / held / pending の代表 queue item を返す。
- `apps/web/src/admin-data.ts` に preview 用型と fixture fallback を追加する。
- unit test を追加する。

### 受け入れ条件

- 他 project の data source id を指定しても preview が返らない。
- indexed document がない source でも raw / queue 状態は表示できる。
- snippet は長さ制限され、raw 本文全文を返さない。
- fallback fixture で UI 開発と e2e が可能になる。

## Step 3: Data Sources UI

### 実装範囲

- `apps/web/app/projects/[projectSlug]/admin/data-sources/page.tsx` で選択中 data source の preview を読み込む。
- detail panel に Settings / Content / Queue section を追加する。
- Content では document list と snippet を表示する。
- Queue では failed / held / pending の代表 item と既存 retry / collect 導線を整理する。
- empty state を追加する。
- 主要要素に `data-testid` を付与する。

### 受け入れ条件

- 指定 URL の `dataSourceId` に対応する content preview が表示される。
- content がない場合も空状態が明確に表示される。
- 既存の Save / Test / Collect & Ingest 操作は維持される。
- mobile / desktop でテキストや UI が重ならない。

## Step 4: Chat / Graph 連携整理

### 実装範囲

- document row から private chat へ遷移する導線を検討する。
- data source 起点の graph preset を増やす必要があるか確認する。
- Chat に dataSourceId / documentId を渡す場合の server side validation を設計する。
- 初期実装で導線は置かず、後続 plan に分ける判断を記録する。

### 受け入れ条件

- Chat / Graph の既存認可境界を崩さない導線方針が決まっている。
- Cypher 文字列や graph name を browser から受け取らない方針が維持されている。
- public chat / public report へ private preview 情報が混ざらない。

### 対応状況

- 初期実装では document row から private chat / graph viewer へ直接遷移する導線は置かない。
- `documentId` / `rawDocumentId` / `canonicalUri` / source type は Content row 上で compact 表示し、将来の操作起点として識別できる範囲に留める。
- Chat に `dataSourceId` / `documentId` を渡す導線や data source 起点 graph preset は、既存の private chat / graph 認可境界を再設計してから後続 plan で扱う。

## Step 5: 検証

### 実装範囲

- unit test:
  - preview loader の project scope
  - snippet length
  - indexed / unindexed / failed / held の組み合わせ
- web test:
  - selected data source の content panel 表示
  - empty state
  - queue preview
- Playwright e2e:
  - `/projects/public-3/admin/data-sources?dataSourceId=...` 相当の詳細表示
  - desktop / mobile viewport
  - 既存 save / collect 操作の回帰確認
- security check:
  - token / refresh token / secret / raw 本文全文が画面 snapshot に出ないこと

### 受け入れ条件

- `pnpm --filter @pufu-lens/web test`
- `pnpm --filter @pufu-lens/web typecheck`
- `pnpm --filter @pufu-lens/web build`
- `pnpm --filter @pufu-lens/web test:e2e`
- 必要に応じて `pnpm format:check` / `pnpm typecheck`

### 対応状況

- Issue #148 / PR #150 で loader、fallback、UI、admin e2e assertion、設計 docs を追加した。
- PR #150 では `pnpm --filter @pufu-lens/web test`、`pnpm --filter @pufu-lens/web typecheck`、`pnpm --filter @pufu-lens/web build`、`pnpm format:check` を確認済み。
- `pnpm --filter @pufu-lens/web test:e2e` は 11 passed / 2 skipped / 5 failed。失敗は既存 report-ui mock 期待要素欠落と local DB の public-test 系 project 重複による mobile click 干渉で、今回追加した authenticated admin operation controls は e2e admin credential 未設定により skip された。
- Browser plugin による localhost 目視確認は `net::ERR_BLOCKED_BY_CLIENT` で未実施。
- Issue #212 / PR #213 で preview row 取得の runtime guard parser 適用を helper に集約し、`pnpm exec biome check apps/web/src/admin-db.ts apps/web/src/admin-db-guards.ts`、`pnpm --filter @pufu-lens/web test`、`pnpm --filter @pufu-lens/ingestion build && pnpm --filter @pufu-lens/web typecheck` を確認済み。

## 未決事項

- Content / Queue は query string 連動 tab ではなく detail panel 内の section 表示にした。
- snippet の最大文字数は `DATA_SOURCE_SNIPPET_MAX_LENGTH` に集約し、unit test で長さ制限を確認する。
- raw / parsed storage URI は admin UI でも表示しない。
- Chat / Graph 導線はこの plan では実装せず、後続 plan 候補に分ける。
