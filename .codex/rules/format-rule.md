# Pufu Lens Format / Lint ルール

## 1. 目的

この文書は、Pufu Lens の lint / formatter の標準ツール、script、運用ルールを定義する。

初期構築では、実装前のドキュメント中心 repo と、TypeScript 実装開始後で標準ツールを分ける。

## 2. 現行 toolchain

- TypeScript / TSX / JavaScript / JSX / JSON / JSONC の lint と formatter は Biome を使う。
- Markdown / YAML の整形は Prettier を使う。
- Markdown の構文検査は `markdownlint-cli2` を使う。
- 型検査は TypeScript `tsc --noEmit` を使う。
- unit / integration test は Vitest ではなく Node.js の test runner と `node --experimental-strip-types` 実行を使う。
- E2E は Playwright を使い、`apps/web` の `test:e2e` script から実行する。
- Oxlint は導入していない。Biome で足りない framework 固有ルールが必要になった場合だけ、別途 Issue / PR で導入を判断する。

## 3. 現行 script

- `pnpm format`: `biome check --write .` と Prettier write を実行する。
- `pnpm format:check`: `biome check .` と Prettier check を実行する。
- `pnpm lint`: `biome ci .` と `markdownlint-cli2` を実行する。
- `pnpm typecheck`: Turborepo の workspace typecheck と `pnpm scripts:typecheck` を実行する。
- `pnpm scripts:typecheck`: `tsconfig.scripts.json` で `scripts/**/*.ts` を検査する。
- `pnpm scripts:test`: `scripts/**/*.test.ts` の unit test を実行する。
- `pnpm test`: `pnpm scripts:test` の後に Turborepo の workspace test を実行する。
- `pnpm test:e2e`: `@pufu-lens/web` の Playwright E2E を実行する。
- `pnpm build`: Turborepo の workspace build を実行する。

## 4. 実行ルール

- 変更範囲に応じて最小限の targeted check を先に実行し、PR 前には原則として関連する root script を実行する。
- ドキュメント / workflow / 設定だけの変更でも、`pnpm format:check` と `pnpm lint` の対象になることを確認する。
- TypeScript、script、package 境界、runtime guard に触れた場合は `pnpm typecheck` または対象 workspace の typecheck を実行する。
- unit / integration test の対象実装に触れた場合は、対象 workspace test と必要に応じて root `pnpm test` を実行する。
- UI、route handler、認証導線、private / public chat、report 表示に触れた場合は、関連する Playwright E2E または route test を実行する。
- DB migration、`init.sql`、schema drift に触れた場合は `pnpm scripts:test`、`pnpm db:migrate --check`、`pnpm db:schema-drift` の要否を判断する。
- `pnpm lint` は未追跡 Markdown も `markdownlint-cli2` の glob 対象に入る。ユーザー由来の未追跡ファイルで失敗する場合は、そのファイルを勝手に修正せず、最終報告に失敗理由を明記する。

## 5. Docstring / JSDoc ルール

### 5.1 必須対象

TypeScript / TSX / JavaScript / JSX で、次の declaration を新規追加する場合、または既存の契約・責務を変更する場合は、宣言直前に `/** ... */` 形式の docstring / JSDoc を記載または更新する。

- `export` する function、class、React component、custom hook、公開 method。
- server action、route handler、use case、repository、adapter、runner、CLI entrypoint など、module 外または処理境界から呼ばれる entrypoint。
- 認可、project scope、runtime validation、transaction、外部 API、storage、retry、idempotency など、呼び出し側が誤用しやすい契約を持つ function / class。

### 5.2 記載内容

- 最初の文で、識別子名の言い換えではなく「何のために、どの境界で何をするか」を簡潔に説明する。
- parameter と return value は、型だけでは分からない意味、単位、scope、null / empty の意味、順序制約がある場合に `@param` / `@returns` で説明する。
- 呼び出し側が考慮すべき例外、拒否条件、副作用、transaction、認可、project scope、retry / idempotency がある場合は本文または `@throws` で明記する。
- 実装詳細を逐語的に説明せず、呼び出し側が守る契約と設計意図に絞る。
- 実装変更で契約が変わる場合は、同じ変更内で既存 docstring も更新する。実装と矛盾する古い説明を残さない。

例:

```ts
/**
 * Saves a project-scoped report schedule after verifying administrator access.
 *
 * @param formData - Form values containing the project slug and canonical frequency.
 * @throws When the caller is not a project administrator or a dispatcher lease is active.
 */
export async function updateProjectReportSchedule(formData: FormData): Promise<void> {
  // ...
}
```

### 5.3 省略できる対象

次の対象は、責務や制約が型・名前・周辺 context から自明であり、複雑な副作用や不変条件を持たない場合に限り docstring を省略できる。

- file 内だけで使う短い private helper、単純な mapper / formatter / type guard。
- test case、fixture、mock、test 専用 helper。
- framework や interface の契約をそのまま実装する override で、追加の制約や副作用がないもの。
- 自動生成物、外部由来の vendored code。
- object property、単純な type alias / interface。field の意味が型から分からない場合は property comment を付ける。

省略判断に迷う場合は、公開範囲よりも「呼び出し側が契約を誤解する可能性」を優先し、短い docstring を追加する。

### 5.4 PR 前確認

- 現行の Biome / TypeScript 設定は docstring の有無を自動強制しないため、PR 前に `git diff` で新規・変更した対象 declaration と docstring を対にして確認する。
- レビューで docstring 不足を指摘された場合は、指摘箇所だけでなく、同じ変更で追加・変更した必須対象に漏れがないか横断確認する。
- docstring だけを機械的に増やさず、重複説明、実装と矛盾する説明、古い parameter 名がないことを確認する。

## 6. 完了報告ルール

- 完了報告には、実行した検証コマンドと結果を具体的に書く。
- 実行できなかった検証、skip された検証、外部環境不足で未確認の検証がある場合は、理由と残るリスクを明記する。
- CI / GitHub Checks を確認した場合は、対象 PR と pass / fail の状態を明記する。
- 全テストを実行していない場合に「全テストパス」と書かない。targeted check のみの場合は targeted であることを明記する。

## 7. Hook 方針

- 現時点では Stop Hook / PostToolUse hook を repository に導入しない。
- 理由は、Codex / Cursor / GitHub Actions / 手元 shell で共通に効く hook 実行基盤が repository 内に存在せず、ローカル hook だけを追加しても CI の強制力にならないためである。
- 追加で、全検証の自動実行を Stop Hook に寄せると、DB、Playwright、Docker、外部 API key の有無による誤検知やローカル開発の過剰な待ち時間が発生しやすい。
- 強制は GitHub Actions の `format-lint`、`typecheck`、`unit-test`、`db-check`、`build`、`e2e` に置く。ローカルではこの文書と `docs/operations/ci-quality-gates.md` の実行ルールに従う。
- hook を導入する場合は、別 Issue で対象 tool、実行タイミング、skip 条件、CI との関係、ローカル検証結果を明記してから追加する。

## 8. 運用ルール

- 実装 scaffold を追加する Step 0 で、`package.json`、Biome、Prettier、markdownlint、TypeScript の設定を同時に入れる。
- CI では `format:check`、`lint`、`typecheck`、`test`、`db-check`、`build`、必要な場合の `e2e` を必須ゲートとして扱う。
- formatter と lint の設定変更は、既存ファイルの大規模な機械整形と機能変更を同じ commit に混ぜない。
- 自動生成物、外部出力、`node_modules`、coverage、build artifact は lint / format 対象から除外する。
