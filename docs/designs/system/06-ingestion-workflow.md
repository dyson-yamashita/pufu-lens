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
- 重複・既取り込み判定（source type ごとの正規化済み `source_id` による既存検索 → `content_hash` による更新検知 / SAME_AS 候補抽出 → URL canonicalization）
- 優先度（障害、意思決定、未解決 Issue、重要人物のメール等）

**重複判定の擬似フロー**：

```
for each candidate in scanned:
  normalizedSourceId = normalizeSourceId(candidate) # Gmail: threadId:messageId 等
  existing = SELECT * FROM raw_documents
             WHERE project_id = $1 AND source_type = $2 AND source_id = normalizedSourceId
  if existing:
    # 同じ実体を別 data_source が拾った
    INSERT ... INTO raw_document_data_sources
      VALUES (existing.id, current_data_source.id, ..., last_seen_at = now())
      ON CONFLICT (raw_document_id, data_source_id)
      DO UPDATE SET last_seen_at = now(), match_reason = EXCLUDED.match_reason
    if existing.ingest_status = 'failed':
      enqueue(existing.id)                    # 再試行のみ
    else:
      skip                                    # 既に indexed / parsed なら何もしない
  else:
    raw = fetchRawTool(candidate)              # 原本を Object Storage へ保存
    sameHashCandidates = SELECT id FROM raw_documents
                         WHERE project_id = $1
                           AND content_hash = raw.contentHash
                           AND source_type <> raw.sourceType
    # sameHashCandidates は raw を統合せず、SAME_AS 候補として metadata / graph 構築時に使う
    INSERT INTO raw_documents (...)            # ingest_status = 'fetched'
    INSERT INTO raw_document_data_sources ...
    enqueue(raw.id)
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

          const existing = await lookupRawDocument({
            projectId: project.id,
            sourceType: candidate.sourceType,
            sourceId: normalizeSourceId(candidate)
          });

          if (existing) {
            await linkDataSource({ rawDocumentId: existing.id, dataSourceId: dataSource.id });
            if (existing.ingestStatus === 'failed')
              await queueCandidate({ rawDocumentId: existing.id });
            continue;
          }

          const raw = await fetchRaw({ project, dataSource, candidate, connection });
          await linkDataSource({ rawDocumentId: raw.id, dataSourceId: dataSource.id });
          await queueCandidate({ rawDocumentId: raw.id });
        }
        await markDataSourceChecked(dataSource.id);
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
3. normalizeSourceId source type ごとの正規化キーを作る
                      Gmail: threadId:messageId
                      Drive: fileId:revisionId
                      GitHub: issue / PR / comment / diff の正規化キー
                      Web: canonical URL
4. lookupExisting   (project_id, source_type, source_id) で既存 raw_documents を検索
4a-existing.        linkDataSource:
                      raw_document_data_sources に (rdid, current_data_source) を upsert
                      （ingest_status='failed' の場合のみ enqueue。それ以外はここで完了）
4b-new.             fetchRaw:
                      Object Storage に原本保存 + raw_documents を作成（status=fetched）
                      content_hash が同じ既存 raw は統合せず SAME_AS 候補として記録
                      linkDataSource → enqueue（ingestion_queue を status=pending で投入）

[Parser Registry / approval]
0. project / data_source / source_type ごとの parser profile を登録
1. draft parser version を immutable artifact として Object Storage に保存
2. fixture / held raw に対する validation report を生成
3. reviewer が diff、validation report、secret / PII mask 結果を確認
4. approved になった parser version だけを active に昇格

[Exception Agent / maintenance]
0. failed raw / parsed / low confidence cases を調査
1. source parser / validator の修正案または draft parser version を作成
2. 失敗データを安全な fixture / snapshot test として保存
3. validation report 作成後、承認待ちにする
4. 承認後に held / failed queue を retry

[Ingestion Workflow / ingest-workflow]
1. dequeueTargets   キューから対象を取得（status=pending → parsing）
                    raw_documents.storage_uri は ingestion_queue.raw_document_id 経由で解決
2. selectParser     project_id / data_source_id / source_type / raw metadata に合う
                    approved parser version を Parser Registry から解決する。
                    承認済み parser が無い、または raw が active parser の contract に合わない場合は
                    status=held、hold_reason=parser_approval_required として停止する。
3. parseRaw         raw_documents.storage_uri から原本を読み出して parse:
                      - 本文抽出
                      - メール: 引用分解、引用送信者抽出
                      - 添付・参照リンク抽出
                    parsed JSON を Object Storage に書き戻し、
                    parser_version_id / parser_artifact_hash / parsed_uri / ingest_status を更新（parsed）
4. resolveActors    parsed の中の送信者・作者・レビュアーを actors / actor_aliases に名寄せ
5. chunkAndEmbed    本文をチャンク化し embedding を生成、document_chunks に保存
                    更新・再 index 時は旧 document_chunks を document_chunk_history に退避し、
                    旧チャンクを削除してから新しいチャンクを挿入する
6. storeGraph       documents 行 + AGE グラフへ MERGE（Document ノード 1 つ + 関係）
                    引用チェーンは REPLY_TO で繋ぎ、email_quotes に詳細を保存
                    ソースをまたぐ意味的同一を検出したら SAME_AS 関係を張る（[複数データソース・重複データの扱い](03-data-model.md) 参照）
                    raw_documents.ingest_status を indexed に更新
```

ステップ間は `ingestion_queue.status` と `raw_documents.ingest_status` で進捗を可視化する。途中失敗（例: parse 失敗）したものは `failed` に遷移し、`last_error` / `ingest_error` を残して **原本を再 fetch せずに再試行** できる。承認済み parser が無い、raw が active parser の contract に合わない、または draft parser の承認待ちの場合は `held` に遷移し、`hold_reason` / `required_parser_profile_id` を残して取り込みを停止する。held の raw は graph / vector / documents へ進めず、承認済み parser version が active になった後に `retry` で再処理する。失敗 raw / parsed は安全にマスクした上で fixture 化し、parser / validator の validation report が承認されてから retry する。

### 3. Parser Registry と承認制

Parser Registry は「どの project / data_source / source_type に、どの parser version を使うか」を管理する。parser の実体は DB に直接保存せず、Object Storage 上の immutable artifact とし、DB には artifact URI、hash、承認状態、validation report URI、承認者を記録する。

parser artifact は次のどちらかに限定する。

- built-in parser の version と設定 JSON（例: Web main text 抽出 rule、Gmail quote split rule）
- sandbox 可能な宣言的 parser bundle（将来拡張）。任意 TypeScript / shell script を本番 DB から直接実行しない。

承認フロー：

1. draft parser version を作成し、artifact hash を固定する。
2. 対象 project / data_source の fixture と held raw に対して dry-run validation を行う。
3. validation report を Object Storage に保存し、DB に `review_requested` として記録する。
4. reviewer が parsed diff、mask 結果、schema validation、対象範囲を確認する。
5. 承認された version だけを `approved` にし、必要なら parser profile の active version に昇格する。
6. held queue を retry すると、retry 時点の active approved version が queue に固定される。

Cloud Run Job のローカルファイルシステムは実行ごとに揮発する前提にする。parser artifact、validation report、raw、parsed は Object Storage、状態と承認履歴は PostgreSQL に保存する。Job は起動時または対象 batch の開始時に approved parser artifact を取得し、artifact hash を検証してから実行する。実行中に parser profile の active version が変わっても、その batch / queue item に固定した `parser_version_id` を使い続ける。

チャンク更新は transaction で扱う。`documents` の内容が更新された場合、または parser / chunk 設定 / embedding model の変更で再 index する場合は、現在の `document_chunks` を `document_chunk_history` にコピーし、`document_chunks` から削除した上で新しいチャンクを挿入する。検索・チャットは常に `document_chunks` の最新版だけを参照し、履歴は監査、差分確認、問題発生時の再現に使う。

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
- Drive Doc は `revisionId` をキーに最新版だけ Document を作る（過去版は `raw_documents` のみ）。
- Web ページは `content_hash` 差分で再 indexing をスキップする（差分なしの場合は Collection Pipeline 側で fetch をスキップして既存 `raw_document_id` を再利用）。

---
