import postgres from 'postgres';
import {
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from '../packages/ingestion/dist/index.js';
import { requiredEnv } from './lib/cli.ts';

type Options = {
  readonly limit: number;
  readonly model: string;
  readonly project: string;
  readonly query: string;
};

type MutableOptions = { -readonly [Key in keyof Options]?: Options[Key] };

/**
 * Measures project-scoped pgvector distance distribution for one representative chat query.
 *
 * The output contains aggregate values only, so it can be shared when tuning model-specific
 * retrieval thresholds without exposing document content or metadata.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = createGeminiEmbeddingProvider({
    apiKey: requiredEnv('GEMINI_API_KEY'),
    dimensions: 1536,
    model: options.model,
  });
  const [embedding] = await provider.embedTexts([options.query]);
  if (embedding?.length !== 1536) {
    throw new Error('Expected a 1536-dimensional Gemini query embedding.');
  }

  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  try {
    const vector = `[${embedding.join(',')}]`;
    const rows = (await sql`
      WITH document_distances AS (
        SELECT DISTINCT ON (dc.document_id)
          dc.document_id,
          dc.embedding <=> ${vector}::vector AS distance
        FROM public.document_chunks dc
        JOIN public.projects p ON p.id = dc.project_id
        WHERE p.slug = ${options.project}
          AND dc.embedding_model = ${options.model}
          AND dc.embedding IS NOT NULL
        ORDER BY dc.document_id, dc.embedding <=> ${vector}::vector, dc.id
      ),
      ranked_distances AS (
        SELECT distance
        FROM document_distances
        ORDER BY distance ASC
        LIMIT ${options.limit}
      )
      SELECT
        count(*)::int AS document_count,
        min(distance) AS min_distance,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY distance) AS p25_distance,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY distance) AS p50_distance,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY distance) AS p75_distance,
        max(distance) AS max_distance
      FROM ranked_distances
    `) as readonly unknown[];
    console.log(
      JSON.stringify(
        {
          embeddingModel: options.model,
          limit: options.limit,
          projectSlug: options.project,
          queryLength: Array.from(options.query).length,
          summary: rows[0] ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

function parseArgs(argv: readonly string[]): Options {
  const values: MutableOptions = { limit: 100, model: process.env.GEMINI_EMBEDDING_MODEL };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project') values.project = readOptionValue(argv, ++index, argument);
    else if (argument === '--query') values.query = readOptionValue(argv, ++index, argument);
    else if (argument === '--model') values.model = readOptionValue(argv, ++index, argument);
    else if (argument === '--limit')
      values.limit = readPositiveInteger(readOptionValue(argv, ++index, argument));
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!values.project || !values.query) {
    throw new Error('--project and --query are required.');
  }
  return {
    limit: values.limit ?? 100,
    model: values.model ?? DEFAULT_GEMINI_EMBEDDING_MODEL,
    project: values.project,
    query: values.query,
  };
}

function readOptionValue(argv: readonly string[], index: number, optionName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${optionName} requires a value.`);
  return value;
}

function readPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --limit value: ${value}`);
  return parsed;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
