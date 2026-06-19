# ADR-004: Storage パッケージのモジュール解決を `.ts` 直接 import に統一する

作成日: 2026-06-19 / ステータス: Accepted

## コンテキスト

`@pufu-lens/storage` のソースは 4 つの実行系で読み込まれる。

1. **strip-types ソース実行** — `node --experimental-strip-types`（`scripts/*.ts`, `apps/mastra dev` 等）。Node の ESM 解決は相対 import に明示拡張子を要求する。
2. **コンパイル済み dist** — `tsc -p tsconfig.json` で `dist/**/*.js` を生成し、`scripts/*` が `packages/storage/dist/*.js` から import する（`pnpm --filter @pufu-lens/storage test` の self-test もこの dist を `node --test` で実行）。
3. **Next.js (turbopack)** — `apps/web` が `report.ts` 経由で `packages/storage/src/factory.ts` を値 import する。
4. **Mastra rollup バンドラ** — `mastra build` が `@pufu-lens/web/report` → `packages/storage/src/factory.ts` をソースのまま解析・バンドルする。

従来、`factory.ts` / `index.ts` / 各 `*.test.ts` は値クラスを `import { LocalFsObjectStorage } from './local-fs.js'`（`.js` 指定子）で取り込み、解決先として `src/local-fs.js` / `src/gcs.js` という **シム** を置いていた。シムの中身は `export * from './local-fs.ts'`（`.ts` 再エクスポート）のみ。これにより strip-types は `.js` 指定子を `.ts` 実装へ解決でき、dist 側はシムを含まず（tsconfig の `include` が `src/**/*.ts` のみ）コンパイル済み `.js` 同士で解決できていた。

問題は Mastra rollup バンドラがソースを読む点にある。`factory.ts` の `./local-fs.js` 指定子をシムファイルに解決した後、シム内の `export * from './local-fs.ts'` を **辿れず**、`LocalFsObjectStorage` が「not exported」となってビルドが失敗する（`.js` ファイルから `.ts` 再エクスポートを追えない）。

検証で以下を確認した。
- strip-types は `.js` シムを使う場合、シム内の再エクスポートに **明示 `.ts` 拡張子が必須**（無拡張は `ERR_MODULE_NOT_FOUND`）。つまりシムと strip-types の組み合わせは本質的にバンドラと両立しない。
- Mastra の `bundler` 設定（`externals` / `transpilePackages`）は依存の外部化を制御するのみで、rollup の拡張子解決（`.js` シム → `.ts`）には介入できない。依存「解析」段階での失敗のため、バンドラ設定だけでは解消不可。

## 決定

**`.js` シムを廃止し、Storage パッケージ内の相対 import を `.ts` 直接指定に統一する。** dist 整合は TypeScript の `rewriteRelativeImportExtensions` に委ね、Mastra ビルドでは GCS SDK を externals 化する。

これは `apps/web/src/report.ts` や `apps/mastra/src/mastra/index.ts` が既に採用している「`.ts` ファイルから `.ts` を値 import する」方式に揃えるものであり、4 実行系すべてが扱える唯一の最小形である。

## 具体的な変更

1. `packages/storage/tsconfig.json` に `"rewriteRelativeImportExtensions": true` を追加。
   `tsc` がソースの `.ts` 相対 import を許容し、dist 出力では `.js` に書き換える。
2. Storage パッケージ内の相対 import 指定子を `.js` → `.ts` に統一。
   - `src/factory.ts`: `./gcs.ts` / `./local-fs.ts` / `./object-storage.ts`
   - `src/index.ts`: `./factory.ts` / `./gcs.ts` / `./local-fs.ts` / `./object-storage.ts`
   - `src/factory.test.ts`: `./factory.ts` / `./gcs.ts` / `./local-fs.ts`
   - `src/local-fs.test.ts`: `./local-fs.ts`
   - `src/gcs.test.ts`: `./gcs.ts`
   - `src/local-fs.ts` / `src/gcs.ts`: `./object-storage.ts`（型のみ）
3. シムファイル `src/local-fs.js` と `src/gcs.js` を削除。
4. `apps/mastra/src/mastra/index.ts` の `new Mastra({...})` に
   `bundler: { externals: ['@google-cloud/storage'] }` を追加。
   シム解消後、バンドラが `GcsObjectStorage` 経由で `@google-cloud/storage` を静的解析するようになるため、これをバンドルせず実行時インストールに回す（Mastra CLI 自身が提示した対処）。

## 各実行系での整合（なぜ壊れないか）

- **strip-types ソース実行**: `.ts` 指定子を Node が直接解決する。シム不要。`pnpm db:migrate --check` と Storage クラスを直接 import する throwaway スクリプトで解決エラーがないことを確認済み。
- **dist**: `rewriteRelativeImportExtensions` により dist 出力の相対 import は `.js` に書き換わる（例: `dist/factory.js` は `from "./gcs.js"`）。`scripts/*` の `packages/storage/dist/*.js` import および dist self-test はそのまま動作する。dist に `.ts` 指定子は漏れない。
- **Next.js (turbopack)**: `.ts` 値 import は既存の `report.ts → factory.ts` と同形で、`pnpm typecheck` 内の `@pufu-lens/web` ビルドが全ルート生成に成功。
- **Mastra build**: `.ts` ファイルから `.ts` を辿れるためシム不在でクラスが解決され、`@google-cloud/storage` を externals 化することで `.mastra/output` 生成に成功。`@google-cloud/storage` は output の `package.json` に runtime 依存として残る。

## 影響範囲・帰結

- Storage パッケージの公開 API・公開挙動は不変（エクスポート名・クラス挙動・dist の import 形は同一）。
- スクリプト/ランタイム規約（`scripts/*` は dist を import）は不変。
- シム 2 ファイルが消え、解決経路が 1 段短くなる。今後 Storage に値モジュールを追加する際はシム不要で、相対 import を `.ts` で書く。
- Mastra のビルド成果物に GCS SDK が外部依存として含まれる（従来バンドル対象外だったものを明示外部化しただけで挙動差はない）。

## 残存リスク

- `rewriteRelativeImportExtensions` は TypeScript 5.7+ の機能。リポジトリの `tsc` バージョンに依存する（現状の build / test / typecheck で動作確認済み）。
- Storage 配下に新規ファイルを追加した際、`.js` 指定子で書くと dist では解決できるがバンドラで再び詰まる可能性がある。`.ts` 指定子に統一する規約を維持すること。

## 検証

- `pnpm --filter @pufu-lens/mastra mastra:build` → `Build successful` / `.mastra/output` 生成
- `pnpm typecheck` → `Tasks: 9 successful, 9 total`、`scripts:typecheck` 含め exit 0
- `pnpm --filter @pufu-lens/storage test` → `pass 14 / fail 0`（dist self-test）
- strip-types smoke: `pnpm db:migrate --check` = `migration check passed` / throwaway `.ts` で `new LocalFsObjectStorage('/tmp')` と `createObjectStorageFromEnv()` が解決エラーなく成功
