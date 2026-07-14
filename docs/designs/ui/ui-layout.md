# Pufu Lens UI レイアウト設計

## 1. 目的

この文書は、Pufu Lens の Next.js フロントエンドにおける画面レイアウト、ナビゲーション、主要画面の領域構成を定義する。色、タイポグラフィ、形状、コンポーネントの見た目は [UI デザインシステム](ui-design.md) に従い、本書では画面全体の配置と情報設計に焦点を当てる。

Pufu Lens はプロジェクト単位で Gmail / Drive / GitHub / Web 由来の情報を収集し、チャット、レポート、管理画面から横断的に扱う業務アプリケーションである。そのため、レイアウトは「現在のプロジェクト」「情報源」「AI の回答・根拠」「運用状態」が常に追いやすい構造にする。

## 2. レイアウト原則

- **プロジェクト文脈を固定する:** プロジェクト配下の画面では、左ナビゲーションとヘッダーで現在のプロジェクトを常に表示する。
- **作業領域を広く保つ:** チャット、レポート、データソース管理はいずれも情報密度が高いため、メイン領域を最優先し、装飾的な余白を増やしすぎない。
- **AI の補助情報を右側に分離する:** 根拠、参照ドキュメント、実行中のツール、関連グラフは右サイドパネルに置き、本文の読解を妨げない。
- **運用状態を一覧化する:** 収集、取り込み、レポート生成、連携状態は、詳細画面に入らなくてもサイドバーまたは各画面のヘッダーで把握できるようにする。
- **モバイルでは縦方向に畳む:** サイドバーと AI パネルはオーバーレイ化し、主要操作は下部またはヘッダーのボタンから開けるようにする。

## 3. アプリケーションシェル

### 3.1 デスクトップ構成

デスクトップ幅では、画面全体を次の 4 領域で構成する。

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Top Bar                                                                    │
├───────────────┬──────────────────────────────────────┬─────────────────────┤
│ Global Nav    │ Main Workspace                       │ AI / Context Panel  │
│ 280px         │ fluid 12 column grid                  │ 360px - 480px       │
└───────────────┴──────────────────────────────────────┴─────────────────────┘
```

| 領域               |            幅 | 役割                                                 |
| ------------------ | ------------: | ---------------------------------------------------- |
| Top Bar            |     高さ 56px | プロジェクト切替、検索、ユーザーメニュー、同期状態   |
| Global Nav         |    280px 固定 | プロジェクト内ナビゲーション、管理メニュー、接続状態 |
| Main Workspace     |          可変 | 各画面の主作業領域。12 カラムフルードグリッドを使う  |
| AI / Context Panel | 360px - 480px | 根拠、参照ドキュメント、関連ノード、AI 実行状態      |

`Main Workspace` の左右余白は `32px`、セクション間隔は `24px` を基本にする。データテーブルやツリーでは縦方向の密度を高め、行高は `40px` から `48px` を標準とする。

### 3.2 タブレット構成

`1024px` 未満では右側の AI / Context Panel を閉じた状態にし、ヘッダーのボタンからドロワーとして開く。Global Nav は `240px` まで縮小し、ナビゲーションラベルは維持する。

```text
┌──────────────────────────────────────────────┐
│ Top Bar                                      │
├────────────┬─────────────────────────────────┤
│ Global Nav │ Main Workspace                  │
│ 240px      │ AI Panel は右ドロワー            │
└────────────┴─────────────────────────────────┘
```

### 3.3 モバイル構成

`768px` 未満では Global Nav と AI / Context Panel をどちらもフルスクリーンまたは下部シートのオーバーレイにする。メイン画面は 1 カラムで表示し、左右余白は `16px` とする。

```text
┌─────────────────────────┐
│ Top Bar                 │
├─────────────────────────┤
│ Main Workspace          │
│ 1 column                │
├─────────────────────────┤
│ Bottom Action Area      │
└─────────────────────────┘
```

モバイルでは、チャット入力や主要 CTA など継続操作に関わる要素を画面下部に固定できる。ただし、固定要素が本文やフォーム送信ボタンを覆わないよう、メイン領域の下余白を明示的に確保する。

## 4. ナビゲーション構造

### 4.1 ルート

想定する主要ルートは次のとおり。

| ルート                                       | 画面                       | レイアウト                         |
| -------------------------------------------- | -------------------------- | ---------------------------------- |
| `/projects`                                  | プロジェクト一覧           | 管理シェル                         |
| `/projects/[projectSlug]/chat`               | プロジェクトチャット       | プロジェクトシェル + AI パネル     |
| `/projects/[projectSlug]/graph`              | Graph Viewer               | プロジェクトシェル                 |
| `/projects/[projectSlug]/reports`            | レポート一覧               | プロジェクトシェル                 |
| `/projects/[projectSlug]/reports/[reportId]` | レポート詳細               | プロジェクトシェル + Context Panel |
| `/reports/public/[projectSlug]/[reportId]`   | 公開レポート詳細           | 公開シェル                         |
| `/members`                                   | Accounts 管理              | 管理シェル                         |
| `/projects/[projectSlug]/members`            | プロジェクトメンバー管理   | プロジェクトシェル                 |
| `/projects/[projectSlug]/admin/actors`       | Actor 一覧・名寄せ候補確認 | プロジェクトシェル                 |
| `/projects/[projectSlug]/admin/data-sources` | データソース管理           | プロジェクトシェル                 |
| `/admin/projects`                            | 全体プロジェクト管理       | 管理シェル                         |
| `/admin/projects/new`                        | プロジェクト作成           | 管理シェル                         |
| `/admin/connections`                         | Google / GitHub 連携管理   | 管理シェル                         |

### 4.2 Global Nav

Global Nav はプロジェクト配下で次の順に並べる。

1. プロジェクトスイッチャー
2. 主要機能
   - Overview
   - Chat
   - Reports
   - Graph
   - Members（メンバーのみ）
   - Actors（project admin のみ）
   - Data Sources（project admin のみ）
3. 管理
   - Project Settings
4. 連携状態
   - Google
   - GitHub
5. 最終同期・直近エラー

ナビゲーション項目はアイコン + ラベルを基本にする。アクティブ状態は Primary Blue の左ボーダーまたは背景トーンで示し、色だけに依存しない。

### 4.3 Top Bar

Top Bar は次の要素を持つ。

| 要素                 | 配置 | 備考                                         |
| -------------------- | ---- | -------------------------------------------- |
| サイドバー開閉       | 左   | タブレット以下で表示                         |
| 現在のプロジェクト名 | 左   | プロジェクト配下で常時表示                   |
| グローバル検索       | 中央 | プロジェクト内検索を優先                     |
| 同期状態             | 右   | `active` / `syncing` / `failed` をバッジ表示 |
| ユーザーメニュー     | 右   | アカウント、ログアウト                       |

## 5. 主要画面

### 5.1 プロジェクト一覧

`/projects` はログイン後の入口であり、ユーザーが参加しているプロジェクトを一覧する。

```text
┌────────────────────────────────────────────────────────────┐
│ Header: Projects                          [New Project]    │
├────────────────────────────────────────────────────────────┤
│ Filter / Search                                             │
├─────────────────────┬─────────────────────┬────────────────┤
│ Project Card         │ Project Card         │ Project Card    │
└─────────────────────┴─────────────────────┴────────────────┘
```

各プロジェクトカードには、プロジェクト名、説明、最終更新、取り込み状態、直近レポートへのリンクを表示する。カードは情報の入口として使い、過度な装飾は避ける。

### 5.2 チャット画面

`/projects/[projectSlug]/chat` は、プロジェクト知識グラフへの問い合わせを行う主画面である。

```text
┌───────────────┬──────────────────────────────────────┬─────────────────────┐
│ Global Nav    │ Chat Thread                          │ Evidence Panel      │
│               │                                      │                     │
│               │ ┌──────────────────────────────────┐ │ Sources             │
│               │ │ Message List                     │ │ Graph Hops          │
│               │ └──────────────────────────────────┘ │ Tool Calls          │
│               │ ┌──────────────────────────────────┐ │ Raw / Parsed Docs   │
│               │ │ Composer                         │ │                     │
│               │ └──────────────────────────────────┘ │                     │
└───────────────┴──────────────────────────────────────┴─────────────────────┘
```

Chat Thread はメッセージ一覧と Composer に分ける。Composer は画面下部に固定し、送信中も入力欄の高さが急に変化しないようにする。編集方針は対話内容から自動判定するため、Composer に mode selector は置かない。AI メッセージには回答本文、参照元、生成状態を分けて表示し、詳細な根拠は Evidence Panel に送る。

Evidence Panel には次をタブで表示する。

| タブ    | 内容                                            |
| ------- | ----------------------------------------------- |
| Sources | `document_id`、`canonical_uri`、スニペット      |
| Graph   | 起点ドキュメントと関連 Actor / Topic / Document |
| Raw     | 原本または parsed JSON のプレビュー             |
| Runs    | ツール呼び出し、検索条件、編集 metadata、エラー |

モバイルでは Evidence Panel を「Sources」ボタンから開く下部シートにする。

### 5.3 Graph 画面

`/projects/[projectSlug]/graph` は、固定 query preset で project graph の node / edge を確認する画面である。project member は private Graph API を使い、Document ノード選択時の chunk 一覧と chunk 詳細を表示できる。

公開 project では、未ログインユーザーと signed-in 非 member も同じ Project Shell / Global Nav から Graph に遷移できる。public Graph ページは `/api/public/projects/[projectSlug]/graph` だけを呼び出し、Document chunk 一覧と chunk 詳細は表示しない。

主要 `data-testid`:

- `global-nav-graph`
- `graph-viewer-panel`
- `graph-control-panel`
- `graph-result-count`

### 5.4 レポート一覧

`/projects/[projectSlug]/reports` は生成済みレポートの履歴を表示する。

```text
┌────────────────────────────────────────────────────────────┐
│ Reports Header                       [Generate Report]      │
├────────────────────────────────────────────────────────────┤
│ Period Filter / Search / Status Filter                      │
├────────────────────────────────────────────────────────────┤
│ Report Table                                                │
│ Title | Period | Generated At | Summary | Status | Actions  │
└────────────────────────────────────────────────────────────┘
```

レポート一覧はテーブルを基本にし、期間、生成日時、要約、生成者、公開状態を比較しやすくする。生成ボタンはヘッダー右側に置き、生成中は進行中バッジと無効化状態を表示する。

### 5.5 レポート詳細

`/projects/[projectSlug]/reports/[reportId]` は JSON レポートを読みやすい文書として描画する。

```text
┌───────────────┬──────────────────────────────────────┬─────────────────────┐
│ Global Nav    │ Report Document                      │ Report Context      │
│               │                                      │                     │
│               │ Summary                              │ Outline             │
│               │ Sections                             │ Sources             │
│               │ Metrics                              │ Related Reports     │
│               │ Source List                          │ Export / Share      │
└───────────────┴──────────────────────────────────────┴─────────────────────┘
```

Report Document は文書本文として読みやすい幅を保つ。本文カラムは最大 `880px` を目安にし、表やメトリクスがあるセクションだけ 12 カラム幅へ拡張できる。Report Context にはアウトライン、出典、関連レポート、共有操作を置く。 `custom_layout` を持つレポートでは、標準の Sections 表示に代えて template snapshot の row / columns / title / fixed text / image placeholder / slider judgement / classification result / copyright を同じ Report Document 内に描画する。private と public の表示差分はアクセス制御と非公開 source 表示の扱いに限定し、custom layout の構造と判定結果は同じ JSON snapshot を使う。

公開レポートページ `/reports/public/[projectSlug]/[reportId]` では、公開済み report 本文だけを表示する。Project Shell の side menu / Global Nav は引き続き表示し、Overview / Chat / Reports / Graph など公開 project 向けの導線（Graph リンクを含む）を提供する。private 専用の admin ナビや Evidence Panel は表示しない。Graph Viewer は公開レポートページには埋め込まず、`/projects/[projectSlug]/graph` で確認する。

### 5.6 データソース管理

`/projects/[projectSlug]/admin/data-sources` は、Gmail / Drive / GitHub / Web の収集条件と状態を管理する。

```text
┌────────────────────────────────────────────────────────────┐
│ Data Sources Header                  [Add Source]           │
├────────────────────────────────────────────────────────────┤
│ Source Type Tabs: Gmail | Drive | GitHub | Web              │
├──────────────────────────────┬─────────────────────────────┤
│ Source List / Table          │ Selected Source Detail       │
│                              │ Settings: config / collect   │
│                              │ Content: documents / snippet │
│                              │ Queue: failed / held / pending│
└──────────────────────────────┴─────────────────────────────┘
```

デスクトップでは左に一覧、右に選択中データソースの詳細を置く。詳細 panel は `Settings | Content | Queue` の 3 区切りとし、設定フォームと preview を混在させない。Content では summary metrics と compact document list、Queue では代表 queue item を表示する。snippet は横スクロールではなく折り返し、mobile では 1 カラムで重ならない compact list を優先する。

主要 `data-testid`:

- `data-source-settings-section`
- `data-source-content-panel`
- `data-source-content-document-row`
- `data-source-content-snippet`
- `data-source-content-empty`
- `data-source-queue-preview`

フォーム項目は `config` と `ingest_window` を分け、保存、テスト接続、手動収集実行を明確に分離する。

モバイルでは一覧から詳細ページまたはフルスクリーンドロワーに遷移する。設定フォームは 1 カラムにし、保存ボタンはフォーム末尾と下部固定アクションの両方で押せるようにする。

### 5.7 Actor 管理

`/projects/[projectSlug]/admin/actors` は、project scope の Actor と alias を確認し、必要に応じて手動で Actor を統合する。

```text
┌────────────────────────────────────────────────────────────┐
│ Actors Header + Status Filter                              │
├────────────────────────────────────────────────────────────┤
│ Manual Merge Details (collapsed by default)                 │
├────────────────────────────────────────────────────────────┤
│ Actors Table                                                │
│ Actor | Status | Alias | Sources | Primary | Graph node     │
└────────────────────────────────────────────────────────────┘
```

Actor 一覧では表示名、status、alias 数、source type、primary alias、graph node を一覧する。status filter は `active` を既定とし、`all` / `merged` / `disabled` を選択できる。Actor 名から詳細画面へ遷移し、基本情報、alias、無効化状態、関連する merge 判断履歴を確認できる。

Actor 統合は特殊操作として通常は折りたたみ、展開後に active Actor の select から統合先と統合対象を選択する。project admin が merge を確定した場合は、代表 Actor に alias と relational 参照を寄せ、吸収元 Actor は物理削除せず `merged` status と `merged_into_actor_id` で無効化管理する。AGE graph の Actor node / edge は relational merge 後に best-effort で reconcile し、graph 側の欠損・重複・未 materialize などで即時反映できない場合は後続の graph materialize / reconcile で代表 Actor に寄せる。

### 5.8 メンバー管理

`/members` は `admin` / `member` role のログインユーザーが使う Accounts 一覧画面である。登録、全体 role 編集、Credentials password 更新は global admin のみに表示する。一覧上では行内編集を行わず、各行の Edit から開くダイアログで編集する。

`/projects/[projectSlug]/members` はプロジェクトメンバーを管理する。表示は対象 project の member であれば可能とし、global admin は全 project の一覧に表示する。追加は global admin または project admin のみに制限し、role 変更 UI は置かない。解除は `member` のみ可能で、`admin` は解除不可とする。

```text
┌────────────────────────────────────────────────────────────┐
│ Members Header                       [Invite Member]        │
├────────────────────────────────────────────────────────────┤
│ Members Table                                               │
│ Name | Email | Role | Last Active | Actions                 │
└────────────────────────────────────────────────────────────┘
```

権限変更は行内セレクトまたは確認付きメニューで行う。自分自身の権限を下げる操作、最後の管理者を削除する操作は確認ダイアログを必須にする。

### 5.9 連携管理

`/admin/connections` はユーザー単位の Google / GitHub OAuth 連携を管理する。

```text
┌────────────────────────────────────────────────────────────┐
│ Connections Header                                          │
├──────────────────────────────┬─────────────────────────────┤
│ Google Connection             │ GitHub Connection            │
│ Scopes                        │ Scopes                       │
│ Token Status                  │ Token Status                 │
│ [Connect / Reconnect]         │ [Connect / Reconnect]        │
└──────────────────────────────┴─────────────────────────────┘
```

OAuth scope はユーザーが収集範囲を理解できるよう、プロバイダー別に分けて表示する。token や secret の値は画面に出さず、状態、期限、最終更新だけを表示する。

## 6. 共通パターン

### 6.1 ページヘッダー

ページヘッダーは、画面タイトル、短い補助情報、主要アクション、補助アクションを含む。

```text
┌────────────────────────────────────────────────────────────┐
│ Title / Subtitle                         Primary Action     │
│ Metadata / Status                        Secondary Actions  │
└────────────────────────────────────────────────────────────┘
```

タイトルは `headline-md`、補助情報は `body-sm` または `label-sm` を使う。主要アクションは 1 つに絞り、複数の操作が必要な場合はメニューにまとめる。

### 6.2 テーブル

テーブルは業務操作の中心になるため、次の仕様を標準にする。

- ヘッダー固定は必要な画面だけに限定する。
- 行高は通常 `48px`、Compact 表示では `40px` とする。
- 行クリックと行内ボタンの操作領域を分ける。
- ステータス、日時、外部 ID、source type は横幅が安定するよう最小幅を指定する。
- 空状態では次に取るべき操作を 1 つだけ提示する。

### 6.3 フォーム

フォームは `max-width: 720px` を基本にする。接続設定やデータソース設定のようにプレビューやログを同時に見る画面では、左にフォーム、右に検証結果を配置する。

入力はラベル、説明、入力欄、エラーの順で縦に積む。エラー表示でレイアウトが跳ねないよう、フィールド下部の余白を確保する。

### 6.4 パネルとドロワー

一時的な詳細表示にはドロワーを使う。ドロワーは以下の用途に限定する。

- AI の根拠表示
- データソース詳細
- 原本 / parsed JSON プレビュー
- 生成レポートの補助情報

ドロワー内にさらにカードを重ねすぎず、区切り線とセクション見出しで情報を分ける。

## 7. レスポンシブ基準

|                幅 | 呼称           | 方針                                   |
| ----------------: | -------------- | -------------------------------------- |
|       `>= 1280px` | Desktop        | Global Nav、Main、AI Panel の 3 ペイン |
| `1024px - 1279px` | Narrow Desktop | AI Panel を折り畳み、Main を広げる     |
|  `768px - 1023px` | Tablet         | Global Nav を縮小、AI Panel はドロワー |
|         `< 768px` | Mobile         | 1 カラム、Nav と Panel はオーバーレイ  |

レスポンシブ時も、主要操作の位置が画面ごとに大きく変わらないようにする。たとえばレポート生成、データソース追加、チャット送信は、常にヘッダー右側または画面下部の明確な操作領域に置く。

## 8. アクセシビリティとテスト

- キーボード操作で Top Bar、Global Nav、Main、Context Panel の順に移動できるようにする。
- フォーカスリングは Primary Blue を使い、背景とのコントラストを確保する。
- ステータスは色だけでなくラベルとアイコンで表現する。
- モーダル、ドロワー、下部シートはフォーカストラップと `Esc` でのクローズを実装する。
- ボタン、入力、フォーム、重要な表示には安定した `data-testid` を付与する。
- `data-testid` は `{component}-{element-role}` 形式を基本にする。

主要な `data-testid` 例:

| 対象             | 例                         |
| ---------------- | -------------------------- |
| プロジェクト切替 | `project-switcher-trigger` |
| チャット入力     | `chat-composer-input`      |
| チャット送信     | `chat-composer-submit`     |
| 根拠パネル       | `evidence-panel-root`      |
| レポート生成     | `reports-generate-button`  |
| データソース追加 | `data-sources-add-button`  |
| データソース保存 | `data-source-form-save`    |

## 9. 実装メモ

- Next.js の `app` ディレクトリでは、プロジェクト配下に `layout.tsx` を置き、Project Shell を共有する。
- Chat、Reports、Admin は同じ Project Shell を使い、Main Workspace の中身だけを差し替える。
- AI / Context Panel は画面ごとの内容を差し替えられるよう、Shell から slot または context provider で制御する。
- API 通信、状態管理、UI 表示の責務は分ける。特にチャットストリームと Evidence Panel の状態は密結合させすぎない。
- Google Workspace データ、個人情報、OAuth token、secret は画面に直接表示しない。ログやエラー表示でもマスク済みの要約に留める。
