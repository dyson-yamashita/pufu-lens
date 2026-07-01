# レポート集計パーツとメトリックソース

## 概要

カスタムレポートで表、グラフ、KPI などの統計的情報を扱えるようにする。標準 report section の本文や `metrics` に数値を埋め込むだけでは、日別件数、宛先別メール件数、PR 数、資料内 fact の集計などを安全かつ再利用可能に扱いにくい。

本 plan では、既存の Data Source と custom report part の間に **Metric Source** を追加する。Metric Source は「収集済みデータから集計可能にした派生データ面」を表し、custom report part は Metric Source に対する宣言的 query と表示設定だけを持つ。

```text
Data Source
  Gmail / GitHub / Drive / Web の収集設定

Metric Source
  Gmail recipients / GitHub events / GitHub commits / Document facts などの集計可能な派生データ面

Report Part
  metric_table / metric_chart / metric_kpi としてどう集計し、どう表示するか
```

## 方針

- カスタムレポート template に任意 SQL は保存しない。
- template は Metric Source、measure、filter、group by、表示形式を宣言的に持つ。
- サーバー側の registry / validator が、利用可能な Metric Source、field、operator、measure、bucket を許可リストで検証する。
- 集計実行は deterministic な planner / aggregator が担当し、LLM は定義作成、候補解決、説明、修正案提示に限定する。
- 生成済み report には、集計結果を `custom_layout.results` の snapshot として保存し、後から Metric Source や template が変わっても過去 report の表示を変えない。
- 表やグラフの削除は template part の削除に留め、Metric Source や派生テーブルは原則削除しない。
- Metric Source の削除や purge は、参照状況、retention、project / data source purge、reindex 方針に従って別操作で扱う。
- raw / parsed / Object Storage の private locator、storage URI、OAuth token、secret、未公開 raw excerpt、メールアドレスなどの PII を report JSON / public artifact / PDF に保存しない。

## 概念モデル

### Data Source

既存の収集対象。Gmail / GitHub / Drive / Web などの外部 source と connection 設定を管理する。

### Metric Source

Data Source から派生した、集計可能なデータ面。実体は `metric_sources` metadata と、source type ごとの projection table / view / materialized view の組み合わせで表す。

例:

- `gmail_recipients`: Gmail message / thread の from / to / cc / bcc を participant 単位で集計可能にする。
- `github_events`: Issue / PR / review / comment / merge などの GitHub event を時系列集計可能にする。
- `github_commits`: repository commit を author / repository / day 単位で集計可能にする。
- `document_facts`: Drive / Web / Gmail / GitHub 文書から抽出した numeric / categorical fact を集計可能にする。

### Report Metric Part

custom report template 上の表示部品。`metric_table`、`metric_chart`、`metric_kpi` を追加する。part は Metric Source を参照し、集計 query と表示設定を持つ。

例:

```jsonc
{
  "id": "mail-to-tanaka-by-day",
  "type": "metric_chart",
  "title": "田中さん宛メール件数",
  "result_key": "mail_to_tanaka_by_day",
  "metric_source_id": "ms_gmail_recipients",
  "query": {
    "measure": { "op": "count_distinct", "field": "message_id", "alias": "count" },
    "filters": [
      { "field": "participant_role", "op": "eq", "value": "to" },
      { "field": "actor_id", "op": "eq", "value": "actor_tanaka" }
    ],
    "group_by": [{ "field": "sent_at", "bucket": "day", "alias": "day" }]
  },
  "chart": { "type": "bar", "x": "day", "y": "count" }
}
```

## データモデル方針

### `metric_sources`

Project scope の集計データ面を管理する metadata table。

想定カラム:

- `id`
- `project_id`
- `metric_source_key`: project scope の不変 logical key。template export / import の mapping に使う。メールアドレス、repository private URL、secret などは含めない。
- `data_source_id` nullable。複数 data source を束ねる Metric Source では null または join table を使う。
- `source_type`: `gmail_recipients`、`github_events`、`github_commits`、`document_facts` など。
- `name`
- `description`
- `status`: `active`、`disabled`、`backfilling`、`failed`
- `config`: source type ごとの設定。PII や secret は保存しない。
- `indexer_version`
- `last_backfilled_at`
- `created_by`
- `created_at`
- `updated_at`

### Projection table

Metric Source ごとの集計中間テーブル。PostgreSQL の特殊 index ではなく、raw / parsed から再生成可能な派生 table として扱う。

例: `gmail_message_participants`

- `project_id`
- `metric_source_id`
- `document_id`
- `raw_document_id`
- `message_id`
- `thread_id`
- `participant_role`: `from` / `to` / `cc` / `bcc`
- `actor_id` nullable
- `alias_hash` nullable
- `sent_at`
- `parser_version` nullable
- `indexer_version`
- `indexed_at`

この table には最終集計結果ではなく、メール1通ごとの参加者行を入れる。日別件数や宛先別件数は report 生成時に SQL で集計する。

例: `github_metric_events`

- `project_id`
- `metric_source_id`
- `document_id` nullable
- `raw_document_id` nullable
- `repository`
- `event_type`: `issue_opened` / `pr_opened` / `pr_merged` / `review_submitted` / `commit_authored` など
- `actor_id` nullable
- `occurred_at`
- `event_key`
- `indexer_version`
- `indexed_at`

例: `document_metric_facts`

- `project_id`
- `metric_source_id`
- `document_id`
- `fact_type`
- `label`
- `numeric_value` nullable
- `categorical_value` nullable
- `occurred_at` nullable
- `confidence` nullable
- `source_section_ref` nullable。public artifact には出さない。
- `indexer_version`
- `indexed_at`

### Aggregate table / materialized view

重い集計、頻繁に見る集計、期間固定の dashboard 用途では、projection table の上に aggregate table または materialized view を追加できる。ただし custom report の基本形は report 生成時に projection table を `SELECT / GROUP BY` し、結果 snapshot を report JSON に保存する。

## 生成・更新 workflow

### Metric Source 作成

1. Project admin が管理 UI で Metric Source を作成する、または Mastra の report-definition agent が必要な Metric Source を提案する。
2. Server validator が source type、対象 data source、config、権限、PII 保存禁止ルールを検証する。
3. `metric_sources` に `backfilling` として登録する。
4. Backfill job が既存 raw / parsed から projection table を作成・投入する。
5. 成功したら `active` にする。失敗時は `failed` とし、エラー要約だけを保存する。

### Incremental ingest

新規 ingestion / parse / index の後、対象 Metric Source の indexer が projection table に upsert する。

```text
raw_documents
  -> parse
  -> documents / parsed artifact
  -> metric source indexer
  -> projection table
```

indexer は冪等にし、`project_id`、source identifier、role、actor / alias、occurred time、`indexer_version` を unique key に含める。重複 raw、thread / message、引用、PR diff などで二重 count しないよう、source type ごとに unique key を定義する。

### Backfill / Reindex

- 導入時は過去 raw / parsed を backfill して projection table を埋める。
- indexer の仕様変更時は `indexer_version` を上げ、対象 Metric Source / project / data source / period を reindex できるようにする。
- old version の派生行削除は、新 version の backfill 完了後に行う。
- backfill / reindex は raw 本文や private locator を log に出さない。

### Reconcile / source deletion

元データの更新、削除、非公開化、data source purge で projection table が過剰 count を起こさないよう、Metric Source ごとに reconcile 方針を持つ。

- source が削除または purge された場合は、対象 `project_id` / `data_source_id` / `metric_source_id` / `document_id` / `raw_document_id` の projection row を物理削除する。
- source が論理削除または一時的に参照不能になった場合は、projection row に `source_status` または `deleted_at` を持たせ、metric query の既定では除外する。
- parsed document が更新された場合は、対象 document の projection row を replace する。古い fact / participant / event は残さない。
- GitHub repository の削除・非公開化や Gmail message の削除など provider 側の deletion event を即時検知できない場合は、定期 reconcile job で source の存在確認と projection row の差分削除を行う。
- 生成済み report の `custom_layout.results` は過去 snapshot として保持し、reconcile 後も過去 report の表示は変更しない。

### Report generation

1. custom report template から `metric_*` part を読み取る。
2. `metric_source_id` が project scope 内で `active` か確認する。
3. declarative query を registry で検証する。
4. planner が許可済み SQL に変換する。
5. aggregator が SQL を実行する。
6. 結果を `custom_layout.results` に保存する。
7. renderer / PDF / public report は保存済み snapshot を描画する。

## Declarative metric query

template には SQL 文字列ではなく、次の部品だけを持たせる。

- `metric_source_id`
- `measure`
  - `count`
  - `count_distinct`
  - `sum`
  - `avg`
  - `min`
  - `max`
- `filters`
  - `eq`
  - `in`
  - `contains_actor`
  - `between`
  - `exists`
- `group_by`
  - field
  - bucket: `day` / `week` / `month`
- `order_by`
- `limit`

各 Metric Source は公開可能な field、operator、measure、bucket を registry に登録する。

`measure.alias` は集計結果の列名として扱う。`alias` が省略された場合、planner は `count`、`sum_<field>`、`avg_<field>`、`<field>_count_distinct` のような deterministic な既定名を生成する。renderer の `chart.x` / `chart.y` / table column は、SQL の生 field 名ではなく planner が確定した出力列 alias を参照する。`group_by.alias` も同様に出力列名であり、時間 bucket の既定名は `<field>_<bucket>` とする。

registry の field 定義では、filter 可能性、measure 可能性、group by 可能性を分ける。カテゴリ field は `groupable: true`、時間 field は `groupByBuckets` を持つ。`groupByBuckets` がある field は bucket 指定必須、`groupable: true` の field は bucket なしで group by できる。

例:

```ts
gmailRecipientsMetricSource = {
  fields: {
    actor_id: { filter: ['eq', 'in'], groupable: true, publicLabel: 'Actor' },
    participant_role: {
      filter: ['eq', 'in'],
      groupable: true,
      values: ['from', 'to', 'cc', 'bcc']
    },
    sent_at: { filter: ['between'], groupByBuckets: ['day', 'week', 'month'] },
    message_id: { measure: ['count_distinct'] },
    thread_id: { measure: ['count_distinct'] }
  }
};
```

## Mastra agent の役割

Mastra の report-definition agent は、レポート定義編集の補助として使う。

任せてよいこと:

- 自然言語から metric part 候補を作る。
- 利用可能な Metric Source / field / operator を調べて定義案を作る。
- 「田中さん」などの曖昧な名前を actor 候補へ解決する。
- dry-run preview の結果や validation error を説明する。
- 必要な Metric Source がない場合に作成提案を出す。
- template diff 案を作る。

任せないこと:

- 任意 SQL の保存。
- migration や本番 schema 変更の自動適用。
- raw 本文の自由検索結果を template に埋め込む。
- PII を含む値を template / report JSON / public artifact に保存する。
- project boundary をまたぐ query の作成。
- 未登録 Metric Source の勝手な追加。

## 管理 UI

Project admin 向けに次を提供する。

- Metric Source 一覧。
- Metric Source の作成、無効化、再 backfill、reindex。
- status、last backfill、対象 data source、projection row count、last error の表示。
- custom report editor で `metric_table` / `metric_chart` / `metric_kpi` part を追加する UI。
- part 追加時に利用可能な Metric Source、field、filter、group by、measure を選択できる UI。
- 必要な Metric Source がない場合の作成導線。
- part 削除時は template から削除し、Metric Source は削除しないことを UI 上で明示する。

## 公開境界とセキュリティ

- private / public report detail は同じ report JSON snapshot を描画する。
- public 入口は project visibility と report `is_public` metadata を正とする。
- public artifact / PDF には private raw locator、storage URI、raw URI、parsed URI、OAuth token、secret、API key、メールアドレス、未公開 raw excerpt を含めない。
- template export には `metric_source_id` をそのまま移植せず、`metric_source_key`、`source_type`、Metric Source schema version、field query を保存する。
- import 時の mapping は `metric_source_key` + `source_type` + compatible schema version の一致を最優先にする。source type と field query は候補絞り込みの補助情報として扱う。
- `metric_source_key` が一致する active Metric Source が 1 件だけ存在する場合は自動 mapping できる。
- key 一致がないが、同じ source type / compatible schema の active Metric Source が 1 件だけ存在する場合は import preview で確認付き mapping とする。
- 複数候補がある場合は自動で最初の候補を選ばず、import preview で user に mapping を選択させる。
- 候補がない場合、または必須 actor / field mapping が未解決の場合は、template を active にせず disabled draft として保存するか、import を拒否する。
- `actor_id` filter は import 先 project で再解決が必要。未解決の場合は import preview で警告し、template を disabled draft として扱う。
- aggregate SQL は project-scoped repository 経由で実行し、request body 由来の project id や graph name を信用しない。

## Step

| Step | status    | 内容                                       | 完了条件                                                                                       |
| ---- | --------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1    | `planned` | Metric Source data model / registry 設計   | `metric_sources`、projection table 方針、registry schema、query validation contract が確定する |
| 2    | `planned` | Gmail recipients Metric Source             | Gmail 宛先/送信者を projection table に backfill / incremental ingest できる                   |
| 3    | `planned` | GitHub events / commits Metric Source      | PR / issue / review / commit の日別・repository 別集計に必要な projection が作成される         |
| 4    | `planned` | Custom report metric parts                 | `metric_table` / `metric_chart` / `metric_kpi` が template、生成、renderer、PDF で扱える       |
| 5    | `planned` | Report-definition agent integration        | Mastra が Metric Source を使った定義案、preview、validation error 説明を返せる                 |
| 6    | `planned` | Import/export / public boundary regression | Metric Source mapping、PII 混入防止、public report / PDF regression が追加される               |

## テスト方針

- schema validation: 不正 Metric Source、未知 field、未知 operator、許可されない group by / measure を拒否する。
- SQL planner: template 由来の declarative query から許可済み SQL だけが生成される。
- authorization: project member / admin 境界、project scope、public report 境界を確認する。
- backfill: 既存 raw / parsed から projection table が冪等に作成される。
- reconcile: source 更新、削除、非公開化、data source purge で projection row が除外または削除され、過剰 count しない。
- incremental ingest: 新規 document で projection row が追加され、重複収集で二重 count されない。
- Gmail metrics: actor / alias 解決、to / cc / from、message / thread distinct count、日別 group by を確認する。
- GitHub metrics: PR / issue / review / commit の event type、repository、actor、day group by を確認する。
- renderer: private / public report detail と PDF で table / chart / KPI が snapshot から描画される。
- security regression: report JSON、public artifact、PDF、logs に private locator、storage URI、token、secret、メールアドレスが混入しない。
- import/export: Metric Source mapping が未解決の場合に import preview で警告し、壊れた template を active にしない。

## 実装時の決定事項

- projection table は集計結果 table ではなく、集計しやすくするための中間 table とする。
- レポート生成時は projection table を集計し、最終結果を `custom_layout.results` に保存する。
- metric query の出力列は planner が alias として確定し、renderer は alias だけを参照する。
- source 更新・削除・非公開化は reconcile / replace / purge で projection table に反映し、metric query の既定対象から stale row を除外する。
- 表やグラフ part の削除では Metric Source や projection table を削除しない。
- Metric Source の削除はまず `disabled` とし、物理削除や派生行 purge は参照状況と retention policy に従う。
- raw grep は探索や backfill 設計の補助に限定し、定常 report metric の実行経路にはしない。
- GCS / local storage の raw は原本保管と根拠確認に使い、定常集計は PostgreSQL 上の projection table / view を使う。

## 関連 Issue

- Issue #399
