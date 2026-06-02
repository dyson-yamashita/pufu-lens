import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import postgres from 'postgres';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

interface Args {
  dryRun: boolean;
  limit: number;
  project?: string;
  rawDocumentId?: string;
  source?: string;
}

const args = parseArgs(process.argv.slice(2));
const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
const storage = createLocalObjectStorageFromEnv();

try {
  const failedRawDocuments = await findFailedRawDocuments(args);
  const outputDir = join(process.cwd(), 'fixtures/ingestion/regression');

  if (!args.dryRun) {
    await mkdir(outputDir, { recursive: true });
  }

  for (const rawDocument of failedRawDocuments) {
    const raw = await storage.getText(rawDocument.storageUri);
    const sanitized = sanitizeRaw(raw);
    const outputName = `${rawDocument.sourceType}-${rawDocument.id}.fixture`;
    const outputPath = join(outputDir, basename(outputName));

    if (args.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            outputPath,
            rawDocumentId: rawDocument.id,
            sourceType: rawDocument.sourceType,
          },
          null,
          2,
        ),
      );
      continue;
    }

    await writeFile(outputPath, sanitized.endsWith('\n') ? sanitized : `${sanitized}\n`);
    await sql`
      UPDATE public.raw_documents
      SET sanitized_sample_uri = ${outputPath}
      WHERE id = ${rawDocument.id}
    `;
    await sql`
      UPDATE public.ingestion_queue
      SET sanitized_sample_uri = ${outputPath}
      WHERE raw_document_id = ${rawDocument.id}
    `;
    console.log(`Wrote ${outputPath}`);
  }
} finally {
  await sql.end();
}

async function findFailedRawDocuments(
  args: Args,
): Promise<Array<{ id: string; sourceType: string; storageUri: string }>> {
  if (args.rawDocumentId) {
    return sql`
      SELECT
        rd.id::text AS id,
        rd.source_type AS "sourceType",
        rd.storage_uri AS "storageUri"
      FROM public.raw_documents rd
      WHERE rd.id = ${args.rawDocumentId}
        AND rd.ingest_status = 'failed'
    `;
  }

  if (!args.project) {
    throw new Error('--project is required when --raw-document-id is not provided.');
  }

  return sql`
    SELECT
      rd.id::text AS id,
      rd.source_type AS "sourceType",
      rd.storage_uri AS "storageUri"
    FROM public.raw_documents rd
    JOIN public.projects p ON p.id = rd.project_id
    WHERE p.slug = ${args.project}
      AND rd.ingest_status = 'failed'
      AND (${args.source ?? null}::text IS NULL OR rd.source_type = ${args.source ?? null})
    ORDER BY rd.updated_at DESC
    LIMIT ${args.limit}
  `;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, limit: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--raw-document-id') {
      args.rawDocumentId = readOptionValue(argv[++index], arg);
    } else if (arg === '--project') {
      args.project = readOptionValue(argv[++index], arg);
    } else if (arg === '--source') {
      args.source = readSourceType(argv[++index], arg);
    } else if (arg === '--limit') {
      args.limit = Number(readOptionValue(argv[++index], arg));
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function readOptionValue(value: string | undefined, optionName: string): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readSourceType(value: string | undefined, optionName: string): string {
  const sourceType = readOptionValue(value, optionName);
  if (!['github', 'web', 'gmail', 'drive'].includes(sourceType)) {
    throw new Error(`Unsupported ${optionName} value: ${sourceType}`);
  }
  return sourceType;
}

function createLocalObjectStorageFromEnv(env: any = process.env): LocalFsObjectStorage {
  const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required.');
  }
  return new LocalFsObjectStorage(root);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function sanitizeRaw(raw: string): string {
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email: any): any => {
      const local = email.split('@')[0] ?? 'sample';
      return `${local.replace(/[^a-z0-9._+-]/gi, 'sample')}@example.test`;
    })
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url: any): any => sanitizeUrl(url))
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, 'ghp_example_redacted')
    .replace(/ya29\.[A-Za-z0-9_-]+/g, 'ya29.example-redacted')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer example-redacted')
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token": "example-redacted"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token": "example-redacted"')
    .replace(/"password"\s*:\s*"[^"]+"/gi, '"password": "example-redacted"')
    .replace(/"client_secret"\s*:\s*"[^"]+"/gi, '"client_secret": "example-redacted"')
    .replace(/"api_key"\s*:\s*"[^"]+"/gi, '"api_key": "example-redacted"')
    .replace(/"secret"\s*:\s*"[^"]+"/gi, '"secret": "example-redacted"');
}

function sanitizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'https://example.test/redacted';
  }

  url.username = '';
  url.password = '';

  if (url.hostname === 'example.test') {
    return redactSensitiveQueryParams(url).toString();
  }

  if (url.hostname === 'github.com') {
    return redactSensitiveQueryParams(url).toString();
  }

  return 'https://example.test/redacted';
}

function redactSensitiveQueryParams(url: URL): URL {
  const sanitized = new URL(url.toString());
  for (const key of sanitized.searchParams.keys()) {
    if (/token|secret|password|key|code/i.test(key)) {
      sanitized.searchParams.set(key, 'example-redacted');
    }
  }
  return sanitized;
}
