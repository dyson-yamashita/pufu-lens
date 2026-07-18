## 概要

-

## 検証

-

## 修正後の画面

- [ ] 画面修正なし
- [ ] 画面修正あり（レビュー対象が分かる修正後の画面キャプチャを以下に添付した）
- [ ] 画面修正ありの場合、影響を受ける各 viewport・表示状態の画面キャプチャを添付した
- [ ] 画面修正ありの場合、画面キャプチャに PII / secret / token の実値が含まれないことを確認した

<!-- 画面修正がある場合は、影響を受ける viewport・表示状態のキャプチャをここに添付する。 -->

## ドキュメント

- [ ] 仕様・設計・plan に影響がある場合、関連ドキュメントを更新した
- [ ] `docs/plans/plan-status.md` の更新要否を確認した

## DB Migration

- [ ] DB schema 変更なし、または下記を確認した
- [ ] `infra/docker/postgres/init.sql` の更新要否を確認した
- [ ] `infra/docker/postgres/init.sql` の `schema_migrations` baseline seed 更新要否を確認した
- [ ] `infra/db/migrations/*.sql` の追加・更新要否を確認した
- [ ] data backfill の有無、再実行時の挙動、検証 query を確認した
- [ ] destructive change の有無を確認し、必要な場合は互換期間を分けた
- [ ] AGE graph / vector / embedding 再生成への影響を確認した
- [ ] SQL、fixture、log に PII / secret / token の実値が含まれないことを確認した
