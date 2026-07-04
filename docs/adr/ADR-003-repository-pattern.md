# ADR-003: Repository パターンで永続化境界を分離する

作成日: 2026-07-04 / ステータス: Accepted

## コンテキスト

Pufu Lens は Next.js API / Server Action、Mastra tools / workflows、CLI scripts から同じ PostgreSQL 行、ObjectStorage、fixture を扱う。永続化処理を各入口に直接書くと、認可 SQL、row parsing、storage path 組み立て、fixture fallback が重複し、テナント境界や runtime guard の抜け漏れが起きやすい。

`.codex/rules/architecture-rule.md` は、SQL row を境界で `readonly unknown[]` として受けて runtime guard / parser を通すこと、server action に SQL 組み立てや storage 操作を蓄積しないこと、責務が膨らむ場合は repository / loader / domain module へ分離することを要求している。

## 決定

永続化と外部 I/O の境界には Repository パターンを使う。Repository は DB / storage / fixture などの具体的な取得・保存手順を隠蔽し、呼び出し側には検証済みの domain data を返す。

Repository は以下を満たす。

- SQL 実行直後の `unknown` row を parser / runtime guard で検証する。
- project / user / public report などのテナント境界を repository またはその手前の use case / authz helper で明示する。
- Server Action / route handler / Mastra tool は request validation、認可、repository 呼び出し、response mapping に寄せる。
- shared な repository は owner package または app 内の責務別 module に置き、app 間の `src` 相対 import はしない。
- CLI scripts で再利用する処理は `scripts/lib/` または package 側に寄せ、script ごとの helper 重複を避ける。

## 適用方針

小さな read helper まで機械的に repository 化しない。次の条件に当てはまる場合に repository へ分離する。

- 同じ SQL / storage 操作を複数入口から使う。
- row parser、認可条件、storage key 生成、fallback のいずれかが複雑化している。
- server action / route handler / tool が永続化詳細を抱えて 500 行超または複数責務になっている。
- テストで DB row や storage 実装を差し替えたい。

## 帰結

入口層は薄く保ち、永続化境界の検証とテストを repository に集約する。新しい repository を追加する PR では、owner、利用入口、認可 / runtime guard への影響、検証した unit test または integration test を PR 本文に記載する。

Repository を追加しても、認可 helper を迂回してよいという意味ではない。project / admin / public の認可要件は既存の authz helper と route / action の責務分担に従う。

## 検証

この ADR は設計方針の明文化であり、単体の runtime 挙動は変更しない。実装 PR では repository ごとに row parser、拒否系、テナント越境、fallback のテスト要否を判断する。
