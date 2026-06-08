import postgres from 'postgres';
import { createPostgresPasswordCredentialRepository } from '../apps/web/src/password-auth.ts';

const defaultDatabaseUrl = 'postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL?.trim() ?? defaultDatabaseUrl;
  const email = args.email ?? process.env.AUTH_CREDENTIALS_EMAIL?.trim();
  const password = args.password ?? process.env.AUTH_CREDENTIALS_PASSWORD?.trim();
  const name = args.name ?? process.env.AUTH_CREDENTIALS_NAME?.trim() ?? null;

  if (!email || !password) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (password.length < 12) {
    throw new Error('AUTH_CREDENTIALS_PASSWORD must be at least 12 characters.');
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const userId = await createPostgresPasswordCredentialRepository(
      sql,
    ).createOrUpdatePasswordCredential({ email, name, password });
    console.log(`credentials user ready: ${userId}`);
  } finally {
    await sql.end();
  }
}

function parseArgs(args: readonly string[]): {
  readonly databaseUrl?: string;
  readonly email?: string;
  readonly name?: string;
  readonly password?: string;
} {
  const parsed: { databaseUrl?: string; email?: string; name?: string; password?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--database-url' && next) {
      parsed.databaseUrl = next;
      index += 1;
    } else if (arg === '--email' && next) {
      parsed.email = next;
      index += 1;
    } else if (arg === '--name' && next) {
      parsed.name = next;
      index += 1;
    } else if (arg === '--password' && next) {
      parsed.password = next;
      index += 1;
    }
  }
  return parsed;
}

function printUsage(): void {
  console.error(`Usage:
  pnpm auth:create-user -- --email user@example.com --password 'at-least-12-chars' --name 'User Name'

Environment variables are also supported:
  AUTH_CREDENTIALS_EMAIL=user@example.com AUTH_CREDENTIALS_PASSWORD='at-least-12-chars' pnpm auth:create-user

DATABASE_URL defaults to ${defaultDatabaseUrl}`);
}

await main();
