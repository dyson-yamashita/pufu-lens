# カスタムレポートレイアウト

## 概要

プ譜レポートを、標準の日時範囲指定レポートに加えて、プロジェクトごとの用途に合わせたカスタムレポート形式で生成・表示できるようにする。カスタム形式は、ユーザーが許可済みパーツを組み合わせる「安全プリセット+編集」を v1 方針とし、任意コード実行や外部 plugin の自動ロードは扱わない。

カスタム形式は template JSON として export / import できる。あるプロジェクトで作った形式を別プロジェクトへ移し、同じレイアウト、判定指示、画像 asset の対応関係を再利用できるようにする。

## 方針

- 既存の private / public report 境界を維持し、private report JSON を Object Storage に保存する現在の配信方針を壊さない。
- 標準レポートは従来どおり日時範囲指定で生成できるようにし、カスタムレポート形式は追加選択肢として扱う。
- カスタム template で使えるパーツは server-side registry の許可リストに限定する。
- v1 のパーツは `title`、`pufu_board`、`slider_judgement`、`classification_result`、`fixed_text`、`fixed_image`、`columns`、`row`、`divider`、`copyright` とする。
- `fixed_image` はロゴ専用ではなく、ユーザーが任意画像を配置するための汎用画像パーツとする。ロゴを入れたい場合も `fixed_image` にロゴ画像を設定する。
- PDF ダウンロードはサーバー生成を前提にし、private / public の認可と公開境界を API 側で揃える。

## データモデルと template schema

カスタムレポート形式は、project に属する template と画像 asset として管理する。

- `custom_report_templates`
  - project id、template id、name、description、schema version、layout JSON、作成者、更新者、公開/有効状態を持つ。
  - template JSON は許可済み part type、part id、表示順、columns / row 構造、判定ロジック設定、asset 参照だけを持つ。
- `custom_report_assets`
  - project id、asset id、Object Storage URI、content type、byte size、表示名、作成者を持つ。
  - `fixed_image` と `classification_result` の画像は同じ asset 管理を使う。
  - 過去 report が参照する asset は物理削除せず、soft delete / disabled 状態で新規 template からの選択だけを止める。
- `report_template_runs`
  - 生成時に使った template id、template version、template snapshot hash、判定結果 summary を保存する。
  - 後から template や asset が編集されても過去 report の表示が変わらないよう、生成時点の layout snapshot と asset 参照 snapshot を report に固定する。

既存 `reports` metadata と private report JSON は互換性を維持する。カスタム生成結果は private report JSON の `custom_layout` などの optional field に保存し、`custom_layout` は renderer がそのまま使える生成時 snapshot として扱う。標準 report renderer はこの field がない場合に従来表示を続ける。

template export は、template JSON と asset manifest を 1 つの JSON artifact として出力する。asset manifest は export 内の安定した `export_asset_key` と元の asset metadata を持ち、template JSON 内の画像参照も `asset_id` ではなく `export_asset_key` で表す。import 時は画像再登録で新しい `asset_id` を発行し、`export_asset_key` と新 `asset_id` の mapping で template JSON の参照を置き換える。import 時は schema version、part type、part id 一意性、columns / row の構造、layout tree のネスト深度上限、循環参照の不存在、未解決 asset 参照、判定プロンプト長、画像 MIME / サイズ、path traversal を検証し、renderer に構造破損した template を渡さない。import は任意 module path や任意コードを受け付けない。

## 生成 workflow

レポート生成 UI は、標準形式とカスタム形式を選択できるようにする。

- 標準形式
  - 現在の日時範囲指定を維持し、既存 `generate-report` 経路を使う。
- カスタム形式
  - project admin が登録した template を選択する。
  - レポート期間は標準 report と同じ start / end を使う。
  - report provider は既存の parsed / graph / vector / raw supplement context から、template の判定パーツに必要な入力を組み立てる。

判定ロジックはパーツ単位で実行する。

- `slider_judgement`
  - 判定プロンプト、左ラベル、右ラベル、score range を template に持つ。
  - 生成結果は 0-100 の score、表示ラベル、短い理由、参照 source を保存する。
- `classification_result`
  - 判定プロンプト、category key 一覧、category ごとのタイトル、説明、画像 asset を template に持つ。
  - 生成結果は category key、タイトル、説明、理由、参照 source を保存する。
- `fixed_text` / `fixed_image` / `copyright`
  - 生成時に LLM 判定を使わず、template の固定値をそのまま描画用 result に展開する。

判定プロンプトに渡す入力は project/report context、プ譜 source、report sections、必要に応じた raw read view supplement に限定する。private report JSON や public artifact には、raw document id、private locator、内部 storage URI、secret、未公開 raw excerpt を保存しない。

## 管理 UI と表示

project admin はカスタムレポート形式を管理できる。

- template 一覧、作成、複製、編集、無効化を提供する。
- パーツ追加、並び替え、行追加、カラム分割、固定テキスト、汎用 `fixed_image`、判定プロンプト、分類画像 map を編集できる。
- template export / import を提供し、import preview で追加される template と asset を確認できるようにする。

レポート詳細表示は、既存 `ReportDocument` / `PublicReportDocument` に custom layout renderer を追加する。

- `custom_layout` がない report は従来の標準 report 表示を使う。
- `custom_layout` がある report は template snapshot と生成結果に従って、タイトル、プ譜、スライダー、分類結果画像、任意画像、固定テキスト、行/カラムを描画する。
- public report でも private report と同じ JSON を描画し、公開可否は project visibility と report `is_public` metadata を正とする。

## PDF ダウンロード

PDF はサーバー生成を採用する。

- private API: `GET /api/projects/[projectSlug]/reports/[reportId]/pdf`
- public API: `GET /api/public/projects/[projectSlug]/reports/[reportId]/pdf`

private API は project member / admin 認可後に PDF を生成する。public API は public project かつ `reports.is_public = true` の report だけ PDF を返す。どちらも DB の業務時間外制約や既存 report API の access / 404 contract と揃える。

PDF 生成は report detail と同じ renderer を使い、PDF 専用 CSS でページ幅、余白、画像サイズ、カラム折り返しを固定する。生成された PDF には private raw locator、内部 storage URI、token、secret、API key、メールアドレス等の PII が含まれていないことを regression で確認する。

## Step

| Step | status      | 内容                                      | 完了条件                                                                                                  |
| ---- | ----------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1    | `completed` | template / asset / run の data model 設計 | Issue #379。migration、runtime guard、import/export schema、保存先が確定している                          |
| 2    | `completed` | template 管理 UI                          | project admin が template を作成・編集・export/import できる（Issue 作成は環境に gh/remote がなく未実施） |
| 3    | `completed` | カスタム report 生成                      | 標準 report と custom report を選択生成でき、判定結果が JSON に残る                                       |
| 4    | `planned`   | custom layout renderer                    | private/public report detail が custom layout を描画できる                                                |
| 5    | `planned`   | PDF ダウンロード                          | private/public API で認可どおり PDF を取得できる                                                          |
| 6    | `planned`   | セキュリティ・公開境界の regression       | import、asset、PDF、public report で private data 混入を防ぐテストがある                                  |

## テスト方針

- template schema validation: 不正 part type、壊れた columns、未知 asset、過大 prompt、危険な image path を拒否する。
- import/export: export した template を別 project に import し、同じ layout と判定設定が再現される。
- report generation: 標準 report と custom report の両方が生成でき、既存 `schema_version: "v1"` 表示が壊れない。
- rendering: private/public の custom report で `fixed_image`、slider、classification image、columns、copyright が表示される。
- PDF: private/public の PDF download が認可どおり動き、PDF 内に private raw locator、storage URI、secret、メールアドレス等が混入しない。
- regression: `pnpm --filter @pufu-lens/web test`、`pnpm typecheck`、必要に応じて Playwright で report UI と PDF download を確認する。

## 実装時の決定事項

- PDF 生成はサーバー側 HTML renderer から PDF を生成する方式を採用する。engine は Step 5 の実装時に既存 Next.js runtime / deploy 制約に合うものを選び、API contract はこの plan の private / public PDF endpoint に固定する。
- asset export は template JSON と asset manifest を export し、import 先 project で画像を再登録する導線を v1 とする。画像 binary の JSON 同梱は v1 では扱わない。
- `custom_layout` は private report JSON の optional field として保存する。別 artifact 分離は artifact size や PDF 生成性能の問題が出た場合の後続改善とする。

## 関連 Issue

- Issue #377
- Issue #379
