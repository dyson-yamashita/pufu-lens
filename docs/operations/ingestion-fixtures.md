# Ingestion fixtures

## 目的

`fixtures/ingestion` は、外部 API に触れずに ingestion parser の入力形式と parsed JSON の契約を固定するためのテストデータである。GitHub、Web、Gmail 風 JSON、Drive document 風 JSON を最小セットとして管理する。

## 追加ルール

- 実在人物の氏名、実在メールアドレス、非公開 URL、認証情報、業務本文全文を入れない。
- メールアドレスは `example.test`、公開 URL は `example.test` または `github.com/example-org/...` のサンプルだけを使う。
- raw を追加したら `fixtures/ingestion/manifest.json` に `sourceType`、`sourceId`、`storageUri`、`contentHash`、`snapshotPath` を追加する。
- parsed JSON は parser の出力を `*.parsed.json` として保存し、レビューしやすいように pretty print する。
- Gmail 風 fixture は最新メール本文を `bodyText`、引用履歴を `quotedMessages` に分ける。
- Drive 風 fixture は `fileId` と `revisionId` を必ず持たせ、最新版だけが document 化される前提を保つ。

## 失敗 raw の regression 化

parser / validator が失敗した raw は、まずローカルの一時領域に保存する。公開できない値を含む可能性があるため、そのまま commit しない。

```bash
node --experimental-strip-types scripts/promote-failed-raw-fixture.ts \
  --input tmp/failed-raw.json \
  --output failed-case-name.json
```

生成された `fixtures/ingestion/regression/<name>.json` を目視確認し、上記の追加ルールを満たしてから manifest と snapshot test に組み込む。

## 確認コマンド

```bash
pnpm test -- --run fixtures
pnpm test -- --run parse
rg -n "token|secret|password|Bearer|refresh_token" fixtures .env.example
```

`.env.example` は環境変数名の placeholder を含むため、検出結果は値が空であることを確認する。`fixtures` 配下では検出がない状態を維持する。
