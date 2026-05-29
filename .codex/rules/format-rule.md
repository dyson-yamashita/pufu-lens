# Pufu Lens Format / Lint ルール

## 1. 目的

この文書は、Pufu Lens の lint / formatter の標準ツール、script、運用ルールを定義する。

初期構築では、実装前のドキュメント中心 repo と、TypeScript 実装開始後で標準ツールを分ける。

## 2. ドキュメント中心の段階

- `.editorconfig` で改行、文字コード、末尾改行、インデントの基本方針を固定する。
- Markdown / YAML / JSON の整形は Prettier を使う。
- Markdown の構文検査は `markdownlint-cli2` を使う。
- 想定 script は以下とする。
  - `pnpm format`: Prettier で対象ファイルを書き換える。
  - `pnpm format:check`: Prettier の差分有無を検査する。
  - `pnpm lint:md`: Markdown lint を実行する。

## 3. TypeScript 実装開始後

- TypeScript / TSX / JavaScript / JSX の lint と formatter は Biome を第一候補にする。
- 型検査は TypeScript `tsc --noEmit` を使う。
- Prettier は Markdown / YAML / JSON など、Biome の対象外または Markdown 整形のために使う。
- ESLint は、Biome で足りない framework 固有ルールが必要になった場合だけ追加する。
- 想定 script は以下とする。
  - `pnpm lint`: `biome check .` と `markdownlint-cli2` を実行する。
  - `pnpm format`: `biome check --write .` と Prettier を実行する。
  - `pnpm typecheck`: `tsc --noEmit` を実行する。
  - `pnpm test`: unit / integration test を実行する。
  - `pnpm build`: production build を実行する。

## 4. 運用ルール

- 実装 scaffold を追加する Step 1 で、`package.json`、Biome、Prettier、markdownlint、TypeScript の設定を同時に入れる。
- CI では `format:check`、`lint`、`typecheck`、`test`、`build` を段階的に必須化する。
- formatter と lint の設定変更は、既存ファイルの大規模な機械整形と機能変更を同じ commit に混ぜない。
- 自動生成物、外部出力、`node_modules`、coverage、build artifact は lint / format 対象から除外する。
