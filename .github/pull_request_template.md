## 概要

-

## 検証

-

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
