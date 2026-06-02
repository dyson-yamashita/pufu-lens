import { spawn } from 'node:child_process';
import {
  buildCreateProjectSql,
  type CreateProjectInput,
  deriveProjectIdentifiers,
} from '../packages/project-tenancy/src/project-tenancy.ts';
import { LocalFsObjectStorage } from '../packages/storage/src/local-fs.ts';

interface CliOptions {
  description?: string;
  name?: string;
  seedSamples: boolean;
  slug?: string;
}

const SAMPLE_PROJECTS: CreateProjectInput[] = [
  {
    description: 'Step 2 tenant separation smoke test project A',
    name: 'Sample A',
    slug: 'sample-a',
  },
  {
    description: 'Step 2 tenant separation smoke test project B',
    name: 'Sample B',
    slug: 'sample-b',
  },
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projects = options.seedSamples
    ? SAMPLE_PROJECTS
    : [
        {
          description: options.description,
          name: requiredOption(options.name, '--name'),
          slug: requiredOption(options.slug, '--slug'),
        },
      ];
  const projectPlans = projects.map((project: any): any => ({
    identifiers: deriveProjectIdentifiers(project.slug),
    project,
  }));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const storage = createLocalObjectStorageFromEnv();

  for (const { identifiers, project } of projectPlans) {
    await runPsql(databaseUrl, buildCreateProjectSql(project));
    const prefixes = await storage.ensureProjectPrefixes(project.slug);

    console.log(
      JSON.stringify({
        graphName: identifiers.graphName,
        projectSlug: project.slug,
        storagePrefix: identifiers.storagePrefix,
        storagePrefixes: prefixes,
      }),
    );
  }
}

function createLocalObjectStorageFromEnv(env: any = process.env): LocalFsObjectStorage {
  const driver = env.STORAGE_DRIVER ?? env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (driver !== 'local') {
    throw new Error(`Unsupported object storage driver for create-project CLI: ${driver}`);
  }

  const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required for local object storage.');
  }

  return new LocalFsObjectStorage(root);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    seedSamples: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--seed-samples') {
      options.seedSamples = true;
      continue;
    }

    if (arg === '--slug') {
      index += 1;
      options.slug = readOptionValue(args, index, arg);
      continue;
    }

    if (arg === '--name') {
      index += 1;
      options.name = readOptionValue(args, index, arg);
      continue;
    }

    if (arg === '--description') {
      index += 1;
      options.description = readOptionValue(args, index, arg);
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.seedSamples && (options.slug || options.name || options.description)) {
    throw new Error('--seed-samples cannot be combined with --slug, --name, or --description.');
  }

  return options;
}

function readOptionValue(args: string[], index: number, optionName: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
}

function requiredOption(value: string | undefined, optionName: string): string {
  if (!value) {
    throw new Error(`${optionName} is required unless --seed-samples is used.`);
  }

  return value;
}

async function runPsql(databaseUrl: string, sql: string): Promise<void> {
  await new Promise<void>((resolve: any, reject: any): any => {
    const env = {
      ...process.env,
      ...databaseUrlToPsqlEnv(databaseUrl),
    };
    delete env.DATABASE_URL;

    const child = spawn('psql', ['--set=ON_ERROR_STOP=1', '--quiet'], {
      env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.stdin.on('error', (): any => {});
    child.stdin.end(sql);
    child.on('error', reject);
    child.on('close', (code: any): any => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`psql exited with code ${code}`));
    });
  });
}

function databaseUrlToPsqlEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://.');
  }

  const database = url.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('DATABASE_URL must include a database name.');
  }

  const env: NodeJS.ProcessEnv = {
    PGDATABASE: decodeURIComponent(database),
  };

  if (url.hostname) {
    env.PGHOST = url.hostname;
  }

  if (url.port) {
    env.PGPORT = url.port;
  }

  if (url.username) {
    env.PGUSER = decodeURIComponent(url.username);
  }

  if (url.password) {
    env.PGPASSWORD = decodeURIComponent(url.password);
  }

  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) {
    env.PGSSLMODE = sslMode;
  }

  return env;
}

main().catch((error: unknown): any => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
