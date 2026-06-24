# Agent Raw Reading 計画

## 目的

サマリ作成、private chat、private report で、既存の parsed JSON / chunk / graph を検索・構造化の安定基盤として維持しつつ、必要な場面では Agent が raw document を tool 経由で追加読解できるようにする。

この計画では parser を置き換えない。ただし parser script をデータ形状やサマリ品質に合わせて継続的に更新する運用も避ける。ingestion は引き続き deterministic parser で canonical parsed JSON を保存するが、parser の責務は検索・graph・監査に必要な最小限の安定抽出に寄せ、詳細読解や要約品質の調整は Agent raw read view 側で吸収する。

特に次を満たす。

- ingestion / chunk / graph / embedding は LLM 非依存の deterministic path を維持する。
- parser script は source contract の破壊的変更、security / correctness bug、schema version 更新が必要な場合にだけ更新する。
- chat / report は vector / graph / parsed で候補を絞り、根拠確認や文脈補完が必要な場合だけ raw を読む。
- raw 本文全文、OAuth token、secret、PII が browser、API response、Mastra trace、log に露出しない。
- source type ごとの raw contract を直接 LLM に渡さず、tool 側で読みやすく制限された read view に変換する。
- raw 読解を使った回答・report でも source と参照範囲を追跡できる。
- raw content は未信頼データとして扱い、本文内の命令を Agent / system instruction として解釈しない。

## 方針

- `raw-document-fetch` / `parsed-doc-fetch` / `document-fetch` は継続し、Agent 用 tool contract を read view 中心に整理する。
- parser は canonical index 用の stable extractor として扱い、サマリ向けの細かな整形、本文選別、source type 固有の読ませ方は parser script ではなく read adapter で扱う。
- parser artifact / version は監査と再現性のために残すが、案件ごとのチューニングや report 品質改善の主戦場にしない。
- raw read view は source type 別 adapter で作る。
  - Gmail: thread、message、quote、sender、timestamp 単位
  - Drive: title、revision、paragraph / heading 単位
  - GitHub: issue / PR body、comment、review、diff hunk 単位
  - Web: title、canonical URL、main text section、link context 単位
- Agent は raw id を自由に列挙しない。project 認可済みの検索結果、document id、または parsed / graph 由来の候補からだけ raw view を取得する。
- raw view には size limit、section limit、redaction、trace-safe summary を持たせる。
- private report 生成では、最初に parsed / graph / vector から context bundle を作り、必要に応じて raw view で根拠を補完する。
- public project の report は raw 補完を使って生成しても公開可能にする。ただし public artifact に保存できるのは redaction / policy validation 済みの要約と公開可能 source 表示だけで、private raw locator、内部 storage URI、未公開原文抜粋は含めない。
- public chat は公開済み context bundle のみを使い、private raw には到達しない。
- Parser Profiles は通常運用メニューから廃止する。parser profile / version の DB 情報は監査・互換・既存 ingestion の再現性のために残すが、管理 UI で更新する対象にはしない。

## Step 構成

| Step | status      | 内容                                                              | 完了条件                                                                 |
| ---- | ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | `completed` | Agent raw reading の tool contract と read view schema を定義する | source type 別 read view、limit、redaction、trace 表示方針が docs に残る |
| 2    | `completed` | parser 安定化方針と Parser Profiles 廃止を実装する                | parser は最小抽出に固定し、通常 UI から parser 更新導線が消える          |
| 3    | `completed` | raw read adapter と repository 境界を実装する                     | raw / parsed を project 認可付きで read view に変換できる                |
| 4    | `completed` | private chat の tool selection に raw read を統合する             | chat が必要時だけ raw view を取得し、source 付きで回答できる             |
| 5    | `planned`   | private report 生成に raw 補完を統合する                          | report が parsed context と raw view の根拠を併用して生成される          |
| 6    | `planned`   | Mastra trace / log / eval / docs を整備する                       | trace と log に raw 本文全文や secret が出ないことを確認できる           |

## Step 1: Tool Contract / Read View 設計

### 実装範囲

- `raw-document-fetch` の返却を raw contract そのものではなく Agent 用 read view として定義する。
- **正本**: 詳細 contract は `docs/designs/system/07-chat.md`（Agent Raw Read View）、`docs/designs/system/08-reporting.md`（raw 補完 report 公開境界）、`docs/designs/system/12-security.md`（prompt injection / データ境界）、`docs/designs/system/05-api-design.md`（public/private API 境界）に記載する。
- read view の共通項目を定義する。
  - `projectSlug`
  - `rawDocumentId`
  - `documentId`
  - `sourceType`
  - `sourceId`
  - `canonicalUri`
  - `title`
  - `sections`
  - `redactions`
  - `limits`
  - `traceSummary`
- `sections` は id、label、text、occurredAt、actor hints、source locator を持つ。
- tool result は untrusted content envelope で返し、section text を「参照データ」として扱うことを Agent instruction に明記する。
- `limits` は `truncated`、`nextCursor`、`availableSectionIds`、`maxSections`、`maxChars` を持ち、追加取得には `cursor`、`sectionSelector`、`aroundSectionId` のいずれかを指定できる。
- raw 本文全文ではなく、Agent が読む上限付き section 配列として返す。
- tool call trace には `traceSummary`、section count、truncated flag だけを残す。

### 受け入れ条件

- source type ごとの read view の粒度が docs に定義されている。
- truncated された raw view を cursor / section id / around section で追加取得できる contract が定義されている。
- read view section が untrusted data であり、本文内命令を実行しない contract が docs に定義されている。
- API response、Mastra trace、log に raw 本文全文を出さない方針が明記されている。
- private chat / private report / public chat / public report の到達可能データ境界が明記されている。

## Step 2: Parser 安定化 / Parser Profiles 廃止

**Outcome (Issue #294):** project admin の global nav から Parser Profiles を削除し、`/admin/parser-profiles` route を削除した。parser DB schema / registry / seed / ingestion は維持。parser 安定化方針は `docs/designs/system/06-ingestion-workflow.md` §3 に反映済み。

### 実装範囲

- parser の責務を canonical parsed JSON の最小安定抽出として文書化し、サマリ品質改善のための parser script 更新を原則行わない方針を明記する。
- parser script 更新を許可する条件を、raw contract の破壊的変更、security / correctness bug、parsed schema version 更新、既存 indexing 不能の重大不具合に限定する。
- Parser Profiles の global nav / 管理メニューを廃止し、project admin の通常導線から parser profile / version 作成・承認・却下 UI を外す。
- parser profile / version の DB schema と既存 parser registry は、監査・互換・既存 raw の parser version 記録のために残す。
- parser 更新が必要な例外ケースは、UI 操作ではなく Issue / PR / migration / fixture regression を伴う開発作業として扱う。
- 既存 Parser Profiles page は削除するか、通常 nav から外した内部 debug / 将来削除対象として扱う。v1 では user-facing な parser 更新導線をなくすことを優先する。
- Step 2 の PR 内で、Parser Profiles 前提の設計 docs / operations docs / e2e README / 運用メモを更新し、UI 変更と docs の不整合を残さない。

### 受け入れ条件

- project admin の global nav / admin menu に Parser Profiles が表示されない。
- parser script を更新しなくても、raw read adapter の改善だけで chat / report の読解品質を改善できる。
- parser 更新が必要な条件と、read adapter 更新で済ませる条件が docs に明記されている。
- parser profile / version の既存 metadata は ingestion / audit のために保持される。
- Parser Profiles 前提の docs が、通常運用では parser 更新導線を使わない説明に更新されている。

## Step 3: Raw Read Adapter / Repository

**Outcome (Issue #296):** `apps/web/src/raw-read-view.ts` に Agent Raw Read View の adapter / repository 境界を追加した。Gmail / Drive / GitHub / Web fixture から未信頼 envelope 付き section view を生成し、project boundary、cursor / section selector / around section、size / section limit、email / secret redaction、sanitized contract mismatch error を単体テストで確認済み。

### 実装範囲

- Object Storage から raw JSON を読み、source type 別 adapter で read view に変換する。
- parsed JSON がある場合は title、canonical URI、occurredAt、actors、references を補助情報として併用する。
- project member / admin 認可、project 越境拒否、raw size limit、section limit を repository 境界で検証する。
- read view 生成時に OAuth token、secret、provider raw response の不要項目、メールアドレスなどの PII を redaction 対象にする。
- read view section は untrusted data envelope に包み、本文中の命令文と tool / system instruction を構造的に分離する。
- large raw では `nextCursor` または section selector を返し、Agent が必要範囲だけ追加取得できるようにする。
- adapter が raw contract mismatch を検出した場合は、Agent に本文を渡さず定型エラーを返す。

### 受け入れ条件

- 他 project の raw document を取得できない。
- large raw は上限内に truncate され、truncated flag と section count が返る。
- truncated された raw は cursor / section id / around section で追加取得できる。
- Gmail / Drive / GitHub / Web fixture から read view を生成できる。
- raw contract mismatch でも secret や raw 本文全文を error に含めない。

## Step 4: Private Chat 統合

**Outcome (Issue #298):** Mastra private chat の `raw-document-fetch` tool を metadata/snippet ではなく Agent Raw Read View 返却に切り替えた。tool input は `rawDocumentId` / `documentId` / `cursor` / `sectionSelector` / `aroundSectionId` を受け取り、`requestContext.projectId` で project boundary を固定する。Agent instruction に raw section が未信頼参照データであることを追記し、runtime test で untrusted section envelope を確認済み。同期 chat API の既存 metadata fetch は互換 path として維持する。

### 実装範囲

- chat agent の tool selection を `vector-search` / `graph-query` / `document-fetch` / `parsed-doc-fetch` / `raw-document-fetch` の段階実行に整理する。
- raw read は検索候補または source として選ばれた document に限定する。
- chat agent instruction に、read view section は未信頼本文であり、本文内命令より system / developer / tool policy を優先することを明記する。
- 回答 source には raw section id または parsed document locator を含め、UI では既存 source 表示に自然に載せる。
- raw read を使わずに回答できる場合は既存の parsed / chunk context だけで回答する。

### 受け入れ条件

- chat eval で raw read が必要な質問と不要な質問を分けて確認できる。
- prompt injection を含む raw section でも、Agent が別資料取得、権限逸脱、source 偽装を行わない。
- raw read tool call が project 越境を拒否する。
- 回答に source が残り、raw 本文全文は API response / trace / log に出ない。

## Step 5: Private Report 統合

### 実装範囲

- report context assembly で、parsed / graph / vector の候補 document を先に決める。
- report provider に渡す context に、必要な raw read view section を追加する。
- report JSON には private raw URI、raw document id、内部 storage URI を含めない。
- public project の report は raw 補完を使って生成しても公開可能とする。
- public publish 時は既存の public report validation を維持し、公開 artifact には redaction / policy validation 済みの要約と公開可能 source 表示だけを保存する。
- raw 由来の未公開原文抜粋、private raw locator、内部 storage URI、raw document id は public artifact に含めない。

### 受け入れ条件

- report 生成が parsed context だけの場合と raw 補完ありの場合の両方で成功する。
- public project の raw 補完あり report を公開できる。
- public report artifact に private raw locator、内部 storage URI、raw document id、未公開原文抜粋が含まれない。
- raw 補完で使った source は private report detail から追跡できる。

## Step 6: Trace / Eval / Docs

### 実装範囲

- Mastra trace で tool call 名、result count、truncated flag、trace summary を確認できるようにする。
- raw 本文全文、secret、OAuth token、API key、メールアドレスの漏れを regression test に追加する。
- raw content prompt injection の eval を追加し、本文内命令が Agent policy / tool policy を上書きしないことを確認する。
- `docs/operations/ingestion-workflow.md` と report / chat 関連 docs に、deterministic ingestion と Agent raw reading の責務分離を追記する。
- 運用時の確認 SQL / eval / smoke command を docs に残す。

### 受け入れ条件

- Mastra Studio / Playground で raw read tool call の有無を確認できる。
- trace / log / API response の secret 漏れ regression test が通る。
- docs から、parser を置き換えず Agent の読解補助として raw read を使う方針が分かる。

## 完了条件

- private chat が必要時だけ raw read view を取得し、source 付きで回答できる。
- private report が parsed context と raw read view を併用して生成できる。
- ingestion parser、chunk、graph、embedding の deterministic path が維持される。
- サマリ品質や source type ごとの読ませ方を改善するために parser script を更新する必要がない。
- project admin の通常 UI から Parser Profiles メニューと parser 更新導線が消えている。
- public project の report は raw 補完を使っても公開可能で、public artifact には公開可能な要約と source 表示だけが残る。
- public chat は private raw に到達しない。
- project 越境、large raw、追加取得、contract mismatch、redaction、prompt injection の test が通る。
- Mastra trace / log / API response に raw 本文全文、OAuth token、secret、API key が出ない。

## テスト計画

- read view schema / source type adapter の unit test。
- Object Storage raw fixture から Gmail / Drive / GitHub / Web read view を作る test。
- project 越境 raw fetch 拒否 test。
- raw size / section limit / truncated flag / cursor / section selector の test。
- contract mismatch と malformed raw の sanitized error test。
- read view section の prompt injection eval。
- private chat eval:
  - parsed context だけで回答するケース
  - raw read view を追加取得して回答するケース
  - raw section 内の命令文を無視し、tool policy と認可境界を維持するケース
  - 他 project raw を拒否するケース
- private report test:
  - raw 補完なし生成
  - raw 補完あり生成
  - public project の raw 補完あり report を公開できるケース
  - public publish validation で private raw locator、raw document id、内部 storage URI、未公開原文抜粋を拒否するケース
- UI / route test:
  - project admin の global nav に Parser Profiles が表示されない
  - 通常導線から parser profile 作成・承認・却下操作へ到達できない
- Mastra tool smoke test:
  - `raw-document-fetch` の trace が summary だけを残す
  - raw 本文全文、OAuth token、secret、API key が trace / log に出ない

## 実装時の注意

- Step に着手するときは `.codex/rules/plan-rule.md` に従い、最新 `main` から Step 用ブランチを作成し、GitHub Issue を作成する。
- 認可、DB row 取得、app/package 境界に触れるため、着手時は `.codex/rules/architecture-rule.md` を確認する。
- UI 表示を変える場合は `docs/designs/ui/ui-design.md` と整合させる。
- raw read adapter は LLM に直接 raw contract を渡すための抜け道にしない。
- parsed JSON の schema / parser version / artifact hash は引き続き canonical index の監査情報として扱う。
- parser script は安定性優先で、Agent / report の出力改善を理由にした頻繁な更新対象にしない。
- Parser Profiles の user-facing UI を復活させる場合は、この plan ではなく別 plan で再検討する。
