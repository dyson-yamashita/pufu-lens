import type postgres from 'postgres';
import { createReportStorageFromEnv } from '../../apps/web/src/report.ts';
import { validateParsedDocument } from '../../packages/ingestion/dist/index.js';
import { liveChatDocuments } from './live-chat-corpus.ts';

/** Adds synthetic graph edges and real local artifacts inside the guarded disposable live DB. */
export async function seedLiveChatDetails(sql: postgres.Sql, projectId: string): Promise<void> {
  const storage = createReportStorageFromEnv();
  const ids = new Map<string, string>();
  for (const doc of liveChatDocuments) {
    const rows =
      await sql`SELECT id::text FROM documents WHERE project_id = ${projectId} AND logical_source_id = ${doc.key}`;
    const id: unknown = rows[0]?.id;
    if (typeof id !== 'string') throw new Error(`Missing synthetic document: ${doc.key}`);
    ids.set(doc.key, id);
    const rawUri = `local-dev/raw/live-chat/${doc.key}.html`;
    const parsedUri = `local-dev/parsed/live-chat/${doc.key}.json`;
    const extra =
      doc.key === 'glass'
        ? '<p>原文限定の点検規則: 毎週水曜日に点検する。点検確認コードは SYNTH-RAW-GLASS-91。</p>'
        : '';
    await storage.put(
      rawUri,
      `<html><head><title>${doc.title}</title></head><body><p>${doc.content}</p>${extra}</body></html>`,
      { contentType: 'text/html' },
    );
    const parsed = validateParsedDocument({
      schemaVersion: 1,
      sourceType: 'web',
      sourceId: doc.key,
      docType: 'web_page',
      title: doc.title,
      canonicalUri: `https://example.test/${doc.key}`,
      occurredAt: doc.date,
      bodyText: doc.content,
      actors: [],
      relations: [],
      metadata: {},
    });
    await storage.put(parsedUri, JSON.stringify(parsed), {
      contentType: 'application/json',
    });
    await sql`UPDATE raw_documents SET storage_uri = ${rawUri}, parsed_uri = ${parsedUri}, parsed_at = now() WHERE id = ${id} AND project_id = ${projectId}`;
    await sql`INSERT INTO graph_nodes (project_id,node_key,kind,properties)
      VALUES (${projectId},${id},'document',${sql.json({ documentId: id, title: doc.title })})`;
  }
  const glass = ids.get('glass');
  const percent = ids.get('percent');
  const first = ids.get('timeline-one');
  const second = ids.get('timeline-two');
  if (!glass || !percent || !first || !second) throw new Error('Missing graph fixtures.');
  await sql`INSERT INTO graph_nodes (project_id,node_key,kind,properties)
    VALUES (${projectId},'synthetic-topic','topic','{"name":"合成資料"}'::jsonb)`;
  await sql`INSERT INTO graph_edges (project_id,source_node_key,target_node_key,relation_type)
    VALUES (${projectId},${glass},${percent},'RELATED_TO'),
      (${projectId},${first},${second},'SAME_AS'),
      (${projectId},${glass},'synthetic-topic','MENTIONS'),
      (${projectId},${first},'synthetic-topic','MENTIONS')`;
}
