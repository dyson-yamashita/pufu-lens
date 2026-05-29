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
