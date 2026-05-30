# Step 10: 実データソース接続を 1 種類ずつ追加

### 実装する機能

実データソースは同時に増やさず、次の順に追加する。

1. Web URL
2. GitHub
3. Drive
4. Gmail

各 source で追加するもの。

- OAuth / token / GitHub App などの接続設定
- `sourceScannerTool`
- 実 API から fixture と同じ raw contract へ変換する adapter
- source 別 parser / validator の実データ fixture
- source / project / data_source ごとの parser profile と approved parser version
- rate limit / pagination / incremental window
- source ごとの skip / dedup 判定
- 失敗 raw をマスクして fixture 化し、parser 修正後に retry する運用手順

### 確認できること

- 外部 API の差分を raw contract に閉じ込められる。
- 実データでも Step 4 から Step 9 の確認方法を流用できる。
- project / data_source 固有の format 差分を Parser Registry の version として管理できる。
- scope、PII、API コスト、レート制限を source ごとに確認できる。
- 実データ接続時も全候補を Agent に渡さず、固定スクリプトで収集・parse できる。

### 確認方法

各 source で次を実行する。

```bash
pnpm ingest:collect --project sample-a --source <source> --limit 5 --dry-run
pnpm ingest:collect --project sample-a --source <source> --limit 5
pnpm ingest:run --project sample-a --source <source> --limit 5 --embedding-provider deterministic
pnpm ingest:status --project sample-a
pnpm ingest:inspect --project sample-a --source <source> --limit 5 --format json
pnpm ingest:fixture:add-failed --project sample-a --source <source> --limit 3 --dry-run
pnpm parser:version:validate --project sample-a --source <source> --held --dry-run
pnpm test -- --run "source:<source>"
```

source 別に `ingest:inspect` と source contract test で次を検査する。実データの初回接続時にブラウザや外部サービス管理画面を見る場合も、完了判定は CLI 出力、DB / storage 状態、ログ検査で行う。

- Web: canonical URL、HTML 本文抽出、content hash
- GitHub: issue / PR / comment / diff の紐付け
- Drive: folder 制限、revision、owner、mime type
- Gmail: label / query 制限、thread、最新メールと引用分解、送受信者名寄せ

### 完了条件

- `--limit 5` の小さな実データで `indexed` まで到達する。
- scope が必要最小限である。
- 個人情報を含む本文が過剰にログ出力されない。
- 同じ source を再実行しても重複しない。
- `ingest:inspect` の JSON が source contract に合い、source 別の必須項目が自動検査で通る。
- 実データ `--limit 5` の範囲で Agent / chat model を使わずに collect → parse が通る。
- source 固有 parser の変更は draft → validation → approve を通り、未承認データは `held` のまま保留される。
