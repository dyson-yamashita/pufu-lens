# E2E シナリオ

このディレクトリは Playwright で、Pufu Lens の主要な利用者導線と公開 API の安全性を確認する。個々の spec は UI コンポーネント単位ではなく、ユーザー行動または攻撃入力のシナリオ単位で読む。

## 実行

```bash
pnpm --filter @pufu-lens/web test:e2e
pnpm --filter @pufu-lens/web test:e2e -- --project desktop
pnpm --filter @pufu-lens/web test:e2e -- --project mobile
pnpm --filter @pufu-lens/web test:e2e -- --project api
pnpm --filter @pufu-lens/web test:e2e -- --grep "scenario:"
```

`apps/web/playwright.config.ts` は `desktop` / `mobile` / `api` の 3 project を定義し、`http://localhost:3000` の Next.js dev server を起動または再利用する。

- `desktop`: 通常 UI シナリオ（`@mobile` / `@api` タグ付き test を除く）
- `mobile`: mobile 固有 viewport シナリオ（`@mobile` タグ付き test のみ）
- `api`: route handler 到達の API 安全性シナリオ（`@api` タグ付き test のみ。Chromium desktop 設定で 1 回だけ実行）

`pnpm test:e2e` は全 project を走らせるが、各シナリオを desktop / mobile の両方で重複実行しない。mobile 固有・API 専用の coverage はそれぞれ専用 project で 1 回ずつ実行する。

admin user シナリオは credentials login を使うため、実行環境に
`PUFU_LENS_E2E_ADMIN_EMAIL` と `PUFU_LENS_E2E_ADMIN_PASSWORD` がない場合は skip される。

## シナリオ一覧

| シナリオ                          | spec                | ロール                  | 対象                                                        | project            | データ境界            | 期待結果                                                                             |
| --------------------------------- | ------------------- | ----------------------- | ----------------------------------------------------------- | ------------------ | --------------------- | ------------------------------------------------------------------------------------ |
| Public project discovery          | `admin-ui.spec.ts`  | public user             | `/projects`                                                 | desktop            | fixture DB            | public project が見え、カード内の report 一覧と admin / private project 導線は出ない |
| Admin route rejection             | `admin-ui.spec.ts`  | public user             | admin data sources / ingestion / parser profiles / settings | desktop            | fixture DB            | 未ログインでは login に戻り、管理情報が描画されない                                  |
| Admin operation controls          | `admin-ui.spec.ts`  | admin user              | data sources / ingestion / parser profiles / settings       | desktop            | real DB + credentials | 運用画面の主要 control が安定した `data-testid` で操作・確認できる                   |
| Private chat answer rendering     | `chat-ui.spec.ts`   | member user             | private chat UI                                             | desktop            | API mock              | 質問送信後に answer、source、tool call が表示される                                  |
| Private report list to detail     | `report-ui.spec.ts` | member user             | private report list / detail                                | desktop            | API mock              | 一覧から詳細へ遷移し、summary、section、pufu score が表示される                      |
| Private report mobile readability | `report-ui.spec.ts` | member user             | private report detail                                       | mobile (`@mobile`) | API mock              | 主要 section が mobile viewport で表示される                                         |
| Private report error visibility   | `report-ui.spec.ts` | member user             | private report list / detail                                | desktop            | API mock              | API error code が UI に表示される                                                    |
| Public report redaction and chat  | `report-ui.spec.ts` | public user             | public report / public chat                                 | desktop            | API mock              | redacted artifact のみ表示し、公開範囲内質問に回答し、未公開情報要求を拒否する       |
| Public API unsafe input rejection | `report-ui.spec.ts` | public / hostile client | public report/chat API、publish API                         | api (`@api`)       | real route handler    | path traversal、過長質問、不正 body を拒否する                                       |

## 不足観点

- ログイン済み admin の E2E は credentials 環境変数がある場合に実行する。member / 非 admin の project 境界は追加の fixture user 整備後に拡張する。
- `/projects` のログイン状態別 matrix は `docs/plans/002-account-login-public-projects/overview.md` の Step 4 / Step 5 と同期して追加する。
- private route / private API への非 member、非 admin アクセス拒否は、認証境界の実装と合わせて E2E または route test に追加する。
- report 生成、公開、public report 閲覧、public chat までを実 API / fixture DB でつなぐ統合シナリオは未整備。現在は UI シナリオを API mock で安定化し、API 安全性は route handler で確認している。
- viewport ごとのレイアウト崩れは `@mobile` タグ付きシナリオと `mobile` project で確認する。全 UI シナリオを desktop / mobile で二重実行はしない。スクリーンショット比較は導入していない。

## 追加時の基準

- test 名は `scenario: <role> <action> <expected outcome>` の形を基本にする。
- mobile 固有の可読性や重なりは `@mobile` タグを付け、`mobile` project で実行する。
- storage key、path traversal、過長入力、不正 JSON などの安全性は `@api` タグを付け、`api` project で route handler に到達する API test として追加する。
- UI の正常系は API mock を使い、表示・操作・redaction の期待値を安定して確認する。通常 UI シナリオには `@mobile` / `@api` を付けない。
