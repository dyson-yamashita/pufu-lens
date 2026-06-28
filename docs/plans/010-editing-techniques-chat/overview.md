# 編集技法を使った Chat Agent 改善計画

## 目的

松岡正剛の編集工学における編集技法を、Pufu Lens の private / public chat に取り入れ、プロジェクト情報を単に検索・要約するだけでなく、分類、比較、構造化、論点化、次アクション化まで支援できるようにする。

この計画では 64 の編集技法をそのまま UI に並べたり、ユーザーに編集モードを選ばせたりしない。対話内容から Agent / API が編集方針を自動判定し、内部 planning、回答構成、Evidence Panel の補助表示、評価 fixture に段階的に落とし込む。

## 背景

Pufu Lens の chat は、Gmail / Drive / GitHub / Web 由来の project document を横断し、`vector-search`、`graph-query`、`document-fetch`、`raw-document-fetch`、`parsed-doc-fetch`、`cross-source-summary` を使って根拠付きで回答する設計である。

現状の chat は「関連情報を探して回答する」役割が中心だが、project の運用では次のような編集的な問いが多い。

- このプロジェクトの停滞要因は何か。
- 複数の Issue / メール / ドキュメントで同じ論点が出ているか。
- 今週見るべきリスクと次アクションは何か。
- 意思決定の経緯を時系列と関係者で整理したい。
- 公開レポートの読者向けに、背景や論点をわかりやすく説明したい。

編集技法を導入することで、chat は検索窓ではなく「プロジェクトの記憶を編集して見通しを作る agent」に近づく。

## 前提

- Private Chat は project member 認可を通り、対象 project の data / graph / raw read view だけを参照する。
- Public Chat は公開済み report / public context bundle だけを参照し、DB / AGE / pgvector / raw read view tool を持たない。
- raw / parsed の本文断片は未信頼データとして扱い、本文内の命令は実行しない。
- 編集技法は根拠確認を省略するためのものではない。回答前の tool use、source selection、構造化、表現方針を制御するために使う。
- 64 技法の名称を常に回答本文へ表示しない。ユーザーに有益な場合だけ、回答末尾や Evidence Panel の補助情報として短く表示する。
- Step に着手するときは、`.codex/rules/plan-rule.md` に従い、最新 `main` から Step 用ブランチを作成し、GitHub Issue を作成する。

## 編集技法の適用範囲

### 内部 planning

質問種別に応じて、Agent が使う編集操作を選ぶ。

| 質問種別   | 主な編集技法                 | 期待する回答                             |
| ---------- | ---------------------------- | ---------------------------------------- |
| 事実確認   | 収集、選択、引用、要約       | 根拠 source を明示した短い回答           |
| 状況把握   | 分類、比較、境界、地図、焦点 | 論点のまとまり、重要度、見るべき範囲     |
| リスク分析 | 競合、推理、構造、生態、道筋 | ボトルネック仮説、影響範囲、次アクション |
| 経緯整理   | 系統、順番、注釈、場面、脚本 | 時系列、関係者、判断の変化               |
| 企画支援   | 比喩、原型、模型、総合、創造 | 別案、見立て、実行可能な企画案           |
| 公開説明   | 要約、凝縮、例示、翻訳、焦点 | 公開情報だけに基づく読者向け説明         |

### 自動判定する編集方針

ユーザーに選択 UI は出さず、対話内容から業務で使いやすい少数の編集方針を推定する。

| 編集方針     | 判定されやすい対話内容                           | 対応する編集技法       |
| ------------ | ------------------------------------------------ | ---------------------- |
| 要約         | 長い thread / document / report を短くしたい     | 要約、凝縮、引用       |
| 論点整理     | 何が問題か、何が決まっていないかを聞いている     | 分類、比較、境界、焦点 |
| リスク抽出   | 停滞、未決、依存、矛盾、懸念を聞いている         | 競合、推理、構造、生態 |
| 経緯整理     | いつ、誰が、なぜ判断したかを聞いている           | 系統、順番、注釈、場面 |
| 次アクション | 何をすべきか、次に確認すべきことを聞いている     | 道筋、脚本、統御       |
| 構造化       | 全体像、関係性、整理図に相当する説明を求めている | 地図、図解、構造、模型 |

## 設計方針

### Private Chat Agent

Private Chat Agent の instructions に、質問種別ごとの編集 planning を追加する。

- `vector-search` で関連 document / chunk を集める前に、質問の目的を軽く分類する。
- 事実確認では source の精度と引用を優先し、過度な推理を避ける。
- 状況把握やリスク分析では、複数 source の比較、競合、共鳴を確認する。
- 経緯整理では occurredAt、source type、actor hints、graph relation を使い、時系列と関係を混同しない。
- 企画支援では、根拠 source と Agent の仮説を明確に分ける。
- 回答には、結論、根拠、未確認事項、次アクションを質問に応じて出し分ける。

### Public Chat Agent

Public Chat では編集技法を表現支援に限定する。

- public report / public context bundle の範囲外を推測しない。
- 公開済み情報の要約、論点整理、読者向けの言い換えに使う。
- Private Chat のような raw / parsed / graph 横断の探索や内部リスク分析は行わない。
- 根拠は public report の section id または public source id だけで示す。

### Evidence Panel

Evidence Panel では、回答生成に使った `editing metadata` を tool call とは別の補助情報として扱う。

- Sources: 根拠 source と snippet。
- Graph: 関係探索の起点、関連 Actor / Topic / Document。
- Raw: raw read view / parsed preview。
- Runs: tool call、検索条件、エラー。
- Editing metadata: 任意で `classification`、`comparison`、`focus` などの編集操作ラベル、`inferredMode`、`questionType`、`confidence` を表示する。

初期実装では `editing metadata` を API response / eval fixture の metadata として扱い、UI では回答直下の折りたたみ補助情報として表示する。

## Step 構成

| Step | status      | 内容                                                     | 完了条件                                                                   |
| ---- | ----------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1    | `completed` | 編集方針の自動判定 contract と Agent planning 方針を定義 | system docs に自動判定、質問種別、public/private 差分が反映される          |
| 2    | `completed` | Private Chat Agent の instructions を更新                | 既存 chat eval が通り、要約 / 論点整理 / リスク抽出の fixture が通る       |
| 3    | `completed` | Chat API response に編集 metadata を追加                 | source / toolCalls と独立して inferredMode / operations / caveats を返せる |
| 4    | `completed` | 自動判定ロジックと fallback を実装                       | ユーザーが mode を選ばなくても対話内容から編集方針が推定される             |
| 5    | `completed` | Evidence Panel / Runs 表示を調整                         | tool call と編集操作 metadata を混同せず、必要時だけ確認できる             |
| 6    | `completed` | eval fixture と安全性 regression を追加                  | 根拠不足時の推測抑制、prompt injection 耐性、public chat 制約を確認する    |

## Step 1: 編集方針の自動判定 Contract と Planning 方針

### 実装範囲

- `docs/designs/system/07-chat.md` に編集 planning の方針を追加する。
- `docs/designs/ui/ui-layout.md` に、chat composer は通常の入力を維持し、編集方針 selector を持たせない方針を明記する。
- `docs/designs/ui/ui-design.md` に、必要時だけ metadata を補助表示する方針を追加する。
- inferred mode enum の候補を次に絞る。
  - `default`
  - `summary`
  - `issue_mapping`
  - `risk_scan`
  - `timeline`
  - `next_actions`
  - `structure`

### 受け入れ条件

- 64 技法をそのまま UI に露出せず、編集方針もユーザーに手動選択させない方針が明記されている。
- private / public chat で使える編集操作の差分が明記されている。
- 編集 planning は根拠確認の後段または tool planning の制御であり、source 制約を弱めないことが明記されている。
- 自動判定できない場合は `default` として扱い、回答品質や安全性を mode 推定に依存させない。

### 対応状況

- Issue #361 で `docs/designs/system/07-chat.md`、`docs/designs/ui/ui-layout.md`、`docs/designs/ui/ui-design.md` に selector なしの自動判定方針を反映した。

## Step 2: Private Chat Agent Instructions

### 実装範囲

- `project-chat-agent` の instructions に質問種別ごとの tool planning を追加する。
- `default` では現在の挙動を保ち、必要な場合だけ分類、比較、焦点化を行う。
- `risk_scan` と推定された場合は source を複数確認し、単一 source だけで断定しない。
- `timeline` と推定された場合は occurredAt / source locator / actor hints を優先して確認する。
- `next_actions` と推定された場合は根拠と推奨アクションを分けて回答する。

### 受け入れ条件

- 既存の private chat eval が通る。
- 根拠 source がない場合は「不明」と答え、編集技法による推測で埋めない。
- raw read view 内の instruction、token、email 風文字列が回答や tool call summary に漏れない。

### 対応状況

- Issue #361 で `requestContext.editing` を Project Chat Agent / Public Report Chat Agent の instructions に追加し、回答構成の補助としてのみ使う制約を明記した。

## Step 3: Chat API Response Metadata

### 実装範囲

- private chat response に編集 metadata を追加する。
- metadata は回答本文と source list から独立した optional field とする。
- metadata には内部思考の逐語的 chain-of-thought を含めない。

想定 shape:

```typescript
interface ChatEditingMetadata {
  readonly inferredMode: ChatEditingMode;
  readonly operations: readonly string[];
  readonly questionType:
    | 'fact'
    | 'status'
    | 'risk'
    | 'timeline'
    | 'planning'
    | 'public_explanation'
    | 'unknown';
  readonly confidence: 'low' | 'medium' | 'high';
  readonly caveats: readonly string[];
}
```

### 受け入れ条件

- metadata に raw body、secret、OAuth token、private storage URI、未 redaction の個人情報を含めない。
- tool call 表示と metadata 表示が独立している。
- 既存 client が metadata 未対応でも壊れない。
- `confidence` が低い場合でも、根拠確認と回答制約は通常どおり適用される。

### 対応状況

- Issue #361 で `ChatEditingMetadata` を追加し、private / public chat response と Mastra request context に `inferredMode`、`operations`、`questionType`、`confidence`、`caveats` を含めるようにした。

## Step 4: 自動判定ロジックと Fallback

### 実装範囲

- Chat Composer には mode selector を追加しない。
- API / Agent の入口で、ユーザー発話、直近の会話履歴、対象入口 private / public から編集方針を推定する。
- 推定は deterministic な lightweight classifier または LLM planning prompt のどちらかで実装する。初期実装では instructions 内の self-classification でよいが、eval で揺れが大きい場合は deterministic classifier へ切り出す。
- public chat では `risk_scan` や内部調査に見える質問でも public explanation / summary に制限する。
- mode 推定が低 confidence または複数候補で揺れる場合は `default` とし、必要なら回答内で確認質問を返す。

### 受け入れ条件

- 既存 request shape を変えずに動作する。
- ユーザーが mode を明示しなくても、要約 / 論点整理 / リスク抽出 / 経緯整理 / 次アクション化 / 構造化の代表質問で適切な inferredMode が返る。
- 判定不能な質問は `default` になる。
- UI は通常の chat 入力のままで、モバイル / desktop の composer レイアウトを変更しない。

### 対応状況

- Issue #361 で deterministic な keyword classifier を追加した。
- Public Chat では `risk_scan` を公開情報の説明に制限し、内部調査や未公開情報探索を示唆しない。

## Step 5: Evidence Panel / Runs 表示

### 実装範囲

- Evidence Panel または tool call detail に編集 metadata の compact 表示を追加する。
- 表示名は技法名の羅列ではなく、業務向けの短いラベルにする。
  - `要約`
  - `分類`
  - `比較`
  - `焦点化`
  - `時系列化`
  - `次アクション化`
- raw / parsed preview と編集 metadata を混同しない。

### 受け入れ条件

- どの source が根拠で、どの編集操作が回答構成の補助情報か区別できる。
- tool call error や truncation がある場合、metadata より source / tool call の制約が優先して表示される。

### 対応状況

- Issue #361 で AI 回答直下に compact な `Editing` details を追加した。Composer に mode selector は追加していない。

## Step 6: Eval / Safety Regression

### 実装範囲

- chat eval fixture に inferredMode 別の代表質問を追加する。
- `risk_scan` では複数 source が不足する場合に断定しないことを確認する。
- `timeline` では時系列根拠のない並び替えを避けることを確認する。
- public chat では public report 範囲外の編集支援を拒否することを確認する。
- prompt injection fixture で自動判定された編集方針が raw instruction を実行しないことを確認する。

### 受け入れ条件

- `pnpm chat:eval --project sample-a --fixture fixtures/chat/private-chat-eval.json` が通る。
- `pnpm chat:eval --project sample-a --fixture fixtures/chat/private-chat-raw-injection-eval.json` が通る。
- 追加 fixture で inferredMode / metadata / source 制約が確認できる。

### 対応状況

- Issue #361 で unit test と public chat e2e に inferredMode / metadata / selector 不在の検証を追加した。
- Issue #361 で `scripts/chat-eval.ts` に `expectEditingMode` を追加し、private / public / raw injection fixture で inferredMode を検証できるようにした。

## 完了条件

- Private Chat で要約、論点整理、リスク抽出、経緯整理、次アクション化、構造化の編集方針を対話内容から自動判定できる。
- Public Chat では公開情報だけを使った要約・論点整理に制限される。
- 回答は根拠 source と編集操作 metadata を分けて返す。
- Evidence Panel で source / graph / raw / runs と編集 metadata が混同されない。
- eval fixture で根拠不足時の推測抑制、prompt injection 耐性、public chat 制約を確認できる。
- 64 技法を直接露出せず、業務で使える少数の inferredMode に抽象化している。

## テスト計画

- Agent instruction / provider unit test:
  - inferredMode ごとに期待する planning hint が provider に渡る。
  - `default` で既存挙動を壊さない。
- API test:
  - inferredMode metadata validation。
  - response metadata validation。
  - low confidence / unknown question の fallback。
- UI test:
  - mode selector が存在しないこと。
  - モバイル / desktop で既存 composer が重ならない。
- eval:
  - summary / issue mapping / risk scan / timeline / next actions / structure の代表 fixture。
  - raw injection と public chat 範囲外質問の regression。

## 実装時の注意

- 編集技法は「推論を増やす」ためではなく、「根拠の集め方と回答の構造を選ぶ」ために使う。
- 根拠不足時は、編集的な見立てを断定として出さない。
- metadata には chain-of-thought を含めない。表示可能な短い操作ラベルと caveat に限定する。
- Public Chat では private source、raw read view、parsed JSON、internal graph に触れない。
- UI は mode 選択を持たず、通常の chat 入力を主役にする。
