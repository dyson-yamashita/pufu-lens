# Chat 検索候補カバレッジ改善計画（top-k から score-aware 選別へ）

## 目的

Private chat のハイブリッド検索は、現在すべての段階で件数固定の top-k 打ち切りを使っている。このため次の 2 つの問題が同時に起きる。

- **取りこぼし**: 上位 5 件とほぼ同じ距離・スコアの候補が 6 位以下というだけで一律に落ちる。
- **押し出しノイズ**: corpus に関連情報がない質問でも「最も近い 5 件」が必ず返り、無関係な候補が synthesis に渡る。

この計画では、距離・スコアを検索パイプラインに透過させ、固定 top-k を「上限・下限付きの score-aware な適応的選別」に置き換える。あわせて、010 plan（編集技法）で導入済みの編集操作分類を検索量の制御に接続し、「問いの型が取材量を決める」という編集工学の視点を retrieval 層まで通す。

## 背景（現状の実装）

対象は `apps/web/src/private-chat-search.ts` と `apps/web/src/chat.ts` の `createPostgresChatRepository`。

| 段階 | 現状 | 定数 |
| --- | --- | --- |
| primary vector 検索 | pgvector 距離順 + PGroonga キーワードを RRF（k=60）で統合し、document 単位で top-k | `PRIMARY_VECTOR_LIMIT = 5` |
| SQL 内候補プール | chunk 候補は各系列 `clamp(limit * 20, 50, 200)` 件まで集めるが、最終出力で 5 件に切る | `hybridSearchCandidateLimit` |
| 検索語展開 | 最大 6 query × 各 top-5 を weighted RRF（元質問 weight 2）で統合し 5 件に切る | `MAX_MERGED_SOURCES = 5` |
| graph / timeline / detail | それぞれ 5 件固定 | `GRAPH_LIMIT` / `TIMELINE_LIMIT` / `DETAIL_DOCUMENT_LIMIT` |
| simplified retry | 「vector 結果が 0 件」のときだけ発火 | — |

現状の構造的な問題:

1. **スコアの不可視化**: SQL 内で `dc.embedding <=> query` の距離と `pgroonga_score` を計算しているが、順位付けにしか使わず、値は repository の外に返らない。閾値判定も、synthesis への確信度伝搬もできない。
2. **同点圏の切断**: RRF は順位のみを使うため、距離 0.31 / 0.32 / 0.33 / 0.60 / 0.61 のような分布でも 5 件目まで機械的に採用し、逆に 0.33 と僅差の 6 位を落とす。スコアの「崖」と件数の区切りが一致しない。
3. **retry の死文化**: pgvector の top-k は corpus に chunk がある限りほぼ必ず limit 件返すため、「0 件なら simplified retry」はほぼ発火しない。検索が弱かったことを検知する信号が「0 件」しかない。
4. **RRF 統合の母集団が浅い**: 展開語ごとの候補 list が各 5 件しかないため、全 list で 6 位の document は fusion スコア 0 になる。複数検索語の「弱い合意」を拾えない。
5. **編集操作分類の未接続**: `PrivateChatQuestionClassification`（primaryOperation / figure / ground / confidence）は timeline step の分岐にしか使われず、comparison / relation のような「広く集めるべき問い」でも identification と同じ 5 件で打ち切る。
6. **多様性の欠如**: 上位 5 枠を同一 raw document 由来やほぼ同内容の document が占有しても抑制がない。

## 設計方針

編集工学の「収集 → 選別 → 編集」の順で言えば、現状は収集と選別が「件数」という単一の物差しに縛られている。方針は次の 3 点。

1. **地（スコア分布）を見てから図(採用候補)を切る**: 固定 k ではなく、スコア分布の崖・閾値・上下限から採用境界を決める。
2. **問いの型が取材量を決める**: 編集操作分類ごとに `kMin` / `kMax` / 絞り込み強度を変える。
3. **選別は決定論的に**: 閾値判定・崖検出・多様性 quota はすべて純関数で実装し、LLM には依存しない。既存の deterministic retrieval 原則（07-chat.md）を維持する。

### 1. スコアの透過（基盤）

- `ChatSource` に内部用 optional field を追加する: `vectorDistance` / `vectorRank` / `keywordRank` / `fusedScore`。
- `vectorSearch` の SQL で計算済みの距離・順位を SELECT に含めて返す。
- `fuseChatSourceRankings` は fusion 後スコアを候補に付与して返す。
- これらの field は retrieval 内部専用とし、`ChatResponse` / public chat response / UI には露出しない（既存 `formatPrivateChatRetrievalContext` の source shape は変えない）。

### 2. 適応的カットオフ（固定 top-k の置き換え）

取得は広め（`kMax`、例: 15 documents）に行い、採用は決定論的な純関数で絞る。

```typescript
interface ChatSourceSelectionPolicy {
  readonly kMin: number;            // 崖検出でもこれ未満には削らない
  readonly kMax: number;            // 取得・採用の上限
  readonly maxDistance?: number;    // 絶対閾値: これより遠い候補は kMin 未満でも落とす
  readonly relativeWindow?: number; // 相対閾値: best distance + δ を超える候補を落とす
  readonly gapRatio?: number;       // 崖検出: 隣接距離差が分布に対してこの比を超えたら切る
}

function selectChatSourcesByScoreProfile(
  sources: readonly ChatSource[],
  policy: ChatSourceSelectionPolicy,
): ChatSource[];
```

- **絶対閾値** (`maxDistance`): 「関連なし」の押し出しノイズを落とす。cosine 距離の妥当値は embedding model に依存するため、`embedding_model` 値をキーに設定し、モデル変更時は再計測を必須とする。
- **相対閾値** (`relativeWindow`): best との差で同点圏を残す。上位が団子なら 5 件を超えて採用し、上位 2 件だけ突出しているなら 3 件目以降を落とす。
- **崖検出** (`gapRatio`): 距離昇順で隣接差が最大の位置（`kMin`..`kMax` の範囲内）を採用境界にする。
- スコア field が欠けている候補（後方互換・graph 由来など）はフィルタ対象にせず従来順位で扱い、全候補にスコアがない場合は現行 top-k と同一の挙動に fallback する。
- RRF 統合後スコアに閾値をかける場合は、list 数と weight に依存するため理論最大値（`Σ weight_i / (k + 1)`）で正規化した比率で判定する。生の RRF 値に絶対閾値を置かない。
- SQL 側は `ORDER BY ... LIMIT kMax` を維持し（pgvector index が効く形を崩さない）、閾値・崖の判定はアプリ側で行う。

### 3. 編集操作分類と検索量の接続

`PrivateChatQuestionClassification.primaryOperation` から selection policy を引く。

| 編集操作 | 方針 | 例 |
| --- | --- | --- |
| `identification` / `decision` | 狭く深く: `kMax` 小さめ、相対閾値を強め、detail fetch を優先 | kMin 3 / kMax 8 |
| `comparison` / `relation` / `cause` | 広く: `kMax` 大きめ、相対閾値を緩め、多様性 quota を有効化 | kMin 5 / kMax 15 |
| `timeline` / `process` | 広く + timeline 優先の現行挙動を維持 | kMin 5 / kMax 12 |
| `general`（分類失敗含む） | 現行相当の保守的既定値 | kMin 5 / kMax 10 |

- `confidence: 'low'` の場合は `general` の既定 policy に落とす。分類の揺れで検索品質を悪化させない。
- policy はコード内の deterministic な表で持ち、LLM 出力から数値を受け取らない。

### 4. retry / expansion 発火条件の再定義

「0 件」ではなく「閾値を満たす候補が 0 件」または「best distance が絶対閾値超え」を弱い検索の信号とする。

- `resolvePrivateChatRetryQueries` / `shouldRunPrivateChatRetryStep` の判定を `mergedVectorSources.length === 0` から「採用候補（スコア閾値通過後）が 0 件」に変更する。
- これにより simplified retry と展開語再検索が、実際に検索が弱かったときに機能するようになる。

### 5. 多様性 quota（決定論的）

- 採用候補のうち同一 `raw_document_id` は 1 document までとする（SAME_AS 相当の重複占有を抑制）。
- `docType` / source type ごとの上限（例: 1 種別で採用枠の 2/3 まで）を policy に含め、`comparison` / `relation` で有効化する。
- embedding 類似度ベースの MMR は初期範囲に含めない（決定論性とコストを優先し、必要になった時点で別途検討する）。

### 6. 検索確信度の synthesis への伝搬

`formatPrivateChatRetrievalContext` の `note` に retrieval 強度を含める。

- `strong`: 絶対閾値内の候補が kMin 件以上。
- `weak`: 候補はあるが閾値ぎわ、または retry 後にのみ確保。「確証が薄い」前提で回答するよう明示。
- `none`: 閾値通過候補なし。既存の「未確認の事実を述べないでください」注記を維持。

数値スコアそのものは context に入れず、段階ラベルと件数のみとする（LLM がスコアを事実として引用するのを防ぐ）。

### 対象外（この計画でやらないこと）

- LLM reranker の導入（widen → LLM 選別）。決定論的選別で不足が確認されてから別 plan で検討する。
- `MAX_MERGED_SOURCES` を超えた synthesis context の大幅拡大。token コスト（13-cost.md）に直結するため、本計画では「同点圏の入れ替え・ノイズ除去」を主目的とし、最終 source 数の上限緩和は eval 結果を見て判断する。
- public chat の source 公開ポリシー変更。スコア field は public response に出さない。

## Step 構成

| Step | status | 内容 | 完了条件 |
| --- | --- | --- | --- |
| 1 | `planned` | スコア透過と距離分布計測 | `ChatSource` にスコア field が返り、既存挙動が不変。project 実データで距離分布を出力する計測スクリプトが scripts に入る |
| 2 | `planned` | 決定論的カットオフ関数と primary / fused への適用 | `selectChatSourcesByScoreProfile` の unit test（空・全同値・単調・崖あり・スコア欠落 fallback）が通り、retry 発火条件が「閾値通過 0 件」に変わる |
| 3 | `planned` | 編集操作分類 → selection policy 接続 | primaryOperation ごとに kMin / kMax / quota が切り替わり、分類失敗時は現行相当の既定値に fallback する |
| 4 | `planned` | 多様性 quota と確信度伝搬 | raw_document_id 重複抑制と docType quota が有効になり、retrievalContext に strong / weak / none が入る |
| 5 | `planned` | eval fixture / regression / docs 更新 | 下記テスト計画の fixture が通り、07-chat.md に score-aware 選別の記述が反映される |

## テスト計画

- **unit test**: カットオフ関数の境界（空配列、全候補同距離、距離単調増加、明確な崖、`kMin`/`kMax` クリップ、スコア欠落時の現行 top-k fallback、RRF 正規化閾値）。
- **repository test**: `vectorSearch` がスコア field を返すこと、SQL の ORDER / LIMIT が index 利用形を維持していること（`postgres-roundtrip.test.ts` 系に追加）。
- **eval fixture 追加**（`pnpm chat:eval`）:
  - 取りこぼし系: 正解 document が現行 rank 6〜10 に位置する質問で、改善後に source へ入ること。
  - ノイズ系: corpus に存在しない事柄への質問で、source が絞られ「不明」と回答すること（`private-chat-eval.json` の拒否系を拡張）。
  - 既存 fixture（`private-chat-eval.json` / `private-chat-raw-injection-eval.json`）の regression が通ること。
- **計測**: Step 1 の分布計測スクリプトで sample project の距離分布（正解 / 非正解の分離度）を確認し、`maxDistance` / `relativeWindow` の初期値を決めてから Step 2 に入る。

## 実装時の注意

- 距離閾値は embedding model 固有の値である。`GEMINI_EMBEDDING_MODEL` 変更時は再計測が必要であることを設定箇所の docstring と 07-chat.md に明記する。閾値は `embedding_model` 値をキーに管理し、未知モデルでは閾値フィルタを無効化（現行 top-k 挙動）する。
- pgvector の近似 index（HNSW / IVFFlat）利用時、`kMax` を広げても `ORDER BY distance LIMIT n` の形を崩さない。距離での WHERE フィルタを SQL に入れると index を外れる可能性があるため、閾値判定はアプリ側で行う。
- `kMax` 拡大は SQL 候補プール（`hybridSearchCandidateLimit`）と RRF 母集団の拡大を伴う。DB 負荷と応答時間を Step 1 の計測に含める。
- 検索順・tie-break・dedupe の決定論性（07-chat.md の Workflow 原則）を全 Step で維持する。選別 policy に乱数・時刻・LLM 出力由来の数値を入れない。
- スコア・確信度ラベルは private 内部情報として扱い、public chat response / Evidence Panel の公開表示に出さない。
