import { randomUUID } from 'node:crypto';
import type { CandidateRepositories } from '@pufu-lens/retrieval';
import postgres from 'postgres';
import {
  createPostgresKeywordCandidateRepository,
  createPostgresSemanticCandidateRepository,
} from '../../apps/web/src/postgres-chat-candidate-adapters.ts';
import { validateKeywordEvalUrl } from './keyword-eval-local.ts';
import { collectSyntheticRetrieval, parityRetrievalDocuments } from './parity-retrieval.ts';

/** Runs the existing pgvector/PGroonga adapters in a newly created loopback-only DB.
 * Uses text fixture IDs at the SQL boundary; no production tables or credentials are consulted.
 * Requires installed vector/PGroonga extensions and CREATEDB; only its own created DB is dropped.
 */
export async function collectPostgresSyntheticRetrieval(databaseUrl: string) {
  return withPostgresParityCandidates(databaseUrl, collectSyntheticRetrieval);
}

/** Runs a bounded local collector against the shared disposable fixture; always drops its own DB. */
export async function withPostgresParityCandidates<T>(
  databaseUrl: string,
  collect: (repositories: CandidateRepositories) => Promise<T>,
): Promise<T> {
  validateKeywordEvalUrl(databaseUrl);
  const admin = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const name = `parity_retrieval_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let sql: postgres.Sql | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    sql = postgres(url.toString(), {
      max: 1,
      connect_timeout: 10,
      onnotice: () => {},
      connection: { statement_timeout: 10000 },
    });
    await sql`CREATE EXTENSION vector`;
    await sql`CREATE EXTENSION pgroonga`;
    await sql`CREATE TABLE public.documents (id text PRIMARY KEY, project_id text NOT NULL,
      raw_document_id text NOT NULL, doc_type text NOT NULL, title text, canonical_uri text, summary text)`;
    await sql`CREATE TABLE public.document_chunks (id text PRIMARY KEY, document_id text REFERENCES documents(id),
      project_id text NOT NULL, chunk_index integer NOT NULL, content text, embedding_model text, embedding vector(1536))`;
    for (const document of parityRetrievalDocuments()) {
      const candidate = document.chunks[0]?.candidate;
      if (!candidate) throw new Error('Empty parity document');
      await sql`INSERT INTO public.documents VALUES (${document.documentId}, ${document.projectId},
        ${candidate.rawDocumentId}, ${candidate.docType}, ${candidate.title}, ${candidate.canonicalUri}, NULL)`;
      for (const chunk of document.chunks) {
        await sql`INSERT INTO public.document_chunks VALUES (${chunk.candidate.chunkId}, ${document.documentId},
          ${document.projectId}, ${chunk.candidate.chunkIndex}, ${chunk.candidate.snippet},
          ${document.model}, ${JSON.stringify(chunk.values)}::vector)`;
      }
    }
    await sql`CREATE INDEX ON public.document_chunks USING pgroonga(content)`;
    await sql`ANALYZE public.document_chunks`;
    await sql`SET enable_seqscan = off`;
    return await collect({
      semanticCandidateRepository: createPostgresSemanticCandidateRepository(sql),
      keywordCandidateRepository: createPostgresKeywordCandidateRepository(sql),
    });
  } finally {
    try {
      if (sql) await sql.end();
      if (created) await admin.unsafe(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }
}
