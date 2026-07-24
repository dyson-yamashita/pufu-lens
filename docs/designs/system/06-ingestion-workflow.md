# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## Ingestion ワークフロー

### 1. Collection Pipeline と Agent の責務

通常の取り込みは、LLM / Agent に毎回判断させず、**データソースごとの決定的な scanner / collector / parser / validator** を中心に実行する。Collection Pipeline は **プロジェクトごとに** 有効な `data_sources` を巡回し、各データソースの `config` / `ingest_window` に従って新規・更新済みの収集候補を発見する。候補の skip / dedup / queue 投入は source contract、DB 制約、hash、設定ルールで判定する。

parser / validator は Git に固定した共通実装だけで完結させず、プロジェクト・データソースごとの format 差分を扱えるように **Parser Registry** で管理する。ただし本番 ingest が実行中に任意の parser へ自動で切り替わることは禁止する。parser は version ごとに immutable artifact として Object Storage に保存し、DB 上の承認状態が `approved` の version だけを Ingestion Workflow が使用する。Job は対象 raw / queue ごとに使用した `parser_version_id`、artifact hash、schema version を記録し、後から「どの parser で parsed JSON が生成されたか」を追跡できるようにする。

評価をパスした候補については、**まず既存 `raw_documents` の有無を確認** し、無ければ元データを取得して Object Storage に原本保存・`raw_documents` を作成、最後に `raw_document_data_sources` で data_source との紐付けを記録し、必要なら `ingestion_queue` に投入する。

Exception Agent は通常経路ではなく、次のような例外・補助用途に限定する。

- source contract に合わない未知形式の raw / parsed data が出たときの調査と parser 修正案の作成
- Parser Registry に登録された draft parser version の validation 結果確認と承認依頼の補助
- ルールだけでは判定しにくい関連度・優先度の一時的なレビュー
- 名寄せ confidence が低い Actor / Document の候補整理
- 失敗 raw を fixture 化し、parser / validator の回帰テストを追加する開発補助

この方針により、取り込み件数に比例してチャットモデルのトークンを消費する設計を避ける。通常運用で LLM コストが発生する主な箇所は embedding 生成、レポート生成、チャット応答であり、収集・parse の正常系はローカルコードと DB / Storage 操作で完結させる。

この設計の意図：

- データソース API（Gmail / GitHub 等）のレート制限が Collection Pipeline 側に集約され、parse / embedding 等の重い処理から独立して並列度・スロットリングを制御できる。
- 一度ストレージに原本を落としておけば、parse の失敗・スキーマ変更時にも再 fetch なしで再処理できる。
- キュー以降の Ingestion Workflow は **DB / グラフ DB / Storage への書き込み専念** となり、外部 API 障害から切り離される。
- 異なる data_source が同じ実体を拾っても、原本は 1 つに統合される（[複数データソース・重複データの扱い](03-data-model.md) 参照）。

主な判定軸：

- データソース条件（Gmail ラベル・メールアドレス、Drive フォルダ、GitHub リポジトリ、Web URL）
- 取り込み期間（初回 backfill、増分取得、lookback days）
- プロジェクト関連度（担当者、キーワード、既存グラフとの近さ）
- 鮮度（前回確認以降の更新、期限やマイルストーンとの近さ）
- 重複・既取り込み判定（`logical_source_id` と `source_version` による同一版検索 → `content_hash` による SAME_AS 候補抽出 → URL canonicalization）
- 優先度（障害、意思決定、未解決 Issue、重要人物のメール等）

**重複判定の擬似フロー**：

```
for each candidate in scanned:
  rawCandidate = fetchOrBuildCandidate(candidate)
  existing = SELECT * FROM raw_documents
             WHERE project_id = $1 AND source_type = $2
               AND logical_source_id = rawCandidate.logicalSourceId
               AND source_version = rawCandidate.sourceVersion
  if existing:
    # 同じ実体を別 data_source が拾った
    INSERT ... INTO raw_document_data_sources
      VALUES (existing.id, current_data_source.id, ..., last_seen_at = now())
      ON CONFLICT (raw_document_id, data_source_id)
      DO UPDATE SET last_seen_at = now(), match_reason = EXCLUDED.match_reason
    if existing.ingest_status = 'failed':
      enqueue(existing.id)                    # status=pending、attempts=0、last_error=NULL で再試行
    else:
      skip                                    # 既に indexed / parsed なら何もしない
  else:
    raw = storeRaw(rawCandidate)               # 原本を Object Storage へ版単位で保存
    sameHashCandidates = SELECT id FROM raw_documents
                         WHERE project_id = $1
                           AND content_hash = raw.contentHash
    # sameHashCandidates は同一 source_type / 別 source_type のどちらも raw を統合せず、
    # SAME_AS 候補として metadata / graph 構築時に使う
    INSERT INTO raw_documents (...)            # ingest_status = 'fetched'
    INSERT INTO raw_document_data_sources ...
    enqueue(raw.id)

  # candidate 列挙、raw/link/queue 保存が全件成功し、limit で打ち切られていない場合だけ進める
  UPDATE data_sources
    SET last_checked_at = now(), last_sync_succeeded_at = now(), sync_cursor = nextCursor
```

```typescript
// src/mastra/workflows/curate-workflow.ts
export const curateWorkflow = createWorkflow({
  id: 'curate-workflow',
  inputSchema: z.object({
    projectId: z.string().uuid().optional(), // 指定なしなら全プロジェクト
    sourceTypes: z.array(z.string()).optional(),
    dataSourceIds: z.array(z.string()).optional()
  }),
  execute: async ({ inputData }) => {
    const projects = await loadEnabledProjects(inputData.projectId);

    for (const project of projects) {
      const dataSources = await loadEnabledDataSources({
        projectId: project.id,
        sourceTypes: inputData.sourceTypes,
        dataSourceIds: inputData.dataSourceIds
      });
      for (const dataSource of dataSources) {
        const connection = await loadConnection(dataSource.connectionId);
        const scanner = getSourceScanner(dataSource.sourceType);
        const candidates = await scanner.scan({ project, dataSource, connection });

        for (const candidate of candidates) {
          if (!shouldCollectCandidate({ project, dataSource, candidate })) continue;

          const rawCandidate = await buildRawCandidate({
            project,
            dataSource,
            candidate,
            connection
          });
          const existing = await lookupRawDocumentVersion({
            projectId: project.id,
            sourceType: rawCandidate.sourceType,
            logicalSourceId: rawCandidate.logicalSourceId,
            sourceVersion: rawCandidate.sourceVersion
          });

          if (existing) {
            await linkDataSource({ rawDocumentId: existing.id, dataSourceId: dataSource.id });
            if (existing.ingestStatus === 'failed')
              await queueCandidate({ rawDocumentId: existing.id });
            continue;
          }

          const raw = await storeRaw(rawCandidate);
          await linkDataSource({ rawDocumentId: raw.id, dataSourceId: dataSource.id });
          await queueCandidate({ rawDocumentId: raw.id });
        }
        await completeDataSourceSync({
          projectId: project.id,
          dataSourceId: dataSource.id,
          syncCursor
        });
      }
    }
  }
});
```

### 2. Ingestion 処理フロー

Collection Pipeline / Agent と Ingestion Workflow の責務を整理すると次のとおり。

```
[Collection Pipeline / curate-workflow]
1. scanSources      データソース API を叩いて候補を列挙
2. evaluate         source contract、設定、hash、DB 制約で関連度・鮮度・重複を評価
3. deriveVersionIdentity source type ごとの論理 ID と版 ID を作る
                      Gmail: threadId:messageId
                      Drive: fileId:revisionId
                      GitHub: repository + issue / PR number : updated_at + content hash
                      Web: configured URL : response body hash
4. lookupExisting   (project_id, source_type, logical_source_id, source_version) で同一 raw 版を検索
4a-existing.        linkDataSource:
                      raw_document_data_sources に (rdid, current_data_source) を upsert
                      （ingest_status='failed' の場合のみ enqueue。それ以外はここで完了）
4b-new.             fetchRaw:
                      Object Storage に原本保存 + raw_documents を作成（status=fetched）
                      content_hash が同じ既存 raw は統合せず SAME_AS 候補として記録
                      linkDataSource → enqueue（ingestion_queue を status=pending で投入）

[Parser Registry / internal metadata]
0. project / data_source / source_type ごとの parser profile / version metadata を DB と Object Storage に保持（監査・再現性・ingestion 互換）
1. built-in default parser version を immutable artifact として Object Storage に保存
2. ingestion / held queue 解決時に approved active version を selectParser で固定
3. parser script 更新は通常運用 UI では行わない（後述）

[Exception Agent / maintenance]
0. failed raw / parsed / low confidence cases を調査
1. source parser / validator の修正案または draft parser version を作成（開発作業。通常 UI 承認フローは使わない）
2. 失敗データを安全な fixture / snapshot test として保存
3. validation report 作成後、Issue / PR / migration 経由で approved version を更新
4. 承認後に held / failed queue を retry

[Ingestion Workflow / ingest-workflow]
1. dequeueTargets   キューから対象を取得（status=pending → parsing）
                    raw_documents.storage_uri は ingestion_queue.raw_document_id 経由で解決
2. selectParser     project_id / data_source_id / source_type / raw metadata に合う
                    approved parser version を Parser Registry から解決する。
                    parsing へ遷移する同一 transaction で ingestion_queue.parser_version_id に固定する。
                    承認済み parser が無い場合は hold_reason=parser_approval_required、
                    raw が active parser の contract に合わない場合は hold_reason=parser_contract_mismatch として停止する。
3. parseRaw         raw_documents.storage_uri から原本を読み出して parse:
                      - 本文抽出
                      - メール: 引用分解、引用送信者抽出
                      - 添付・参照リンク抽出
                      - topic 抽出は HTML tag / title / metadata と Sudachi 由来の語単位候補を先に作り、LLM を使う場合も候補語からの選別・正規化に限定する
                        Sudachi system dictionary は `SUDACHI_SYSTEM_DICT` / `SUDACHI_SYSTEM_DICT_PATH` で指定し、未設定環境では軽量 tokenizer に fallback する
                    parsed JSON を Object Storage に書き戻し、
                    parser_version_id / parser_artifact_hash / parsed_uri / ingest_status を更新（parsed）
4. resolveActors    parsed の中の送信者・作者・レビュアーを actors / actor_aliases に名寄せ
5. chunkAndEmbed    本文をチャンク化し embedding を生成、document_chunks に保存
                    同じ論理 document の最新版 raw だけを対象にし、更新・再 index 時は
                    旧 document_chunks を旧 raw_document_id 付きで document_chunk_history に退避する。
                    同一 transaction で documents.raw_document_id と chunk を最新版へ切り替える
6. storeGraph       documents 行 + AGE グラフへ MERGE（Document ノード 1 つ + 関係）
                    引用チェーンは REPLY_TO で繋ぎ、email_quotes に詳細を保存
                    ソースをまたぐ意味的同一を検出したら SAME_AS 関係を張る（[複数データソース・重複データの扱い](03-data-model.md) 参照）
                    raw_documents.ingest_status を indexed に更新
```

ステップ間は `ingestion_queue.status` と `raw_documents.ingest_status` で進捗を可視化する。途中失敗（例: parse 失敗）したものは `failed` に遷移し、`last_error` / `ingest_error` を残して **原本を再 fetch せずに再試行** できる。承認済み parser が無い、raw が active parser の contract に合わない、または draft parser の承認待ちの場合は `held` に遷移し、`hold_reason` / `parser_profile_id` を残して取り込みを停止する。held の raw は graph / vector / documents へ進めず、承認済み parser version が active になった後に `retry` で再処理する。失敗 raw / parsed は安全にマスクした上で fixture 化し、parser / validator の validation report が承認されてから retry する。

### 3. Parser Registry（安定 canonical extractor）

Parser Registry は **ingestion の監査・再現性・互換** のための internal metadata である。parser の実体は DB に直接保存せず、Object Storage 上の immutable artifact とし、DB には artifact URI、hash、承認状態、validation report URI、承認者を記録する。

parser の責務は **canonical parsed JSON の最小安定抽出** に限定する。サマリ品質改善、source type ごとの読ませ方調整、詳細選別は [Agent Raw Read View](07-chat.md#agent-raw-read-view--raw-document-fetch-契約) 側で吸収する。parser script を案件ごとに更新する運用は行わない。

data source 作成時（server action / transaction）は、対象 data source 固有の built-in parser profile と default **approved** version を **内部 seed** し、active version に設定する。これにより新規 data source は追加直後から default parser で ingest できる。既存 data source や CLI 収集で不足している default parser は、`scripts/parse-raw-documents.ts` の seed 処理で補完できる。**管理 UI から parser profile を作成・承認・却下する導線は持たない**（Issue #294 / [008 Step 2](../../plans/008-agent-raw-reading/overview.md)）。

parser artifact は次のどちらかに限定する。

- built-in parser の version と設定 JSON（例: Web main text 抽出 rule、Gmail quote split rule）
- sandbox 可能な宣言的 parser bundle（将来拡張）。任意 TypeScript / shell script を本番 DB から直接実行しない。

#### parser script 更新を許可する例外条件

通常運用では parser を更新しない。次の場合のみ、Issue / PR / migration / fixture regression を伴う **開発作業** として更新する。

| 条件                       | 例                                                        |
| -------------------------- | --------------------------------------------------------- |
| raw contract 破壊的変更    | provider payload shape 変更で既存 parser が parse 不能    |
| security / correctness bug | PII 漏洩、誤抽出、index 不能な誤パース                    |
| parsed schema version 更新 | canonical parsed JSON schema の version bump              |
| 重大 indexing 不能         | chunk / graph / embedding まで進めない systematic failure |

上記以外（report 品質改善、chat 回答改善、source type ごとの読解調整）は **read adapter / Agent raw read view** 更新で対応する。

#### 承認状態と held queue（runtime 契約）

ingestion は **approved active parser version** を `selectParser` で解決する。DB 上の `draft` / `review_requested` / `rejected` 状態と validation report metadata は監査用に残すが、**reviewer UI による通常承認フローは廃止** した。

1. draft parser version を作成し、artifact hash を固定する（開発作業）。
2. fixture / held raw に対して dry-run validation を行う。
3. validation report を Object Storage に保存し、DB に記録する。
4. PR / migration レビューで parsed diff、mask 結果、schema validation、対象範囲を確認する。
5. merge 後に approved version を active に昇格する（DB 更新は migration / script / server seed）。
6. held queue を retry すると、retry 時点の active approved version が `ingestion_queue.parser_version_id` に固定される。

Cloud Run Job のローカルファイルシステムは実行ごとに揮発する前提にする。parser artifact、validation report、raw、parsed は Object Storage、状態と承認履歴は PostgreSQL に保存する。Job は起動時または対象 batch の開始時に approved parser artifact を取得し、artifact hash を検証してから実行する。`dequeueTargets` / `selectParser` は queue item を `parsing` に遷移させる時点で解決済み parser version を `ingestion_queue.parser_version_id` に書き込み、実行中に parser profile の active version が変わっても、その batch / queue item に固定した `parser_version_id` を使い続ける。

チャンク更新は transaction で扱う。`documents` の内容が更新された場合、または parser / chunk 設定 / embedding model の変更で再 index する場合は、現在の `document_chunks` を更新前の `documents.raw_document_id` とともに `document_chunk_history` へコピーする。その transaction 内で `documents.raw_document_id` を新 raw へ更新し、旧 chunk を削除して新 chunk を挿入する。parsed 対象の選択では同じ logical source の最新 raw だけを処理し、旧 raw の再実行で document を過去版へ戻さない。検索・チャットは常に `document_chunks` の最新版だけを参照し、履歴は監査、差分確認、問題発生時の再現に使う。

### 4. 実装スケッチ

```typescript
// src/mastra/workflows/ingest-workflow.ts
export const ingestWorkflow = createWorkflow({
  id: 'ingest-workflow',
  inputSchema: z.object({
    projectId: z.string().uuid().optional(), // 指定なしなら全プロジェクト
    since: z.string().optional()
  }),
  execute: async ({ inputData }) => {
    const projects = await loadEnabledProjects(inputData.projectId);
    const results = [];

    // 原本取得は curate-workflow（Collection Pipeline）側で完了済みのため、
    // ここでは raw_documents.storage_uri を起点に parse 以降のみを実行する。
    for (const project of projects) {
      const ctx = { projectId: project.id, since: inputData.since };
      const targets = await dequeueTargetsStep.execute({ inputData: ctx });
      const parsed = await parseRawStep.execute({ inputData: { ...ctx, targets } });
      const resolved = await resolveActorsStep.execute({ inputData: { ...ctx, parsed } });
      const chunked = await chunkAndEmbedStep.execute({ inputData: { ...ctx, parsed: resolved } });
      const stored = await storeGraphStep.execute({
        inputData: { ...ctx, parsed: resolved, chunked }
      });
      results.push({ projectId: project.id, stored });
    }
    return results;
  }
});
```

ポイント：

- 原本保存は Collection Pipeline の source adapter が責任を持ち、Ingestion Workflow は `raw_documents` を起点に動く。
- LLM / Agent は通常の取り込み判定には使わず、未知形式・低 confidence・parser 修正などの例外処理に限定する。
- すべてのステップで `projectId` を必須コンテキストにし、AGE グラフ名・ストレージプレフィックスを動的に解決する。
- `MERGE` を使用してノード・エッジ・チャンクの重複を回避する。
- メールは Gmail API の `threadId` で同一スレッドを判定し、**スレッド内の最新メールだけ** `documents` に登録、それ以前は `email_quotes` に分解。
- Drive Doc は file ID を論理 ID、`revisionId` を版 ID とし、過去版は `raw_documents` に保持したまま同じ Document ID を最新版へ切り替える。
- Web ページは configured URL を論理 ID、`content_hash` を版 ID とする。canonical / redirect URL が変わっても論理 ID は変えず、本文 hash が同じ場合は既存 raw 版を再利用する。

### Synthetic Monitor の readonly 観測境界

Synthetic Monitor は `POST /internal/monitoring/v1/observations` から ingestion pipeline の各 stage（`raw` / `currentDocument` / `chunks` / `graph` / `schedule`）を **読み取り専用** で観測する。source schedule は expected raw version ではなく logical source identity（`project_id` + `source_type` + `logical_source_id`）で `data_source_schedules` を辿る。内部の `raw_documents` / `documents` / AGE graph schema や storage URI、provider payload は response に含めず、stage ごとの `ok` / `pending` / `failed` / `not_found` と schedule の `nextRunDue` だけを返す。queue 投入、parser 切替、graph 更新、schedule 変更は行わない。

---
