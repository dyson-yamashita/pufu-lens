# Plan Status

このファイルは `docs/plans/` 配下の plan ファイルの状態を管理するための索引である。
エージェントは個別の plan を読む前にこのファイルを確認し、`completed` / `deprecated` の plan を通常作業の参照対象にしない。

## ステータス定義

| status       | 意味                         | 参照ルール                               |
| ------------ | ---------------------------- | ---------------------------------------- |
| `planned`    | 未着手。今後実施予定。       | 作業対象として参照してよい。             |
| `active`     | 現在の主要計画。             | 優先して参照する。                       |
| `blocked`    | 外部要因や判断待ちで停止中。 | 理由を確認し、勝手に再開しない。         |
| `completed`  | 完了済み。                   | ユーザーが明示した場合を除き参照しない。 |
| `deprecated` | 破棄・置き換え済み。         | ユーザーが明示した場合を除き参照しない。 |

## Plan 一覧

| plan                                                       | status       | 更新日     | メモ                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/001-step-by-step-build-plan/overview.md`       | `completed`  | 2026-06-21 | Step 10 の Drive / Gmail one-pass 実 API 確認と Step 14 の GCP deploy が完了済み。後続詳細作業は 004 / 005 / 007 で管理。                                                                                                                                                                                                                                                                           |
| `docs/plans/002-account-login-public-projects/overview.md` | `completed`  | 2026-06-11 | Auth.js ログイン基盤、public project / public report / public chat の入口実装は merge 済み。                                                                                                                                                                                                                                                                                                        |
| `docs/plans/003-admin-age-viewer/overview.md`              | `completed`  | 2026-06-11 | Issue #80 の Graph Viewer 実装は merge 済み。                                                                                                                                                                                                                                                                                                                                                       |
| `docs/plans/004-project-settings-connections/overview.md`  | `completed`  | 2026-06-28 | Step 1-7 完了。Project Settings 連携管理、Data Source 選択制御、server action / CLI enforcement、失効・scope 不足・解除済み connection の運用表示と deploy checklist 更新まで merge 済み。                                                                                                                                                                                                          |
| `docs/plans/005-storage-recovery-artifacts/overview.md`    | `deprecated` | 2026-07-11 | Issue #117 / PR #118 で Step 1 完了。現時点で着手予定がないため Issue #524 で計画を中止。Step 1 の実装は維持し、Step 2 以降の artifact 統合、reconcile、restore は実装しない。                                                                                                                                                                                                                      |
| `docs/plans/006-db-migration-management/overview.md`       | `completed`  | 2026-06-13 | Issue #119 / #121 / #123 / #127 / #130 / #133 で DB migration 運用、検証、drift 検出、重い DB 変更方針を整備済み。                                                                                                                                                                                                                                                                                  |
| `docs/plans/007-data-source-content-preview/overview.md`   | `completed`  | 2026-06-21 | Issue #148 / PR #150 で content preview を実装・検証。Issue #212 / PR #213 で row parsing を helper 化済み。Chat / Graph 導線は後続 plan 候補に分離。                                                                                                                                                                                                                                               |
| `docs/plans/008-agent-raw-reading/overview.md`             | `completed`  | 2026-06-24 | Step 1–6 完了: Agent Raw Read View contract、Parser Profiles 廃止、adapter / repository、private chat/report raw 補完、trace / eval / docs 整備済み。                                                                                                                                                                                                                                               |
| `docs/plans/009-oss-deployment-options/overview.md`        | `completed`  | 2026-06-26 | Issue #318 で Step 1 完了。Issue #325 で Step 2 の GCP Cloud Build CI example を追加。Issue #327 で Step 3 の deploy example を追加。Issue #329 で Step 4 の GCP Cloud Build operations docs を追加。Issue #331 で Step 5 の provider expansion guide を追加し、plan 全体を完了。                                                                                                                   |
| `docs/plans/010-editing-techniques-chat/overview.md`       | `completed`  | 2026-06-28 | Issue #361 で selector なしの editing metadata 自動判定、Agent instructions、response metadata、compact UI 表示、unit / e2e / eval fixture 検証を実装。                                                                                                                                                                                                                                             |
| `docs/plans/011-custom-report-layouts/overview.md`         | `completed`  | 2026-07-01 | Issue #377 で追加。Issue #379 で Step 1 の template schema / data model 実装が完了。Step 2 の template 管理 UI、Step 3 のカスタム report 生成、Step 4 の custom layout renderer、Step 5 の PDF download、Step 6 の import / asset / PDF / public report security regression を実装（Step 2 以降の Issue 作成は手元環境で GitHub CLI (`gh`) が利用できず未実施）。                                   |
| `docs/plans/012-public-private-result-parity/overview.md`  | `completed`  | 2026-07-04 | Issue #425 で追加。Step 1 として public chat の Mastra request context を private chat と揃えた。Issue #429 で Step 2 の public chat source redaction 維持と private tool call summary の公開方針を実装。Step 3 で現行 public chat の正規経路と legacy public-report-chat-agent の互換・検証用責務を整理。Issue #435 で Step 4 の report detail / PDF parity regression を追加し、plan 全体を完了。 |

| `docs/plans/013-incremental-source-sync-scheduling/overview.md` | `completed` | 2026-07-11 | Issue #512 / PR #513 で Step 1、Issue #516 / PR #517 で Step 2、Issue #518 / PR #519 で Step 3、Issue #520 / PR #521 で Step 4 を完了。Issue #514 / PR #515 で local one-shot dispatcher の実行要件を追加。Issue #522 で Step 5 の E2E、運用検証、設計書・runbook 整備を完了。 |
| `docs/plans/014-periodic-report-scheduling/overview.md` | `completed` | 2026-07-18 | Issue #579 / PR #580 で Step 1、Issue #581 / PR #582 で Step 2、Issue #583 / PR #584 で Step 3、Issue #585 / PR #586 で Step 4、Issue #587 / PR #588 で Step 5、Issue #592 で Step 6 の一覧・差分 UI、E2E、運用手順を完了。Issue #595 で初回履歴 report の過去分一括生成、設定 UI 配置、保存遅延の追加修正を行った。 |
| `docs/plans/015-chat-search-candidate-coverage/overview.md` | `completed` | 2026-07-19 | Issue #622 で Step 5 の score-aware eval fixture、回帰実行条件、07-chat.md 更新を完了。Step 1–4 のスコア透過、決定論的カットオフ、分類別 selection policy、多様性 quota と retrieval confidence 伝搬を含め、plan 全体を完了。 |
| `docs/plans/016-gcp-cost-optimization/overview.md` | `active` | 2026-08-03 | Issue #663 で Direct VPC egress 移行、DB VM の `e2-custom-small-3072` 化と deletion protection 有効化、停止済み旧 `pg-ai` VM / disk 廃止、60 分の post-resize soak、ドキュメント更新まで完了。2026-08-10 以降の Billing Report 7 日比較を残す。 |
| `docs/plans/017-activitypub-report-federation/overview.md` | `completed` | 2026-08-12 | Issue #665 で追加。Issue #667 で Step 1、Issue #669 / PR #670 で Step 2、Issue #671 で Step 3、Issue #673 / PR #674 で Step 4、Issue #676 / PR #677 で Step 5、Issue #678 / PR #679 で Step 6 を完了。Issue #682 / PR #683 で Step 7 の本文なしqueue / origin / inbox metrics・alert、retry exhausted再投入 / 破棄と監査、Actor key / domain block / canonical origin / Fedify advisory runbook、月次request / Job / DB / egress計測、system / API / data / security / deployment / cost docsとproduction checklist同期を完了した。外部 instance、本番deploy、実GCP observability適用は未実施で、実 Mastodon 固有挙動は未確認リスクとして残る。 |
| `docs/plans/018-cloud-portable-data-backends/overview.md` | `active` | 2026-09-26 | Issue #784でStep 6AのCore packageを実workerdで17件検証済み。Issue #786で6BのD1 Graph adapterを実binding/workerdで13件検証しローカル到達点を完了。Issue #788で6CのD1 keywordを固定v1/56-query/14-case/別語彙15-queryでローカル検証済み。6D/6E/7とremote品質評価は未実施。Step 1A–1C / 2A–2D完了。PR #743 / #745のrelational-onlyを9/17本番反映し全8 unitで確認、Issue #746で実績を記録。ユーザー指定で停止・drain省略。自動smoke・主要画面・Graphを確認し、ユーザーもログイン・レポート作成成功を報告。2E write switch依存残件と2F本番有効化は反映済みだが、自然mutation全経路・長期観測・復元試験は未確認。AGE / backup / 旧image保持、Step 4削除gateは未達。Step 3Cの候補schema / adapter / backfillをIssue #752 / PR #753で実装・ローカル検証済み。Step 3DはIssue #754 / PR #755でPGroonga primary維持のshadow / primary + fallback / 切替準備を実装・ローカル検証済みで、数字誤検出2件を記録した。Issue #763で数字列の完全一致guardを追加し、14-case holdoutのbaseline / candidate失敗0件と固定v1 11方式live evalの順位再現・schema保護・rollbackを確認した。2026-09-20に全4 projectのproduction backfill 3,420件、pending 0、不一致0を確認。PR #757のshadow deployは9/20 22:10 JSTに成功。Issue #759で安定稼働確認を当日のみに短縮。当日5xx 0、検索観測0、404未分類。Issue #769で56-query portable集合差0、Recall 1.0。hybrid必須source欠落0、比較gateはbaseline未取得typo 2件で未達。Issue #771で実private Chat代表E2Eは両方式7/7・障害時1/1成功。Issue #772で回答表現を補修し、両方式7/7で本文リンク・内部診断不在を確認。旧v1のsource比較未達と書式上の限界は維持。大規模負荷はユーザー指定でスキップ。Issue #775でpublic Chatも両方式8/8確認。Issue #777で非空Graph・raw原文Chatとparsed metadata直接接続を両方式3/3確認。parsedのLLM選択失敗2回は保持。非Web資料等、本番shadow観測・restoreを残し7 Step全体はactive。 |

## 運用ルール

Plan 018 Step 6C（2026-09-26、Issue #788）: Step 6B PR #787 merge後の最新mainから独立タスクで着手。
D1 keyword adapterの固定v1/56-query/14-case/別語彙15-queryを実workerdで検証して成功。
文字posting＋bigram方式、batch原子性、scopeとローカル制約をADR-008へ記録。remote・GCP・本番変更なし。
6Bの実D1 13件/Core 17件の結果はADR-007を参照。6D/6E/7と既存品質・運用gateは維持する。

Plan 018 Step 6B（2026-09-26、Issue #786）: Step 6A merge 後の main `a732fa6` から独立タスクで着手。
D1 schema / Graph adapterのローカル binding / workerd検証13件とCore17件が成功し、6Bローカル到達点を完了。
project scope、Viewer上限、merge/cleanup/rollbackを確認。6C–6E、remote、既存品質・本番観測・restore・削除gateを維持する。

Plan 018 Step 6A（2026-09-26、Issue #784）: 最新mainから独立タスクで着手し、Core RRF・candidate guard・
Graph DTO・project slugをNode互換flagなしの実workerdで17件検証して成功。ローカル互換性確認を完了。
詳細は[ADR-006](../adr/ADR-006-workers-core-package-spike.md)。6B–6E・remote評価は未実施。
Step 4/5やGCP portable-primary切替を開始前提とせず、既存Chat品質未達・資産保持・大規模負荷スキップを維持する。

Plan 018 Step 3D（2026-09-25、Issue #777）: 非空Graphとraw原文の実Chat、parsed metadataの実HTTP接続を両方式3/3で確認。
原文限定情報・履歴、Graph非空取得・3種類の関係・project isolationを確認。parsed toolをLLMが選ばない2試行は失敗観測として保持。
parsed本文読込は現行toolの契約外。大規模負荷スキップと、全source種別・本番shadow・restore等のgateは維持する。

Plan 018 Step 3D（2026-09-25、Issue #775）: public Chatの実LLM・公開source変換・匿名UI・公開artifact表示を両方式8/8で確認。
private project / 未公開report / project不一致を404で拒否し、公開reportなしの空状態も確認。公開source overlapは5回答とも1.0。
合成Web資料のみの代表検証であり、非Web資料・非空Graph・raw / parsed・本番shadow・restore等は残す。大規模負荷スキップを維持。

Plan 018 Step 3D（2026-09-25、Issue #772）: 内部診断のcontext分離と引用指示を補修し、実Chatを両方式7/7で再検証。
必要な事実・本文リンク・履歴を保持、内部診断混入0件。今回source overlapは全件1.0だが旧v1と既存比較gate未達は維持。
脚注記号が残る書式上の限界を記録し、大規模負荷スキップ、本番shadow・restore等の残件は維持する。

Plan 018 Step 3D（2026-09-25、Issue #771）: 実Next認証・Mastra・Gemini・embedding・DBを通すprivate Chat代表E2Eを実施。
両方式7/7、障害時1/1成功。source overlap 0.5の1件と回答内引用欠落・内部診断混入（Issue #772）により全品質gateは未達。
大規模負荷はユーザー指定でスキップ。public Chat・非空Graph等の網羅、本番shadow観測・restoreは残る。

Plan 018 Step 3D（2026-09-25、Issue #769）: 全term条件・literal記号・label/数字対応・制限付きtypo補完で
56-case portable集合差13→0、Recall / MRR / nDCG各1.0。固定v1と56-case期待値・threshold 0.6を維持し、旧14-case日本語typoの矛盾はユーザー承認で統一した。
hybrid必須source欠落0、比較gateはbaseline未取得のtypo 2/8件で未達。別語彙15-query DB回帰と16 HTTP往復を確認。
自然planner・負荷・全Chat E2E・production shadow観測・restore・Step 4 gateとPGroonga primaryを維持する。

Plan 018 Step 3D（2026-09-24、Issue #767）: 56-queryの独立holdout、8シナリオの実RRF / Chat source選択と16回のloopback workflow HTTPを追加。
index優先でbaseline 12 / candidate 13ケースの集合差、candidate Recall@20 0.9091、hybrid比較gate 4/8不合格を確認した。
広い品質gateは未達。semantic順位とsynthesisは制御済みで、Next認証route・実LLM・全workflow・自然planner・大規模負荷・production shadow観測・restoreは残る。
固定v1・threshold 0.6、PGroonga primary、本番設定、Step 2運用残件とStep 4削除gateを維持する。

2026-09-21、Issue #759: ユーザー指定でPlan 018の安定稼働確認期間を最低7日からデプロイ当日（Asia/Tokyo）へ変更。
品質閾値・復元試験・rollback用資産保持は維持する。PR #757のshadow deployは9/20 22:10 JSTに成功。
当日5xxは0件だがshadow検索観測0件・404未分類のため、検索品質と切替gateは未判定。
詳細は[当日の安定稼働確認](../operations/keyword-backfill.md)を参照する。

Plan 018 Step 3A（2026-09-17、[Issue #747](https://github.com/dyson-yamashita/pufu-lens/issues/747) / PR #749）: 固定合成keywordコーパスとoffline評価runner、
PGroonga baseline収集・品質残差の記録を実装・検証済み。
Step 3B（Issue #750）で11方式を比較し、5方式が固定品質gate合格。LIKE OR pg_trgm word similarity / GiSTを次候補に提案し、
ADR-005へ実測と限界を記録。Step 3C（Issue #752 / PR #753）でschema / candidate adapter / bounded backfillを実装し、
ローカル合成DBの品質・整合・schema driftを検証。Issue #763で数字境界の既知誤検出を修正し14-case holdoutをcandidate failure 0件へ改善した。Issue #767の広いholdoutと制御済みhybridは品質未達で、大規模負荷・全Chat E2E・
本番適用 / 切替はStep 3D以降のgateに残す。plan全体は`active`を維持する。
本番状態はStep 2の記録を正本とし、この評価基盤の追加では変更しない。plan全体は`active`を維持する。
自然mutation全経路・長期観測・復元試験はStep 2の運用残件として保持し、Issue #747へ移管しない。Step 4の削除判断前にも確認する。

plan の参照・更新ルールは `.codex/rules/plan-rule.md` に従う。
