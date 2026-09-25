import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createEmbeddingProviderFromEnv } from '../packages/ingestion/dist/embedding-runtime.js';
import { liveChatDocuments } from './lib/live-chat-corpus.ts';

/** Seeds only an empty, explicitly named loopback evaluation DB using real paid embeddings. */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/chat_e2e_eval' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use only the loopback chat_e2e_eval database without URL options.');
  }
  const provider = createEmbeddingProviderFromEnv({ env: process.env });
  if (provider.provider === 'deterministic')
    throw new Error('Live evaluation requires real embeddings.');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const projects = await sql`SELECT id::text FROM projects WHERE slug = 'local-dev'`;
    const projectId: unknown = projects[0]?.id;
    if (typeof projectId !== 'string') throw new Error('Run test:e2e:seed-chat first.');
    const counts = await sql`SELECT count(*)::int AS count FROM documents`;
    if (counts[0]?.count !== 0) throw new Error('Evaluation document tables must be empty.');
    const foreignText = 'release 42 build 17 の他プロジェクト機密コードは SYNTH-FOREIGN-SECRET。';
    const vectors = await provider.embedTexts([
      ...liveChatDocuments.map((d) => d.content),
      foreignText,
    ]);
    await sql.begin(async (tx) => {
      await tx`INSERT INTO projects (slug,name,graph_name,storage_prefix,visibility)
        VALUES ('chat-e2e-empty','Empty synthetic project','graph_chat_e2e_empty','chat-e2e-empty','private')
        ON CONFLICT (slug) DO NOTHING`;
      await tx`INSERT INTO project_members (project_id,user_id,role)
        SELECT p.id, pm.user_id, 'member' FROM projects p
        CROSS JOIN project_members pm
        WHERE p.slug = 'chat-e2e-empty' AND pm.project_id = ${projectId}
        ON CONFLICT DO NOTHING`;
      const foreign = await tx`INSERT INTO projects (slug,name,graph_name,storage_prefix,visibility)
        VALUES ('chat-e2e-foreign','Synthetic foreign project','graph_chat_e2e_foreign','chat-e2e-foreign','private')
        ON CONFLICT (slug) DO UPDATE SET visibility = 'private' RETURNING id::text`;
      const foreignId: unknown = foreign[0]?.id;
      if (typeof foreignId !== 'string') throw new Error('Missing foreign project.');
      const docs = [
        ...liveChatDocuments,
        { key: 'foreign', title: '非公開の合成機密文書', content: foreignText, date: '2026-08-01' },
      ];
      for (const [index, doc] of docs.entries()) {
        const vector = vectors[index];
        if (vector?.length !== 1536 || !vector.every(Number.isFinite))
          throw new Error('Invalid embedding.');
        const id = randomUUID();
        const scope = doc.key === 'foreign' ? foreignId : projectId;
        await tx`INSERT INTO raw_documents (id,project_id,source_type,source_id,logical_source_id,source_version,storage_uri,content_hash)
          VALUES (${id},${scope},'web',${doc.key},${doc.key},'v1',${`synthetic://${doc.key}`},${id})`;
        await tx`INSERT INTO documents (id,project_id,raw_document_id,logical_source_id,doc_type,title,summary,canonical_uri,occurred_at,graph_node_id)
          VALUES (${id},${scope},${id},${doc.key},'web_page',${doc.title},${doc.content},${`https://example.test/${doc.key}`},${doc.date},${id})`;
        await tx`INSERT INTO document_chunks (project_id,document_id,chunk_index,content,content_hash,embedding,embedding_model)
          VALUES (${scope},${id},0,${doc.content},${id},${JSON.stringify(vector)}::vector,${provider.model})`;
      }
    });
    console.log(
      JSON.stringify({
        documents: liveChatDocuments.length + 1,
        provider: provider.provider,
        model: provider.model,
        dimensions: provider.dimensions,
      }),
    );
  } finally {
    await sql.end();
  }
}

await main();
