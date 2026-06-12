# Project Graph Viewer 計画

## 目的

プロジェクトごとのサイドメニューに **Graph** を追加し、ログイン済み project member が固定 query preset を開いたタイミングや preset 変更時に実行して、対象 project の AGE graph に対するクエリ結果をノード・エッジとして可視化できるようにする。

この機能は project member がプロジェクト内の関係構造を確認するための閲覧・探索機能であり、Chat Agent の `graph-query` を置き換えるものではない。member が ingestion 後の graph relation、actor resolution、document relation を UI 上で確認し、データ不整合や関係の欠落を調査できる状態を目指す。

## 前提

- PostgreSQL は Apache AGE を含む構成で、AGE を使う接続では `LOAD 'age'` と `SET search_path = ag_catalog, "$user", public` が必要である。
- Pufu Lens は project ごとに AGE graph を分離し、`projects.graph_name` を target graph として使う。
- Apache AGE の Cypher は `cypher(graph_name, query_string, parameters)` を呼び出し、Postgres の `SETOF record` として返す。返却列は呼び出し側で record definition を与える必要がある。
- AGE の parameter map は prepared statement 用途に限定されるため、Viewer の初期実装ではユーザーが Cypher 文字列を直接入力しない。実行可能な query は server side の固定 preset として管理する。
- Graph Viewer は project private route として扱い、global admin または対象 project の `project_members.role IN ('admin', 'member')` のログイン済みユーザーだけが閲覧・実行できる。

## 設計方針

### ルートと入口

プロジェクトごとのサイドメニューに **Graph** 入口を追加する。候補ルートは `/projects/[projectSlug]/graph` とし、Chat / Reports と同じ project shell の主要機能として扱う。project は URL の `projectSlug` から固定し、画面内で別 project を選択する UI は置かない。

初期画面には次を配置する。

- current project 表示
- graph name 表示。ただし project から解決した読み取り専用表示で、ユーザーが別 graph を直接指定できない
- fixed query preset selector
- 開いたタイミングと preset 変更時の自動実行
- graph canvas
- selected node / edge detail panel
- raw result table / JSON preview
- query status、実行時間、result count、limit 到達表示

### Cypher 実行境界

初期実装は固定 query preset だけを実行する読み取り専用 Viewer とする。ユーザー入力の Cypher editor は置かず、URL の `projectSlug` と request body の `queryId` だけを受け取る。

query preset は server side の registry で `queryId`、Cypher 本体、record definition、row / node / edge limit を定義する。Cypher 本体はコード管理された固定文字列だけを実行対象にし、DB 実行時も read-only transaction、timeout、row / node / edge limit、project 固定の graph name 解決で制限する。

server action または route handler は次を保証する。

- URL の `projectSlug` から project を解決し、session user id で対象 project の membership を検証する
- URL / body の graph name や Cypher 文字列を受け取らず、`projects.graph_name` と server side preset から解決する
- 実行 timeout、返却 row limit、node / edge limit を設ける
- unknown `queryId`、別 project の指定、request body の Cypher 文字列を拒否する
- `RETURN` 句が visualization 用の agtype 値を返せるよう、初期 contract を固定する
- SQL injection を避けるため、graph name と Cypher query は SQL template / driver の parameter として渡す
- query id、実行者、project、成功 / 失敗、所要時間、返却件数を audit log または構造化ログに残す。ただし raw / parsed 本文全文、secret、query parameter の全文は記録しない

### 結果正規化

AGE の返却 agtype を UI 用の graph model に変換する。

```ts
type AgeViewerNode = {
  readonly id: string;
  readonly label: string;
  readonly labels: readonly string[];
  readonly properties: Record<string, unknown>;
};

type AgeViewerEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
};
```

変換では次を扱う。

- vertex / edge / path を node / edge に展開する
- scalar / list / map は raw result table に表示し、graph canvas では補助情報として扱う
- 同一 node / edge id は重複排除する
- `document_id`、`actor_id`、`canonical_uri` など Pufu Lens 固有 property は detail panel で優先表示する
- oversized property は UI 上で折りたたみ、ログや telemetry に全文を流さない

### 可視化 UI

可視化は業務アプリとして密度を保ち、`docs/designs/ui/ui-design.md` と `docs/designs/ui/ui-layout.md` に合わせる。

- graph canvas はメイン領域を広く使い、node / edge detail は右側または下部 panel に分ける
- node は label / source type / entity type で色や形を分ける
- edge は relation type を label として表示し、hover / selected 状態を持つ
- zoom、pan、fit-to-view、selection、search in result、layout reset を提供する
- desktop / mobile ともに Graph Query、Graph、detail panel、raw result を縦積みにし、canvas の高さを固定して操作領域を確保する
- 主要操作には `data-testid` を付与する

### ライブラリ方針

graph layout / pan / zoom は **Cytoscape.js** を採用する。Graph Viewer は query 結果の node / edge を探索・俯瞰する用途が中心であり、layout algorithm、selection、style mapping、比較的大きなグラフへの対応を優先する。

React / Next.js 側では Cytoscape instance を canvas 領域に閉じ込め、選択中 node / edge、raw result table、query status、detail panel は React state として分離する。これにより、graph 描画の責務と project UI のフォーム・詳細表示の責務を混ぜない。

## Step 一覧

| step   | status      | 内容                                                                    | 完了条件                                                                                          |
| ------ | ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Step 1 | `completed` | Graph Viewer の UI / API contract と固定 query preset registry を固める | system / UI design docs に route、権限、固定 query preset、結果 schema が反映される               |
| Step 2 | `completed` | server side の fixed query 実行 API と agtype 正規化を実装する          | project membership 認可、graph_name 解決、queryId 検証、limit / timeout、unit / route test が通る |
| Step 3 | `completed` | project UI に Graph 入口、preset selector、result table を追加する      | project サイドメニューから Graph を開き、query 結果とエラー状態を確認できる                       |
| Step 4 | `completed` | graph canvas と detail panel を追加する                                 | vertex / edge / path が node / edge として可視化され、重複排除される                              |
| Step 5 | `completed` | 安全性、監査、E2E、運用手順を整備する                                   | 非 member 拒否、preset bypass 拒否、secret / 本文全文非露出、desktop / mobile e2e が通る          |

## Step 1: Contract / Policy

### 実装範囲

- `docs/designs/system/*` に Graph Viewer の API boundary、project membership authorization、query policy、audit log 方針を追加する。
- `docs/designs/ui/ui-layout.md` に `/projects/[projectSlug]/graph` と画面構成を追加する。
- 固定 query preset registry の仕様、`queryId`、record definition、limit を定義する。
- 初期 preset を定義する。
  - `MATCH (source)-[relation]->(target) RETURN source, relation, target LIMIT 100`
  - `MATCH (source:Actor)-[relation]->(target:Document) RETURN source, relation, target LIMIT 100`
  - `MATCH (source)-[relation:SAME_AS]->(target) RETURN source, relation, target LIMIT 100`
- result schema と error response を定義する。

### 受け入れ条件

- Viewer が URL の `projectSlug` から解決した project graph だけを対象にすることが明示される。
- ユーザー入力 Cypher を初期実装では扱わず、server side の固定 preset だけを実行することが明示される。
- max rows、max nodes、max edges、timeout の初期値が決まる。
- query preset が Pufu Lens の既存 graph relation と対応し、record definition が明示される。
- AGE 公式ドキュメントの `cypher()` 呼び出し形式と record definition の制約を踏まえた API contract になっている。

## Step 2: Server API / agtype Normalizer

### 実装範囲

- `apps/web` に Graph Viewer 用の server action または route handler を追加する。
- URL の `projectSlug` から project を解決し、query 実行時に project membership を再検証する。
- `projects.graph_name` を DB から解決し、ユーザー入力の graph name を受け取らない。
- AGE 接続初期化で `LOAD 'age'` と search path を保証する。
- request の `queryId` を server side registry に照合し、Cypher 文字列は request から受け取らない。
- `cypher()` の返却 agtype を `AgeViewerNode` / `AgeViewerEdge` / raw rows に正規化する。
- read-only transaction、query timeout、row limit、node / edge limit、エラー正規化を実装する。

### 受け入れ条件

- 未ログインユーザーと対象 project の member ではないユーザーは API を実行できない。
- 存在しない project、member でない project の結果が過剰に漏れない。
- unknown `queryId`、request body の Cypher 文字列が拒否される。
- vertex / edge / path / scalar / map / list を含む fixture test が通る。
- query 失敗時も DB 接続や UI が不安定にならない。

## Step 3: Graph Menu / Raw Result UI

### 実装範囲

- `/projects/[projectSlug]/graph` を追加する。
- project navigation に **Graph** 入口を追加する。
- current project 表示、preset selector、自動実行、loading / error / empty state を実装する。
- raw result table と JSON preview を実装する。
- graph nav item / preset selector / table / error に `data-testid` を付与する。

### 受け入れ条件

- project サイドメニューから Graph を開き、preset query が自動実行される。
- query 成功時に raw result、所要時間、row count、limit 到達有無が表示される。
- query 失敗時に安全なエラー文だけを表示する。
- desktop / mobile で current project、preset selector、result table が重ならない。

## Step 4: Graph Canvas / Detail Panel

### 実装範囲

- Cytoscape.js と必要な layout extension を決定し、依存を追加する。
- normalized nodes / edges を canvas に描画する。
- zoom、pan、fit-to-view、layout reset、node / edge selection を実装する。
- selected node / edge detail panel を実装する。
- node / edge の表示色、label、tooltip を Pufu Lens の entity / relation type に合わせる。

### 受け入れ条件

- vertex / edge / path の結果が graph canvas に表示される。
- 同一 node / edge は重複表示されない。
- node / edge を選択すると property detail を確認できる。
- canvas が空、過多、limit 到達、エラーの各状態を表示できる。
- Playwright screenshot と canvas / DOM 確認で desktop / mobile の崩れがない。

## Step 5: Safety / Audit / Operations

### 実装範囲

- query audit log または structured log を追加する。
- secret、OAuth token、raw / parsed 本文全文、過大 property を log / response に出さないことを確認する。
- fixed query registry の bypass test を追加する。
- login / member / non-member の route test と e2e を追加する。
- 運用ドキュメントに Graph Viewer の用途、制限、トラブルシュート、無効化方法を記録する。

### 受け入れ条件

- unknown `queryId`、request body の Cypher 文字列、SQL injection 風 parameter が拒否される。
- 非 member は UI 入口と API の両方で実行できない。
- audit log は query metadata を残すが、secret や本文全文を含まない。
- `pnpm test -- --run web`、`pnpm test:e2e`、`pnpm typecheck` が通る。
- 実 DB smoke で project A の Viewer から project B の graph を参照できない。

## 検証方針

- unit / route test:
  - fixed query registry の `queryId` 解決と unknown `queryId` 拒否。
  - `projects.graph_name` 解決と project membership 認可。
  - agtype normalizer の vertex / edge / path / scalar / list / map。
  - limit / timeout / error response。
- e2e:
  - project member が project サイドメニューから Graph を開き、preset query が自動実行される。
  - non-member は Graph の実行を拒否される。
  - desktop / mobile で current project、preset selector、canvas、detail panel、raw table が重ならない。
- DB smoke:
  - `sample-a` の graph に対して preset query を実行し、node / edge を確認する。
  - project slug を変えたときに graph_name が混在しないことを確認する。
- log / secret 確認:
  - query log に OAuth token、refresh token、Gemini API key、DB password、raw / parsed 本文全文が含まれない。

## 未決事項

- AGE の agtype を扱うために専用 parser / helper を実装するか、既存 DB driver の返却形式に合わせて正規化するか。
- query audit log を DB に永続化するか、structured log のみにするか。
- Viewer を production でも有効にするか、環境変数で private graph feature として opt-in にするか。
- 将来、自由入力 Cypher editor を追加するか。その場合は別 Step とし、専用 Cypher policy parser と追加の権限 / 監査設計を必須にする。

## 参照

- Apache AGE: The AGE Cypher Query Format: <https://age.apache.org/age-manual/master/intro/cypher.html>
- `docs/designs/system/02-architecture.md`
- `docs/designs/system/07-chat.md`
- `docs/designs/system/12-security.md`
- `docs/designs/system/16-tech-stack.md`
- `docs/designs/ui/ui-design.md`
- `docs/designs/ui/ui-layout.md`
