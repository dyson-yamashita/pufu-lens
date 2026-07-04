# Public / Private Result Parity

## 目的

public project の chat / report 結果を private 経路をベースに揃える。公開可否の判定とレスポンス上の redaction は public 入口に残すが、回答生成、report JSON、renderer、PDF 生成の中核処理は private と同じものを使う。

## 背景

設計書では public report / public chat は private report / private chat と同じ処理を使い、違いはアクセス権だけに限定する方針になっている。現状の report detail は private report JSON を public でも描画しており、方針に概ね沿っている。一方で public chat は `project-chat-agent` を呼んでいるものの、private chat と比べて `graphName`、会話履歴、保存、source / tool call のレスポンス変換が分岐している。

この plan では、private を基準に public との差分を明示し、必要な箇所だけ public gate / redaction として残す。

## 方針

- public report detail / PDF は private report JSON を読み、private と同じ renderer / PDF generator を使う現行方針を維持する。
- public report の access gate は `projects.visibility = 'public'` と `reports.is_public = true` を DB で確認し、private project / 未公開 report は存在有無を漏らさず `404` にする。
- public chat は public report access gate を通した後、private chat と同じ `project-chat-agent`、`createMastraProjectChatBody`、`mastraGenerateToChatResponse` を使う。
- private chat と同じ project context を渡すため、public chat でも `projectId` と `graphName` を Mastra request context に含める。
- public chat のレスポンスは公開入口として安全な shape に整える。raw body、private locator、内部 storage URI、`documentId`、`rawDocumentId` は public response に出さない。
- public project の latest report chat alias は、最新公開 report を選ぶ入口として残す。ただし実行本体は report-scoped public chat と共有する。
- 旧 public report artifact / public context bundle / `public-report-chat-agent` は現行実行経路の正としない。互換・検証用途で残す場合は、private ベースの実行経路と混同しないようにする。

## 現在の差分

| 領域                 | private                                                               | public                                                               | 対応                                                                |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| report JSON          | `getPrivateReport` が member 認可後に private report JSON を読む      | `getPublicReport` が public gate 後に同じ private report JSON を読む | 現状維持                                                            |
| report renderer      | `ReportDocument` が `StandardReportSections` / custom renderer を使う | `PublicReportDocument` が同じ report JSON と renderer を使う         | 削除ボタンなど private 操作だけ差分として残す                       |
| chat agent           | `project-chat-agent`                                                  | `project-chat-agent`                                                 | 現状維持                                                            |
| chat request context | `projectId`、`graphName`、履歴                                        | `projectId` のみ                                                     | `graphName` を追加。履歴は public では保存しないため空でよい        |
| chat response source | `ChatSource` を返す                                                   | report 内 source に対応する `PublicChatSource` へ変換                | public response redaction として残す                                |
| chat tool calls      | `vector-search` / `graph-query` など実 tool 名                        | `public-report-fetch` に集約                                         | private と同じ結果確認のため、公開可能な tool call summary へ寄せる |
| Mastra public agent  | 不使用                                                                | `public-report-chat-agent` が runtime / test に残る                  | 現行 public chat の正規経路からは外す。必要なら後続で整理           |

## Step

| Step | status      | 内容                                                                                | 完了条件                                                                                       |
| ---- | ----------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | `completed` | public chat の Mastra request context を private chat と揃える。Issue #425。        | public chat が `projectId` と `graphName` を渡し、private chat と同じ response parser を使う。 |
| 2    | `completed` | public/private chat response の source / tool call 表示方針を整理する。Issue #429。 | public response が機密値を出さず、private と同じ実行結果を追跡できる。                         |
| 3    | `completed` | `public-report-chat-agent` など旧 public 専用経路の扱いを整理する。                 | 現行経路と互換・検証用経路の責務が docs / tests で明確になっている。                           |
| 4    | `planned`   | report detail / PDF の parity regression を補強する。                               | private/public が同じ private report JSON を描画・PDF 化する regression がある。               |

## Step 1 実装方針

- `ReportRepository.lookupProject` の戻り値に `graphName` を追加し、public access gate 後の project context として使えるようにする。
- `assertPublicReportAccess` の戻り値から `project.graphName` を参照し、`handlePublicChatPost` の `createMastraProjectChatBody` に渡す。
- public chat の response parser は `mastraGenerateToChatResponse` のまま使い、private と同じ `editing` / `sources` / `toolCalls` を取得してから public response へ redaction 変換する。
- regression test では `createMastraProjectChatBody` が `graphName` を含むこと、public source 変換に private `documentId` / `rawDocumentId` が出ないことを確認する。

## Step 2 実装方針

- public chat の source は引き続き report 内 source と照合した `PublicChatSource` に redaction し、`documentId` / `rawDocumentId` / `canonicalUri` を public response に出さない。
- public chat の tool call は private `project-chat-agent` から得た `ChatToolCall` の `name` と `resultCount` を保持する。tool 名と件数だけに限定し、tool の raw body / query / locator は返さない。
- 旧 `public-report-chat-agent` 経路の `public-report-fetch` / `public-context-fetch` は互換用の public tool name として型上は残すが、現行 public project chat の正規経路では private tool name を返す。

## Step 3 整理結果

- 現行の public project/report chat は、Next.js の public access gate 通過後に `project-chat-agent` へ proxy する経路を正とする。
- `public-report-chat-agent`、`public-report-fetch`、`public-context-fetch` は、redaction 済み public report JSON / public context bundle だけを扱う互換・回帰検証用経路として残す。
- 実行時の公開安全性は、Next.js 側の public gate、private report JSON 読み込み後の ID 照合、`ChatSource` から `PublicChatSource` への redaction、公開可能な tool call summary への変換で担保する。
- docs / tests では、public chat の正規経路が `project-chat-agent` であることと、legacy public agent の ID / URL / body builder が互換用として残ることを分けて確認する。

## テスト計画

- `pnpm --filter @pufu-lens/web test`
- `pnpm --filter @pufu-lens/mastra test`
- 必要に応じて `pnpm typecheck`
- UI 差分が出る場合は `pnpm --filter @pufu-lens/web test:e2e`

## 実装時の注意

- public 入口では private project / 未公開 report の存在有無を漏らさない。
- public response / log / trace に raw body、private raw locator、storage URI、OAuth token、secret、API key、メールアドレスを出さない。
- 認可 SQL や project lookup の shape を変更する場合は runtime guard を更新し、無検証 cast を追加しない。
- app 間の `src` 相対 import を追加しない。
- 既存の未追跡 `contracts/` はこの plan の対象外として触らない。
