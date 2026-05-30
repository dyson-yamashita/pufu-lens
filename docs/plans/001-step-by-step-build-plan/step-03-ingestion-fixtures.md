# Step 3: Ingestion Fixture とデータ契約

### 実装する機能

- `fixtures/ingestion` に安全なサンプルデータを追加
  - GitHub Issue / Pull Request JSON
  - Web HTML
  - Gmail 風 MIME または JSON
  - Drive document 風 JSON
- source ごとの raw metadata / parsed JSON schema を定義
- parse 結果の snapshot test を用意
- parser / validator が失敗した raw を保存し、マスク済み regression fixture へ昇格できる仕組みを用意
- PII / secret を含まない fixture ルールを文書化
  - テスト用データ（fixture）に、実在の個人情報や秘密情報を混ぜないためのルールを明文化する

### 確認できること

- 外部 API なしで ingestion の正常系・異常系を再現できる。
- 原本形式と parse 後形式の契約が固定される。
- 取り込み処理の変更差分を snapshot で確認できる。
- 失敗データを再現可能なテストケースとして残し、parser 修正後の再発を防げる。

### 確認方法

```bash
pnpm test -- --run fixtures
pnpm test -- --run parse
rg -n "token|secret|password|Bearer|refresh_token" fixtures .env.example
```

### 完了条件

- fixture から parsed JSON が安定生成される。
- snapshot 差分がレビューしやすい。
- fixture に secret らしき値が含まれない。
- failed raw をマスクして regression fixture に追加する手順が決まっている。

## Step 3 確認記録

- 実施日: 2026-05-30
- 対象 commit: `feature/issue-9-ingestion-fixtures`
- 実装範囲: `fixtures/ingestion` の raw / parsed snapshot、`@pufu-lens/ingestion` の raw contract / parser / validator、失敗 raw regression 化スクリプト、fixture 運用ドキュメント
- 実行コマンド:
  - `pnpm --filter @pufu-lens/ingestion test -- --run fixtures`
  - `pnpm --filter @pufu-lens/ingestion test -- --run parse`
  - `rg -n "token|secret|password|Bearer|refresh_token" fixtures .env.example`
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm build`
- 自動テスト結果: すべて成功
- 補助的な手動確認: snapshot JSON が source type ごとに分かれ、差分レビュー可能であることを確認
- DB 確認: DB 変更なし
- Storage 確認: `storageUri` が `<projectSlug>/raw/<sourceType>/...` 形式であることを test で確認
- ログ / secret 確認: `fixtures .env.example` への指定 grep は一致なし
- 未確認リスク: parser は Step 3 用の最小決定的 parser であり、実 API 形式の網羅は Step 10 以降で拡張する
- 次 step に進む判断: 外部 API なしで raw contract と parsed snapshot を検証できるため、Step 4 に進める
