# Architecture ルール

## 1. 目的

この文書は、Pufu Lens の module 境界、認可、SQL row 検証、server action、script helper の肥大化や重複を防ぐためのルールである。

## 2. Module / package 境界

- `apps/*/src` から別 app の `src` を相対 import しない。
- app 間で共有する型、関数、定数は `packages/*` に切り出し、`package.json` の workspace dependency として参照する。
- 新しい共有 module を追加する場合は、owner となる app / package と利用側を PR 本文に明記する。
- `turbo` の依存グラフから外れる暗黙依存を追加しない。

## 3. 認可境界

- project / admin / global role の認可判定は、`apps/web/src/authz.ts` または専用 authz module 経由に集約する。
- feature module 内に認可 SQL を直接重複実装しない。
- 認可要件を変更する PR では、拒否系、role 不足、テナント越境の test を追加または更新する。
- public API / private API / server action の入口が分かれていても、同じ認可要件は同じ helper を共有する。

## 4. SQL row / runtime guard

- DB query の戻り値は境界で `readonly unknown[]` として受け、runtime guard / parser を通してから利用する。
- `as SomeRow[]`、`rows[0] as SomeRow`、構造未検証の `as` cast を新規追加しない。
- 例外的に cast が必要な場合は、理由と安全性を code comment または PR 本文に残す。
- SQL、parser、mapping の責務を混ぜすぎず、row 取得直後に検証境界が見える形にする。

## 5. Server action / loader / repository の責務

- server action は request / form validation、認可、use case 呼び出し、revalidate に寄せる。
- SQL 組み立て、外部 process 実行、storage 操作、複雑な mapping を同じ action file に蓄積しない。
- loader / repository / action / external process runner の責務が同居し始めたら、domain 別 module へ分割する。
- 目安として 800 行超、または exported action 8 個超の file に新しい責務を追加する場合は、先に分割要否を検討する。
- 既存 import path 互換が必要な場合は、薄い wrapper を残し、実装本体を責務別 module に移す。

## 6. scripts

- `requiredEnv`、`parseArgs`、`validateGraphName` などの汎用 helper を script ごとに再定義しない。
- 共通化できる helper は `scripts/lib/` または専用 package に置く。
- script 固有 option の型や validation だけを各 script 側に残す。

## 7. PR レビュー観点

PR 作成前に以下を確認する。

1. 認可 SQL を重複追加していないこと
2. SQL row の無検証 cast を追加していないこと
3. app 間の `src` 相対 import を追加していないこと
4. 既存の god file に新しい責務を積み増していないこと
5. script helper を重複定義していないこと
6. 認可、runtime guard、module 境界への影響と検証結果を PR 本文に記載していること
