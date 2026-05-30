import { spawn } from 'node:child_process';
import {
  buildCreateProjectSql,
  type CreateProjectInput,
  deriveProjectIdentifiers,
} from '../packages/project-tenancy/src/index.ts';
import { createObjectStorageFromEnv } from '../packages/storage/src/factory.ts';

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
  const projectPlans = projects.map((project) => ({
    identifiers: deriveProjectIdentifiers(project.slug),
    project,
  }));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const storage = createObjectStorageFromEnv();

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
  await new Promise<void>((resolve, reject) => {
    const child = spawn('psql', [databaseUrl, '--set=ON_ERROR_STOP=1', '--quiet'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.stdin.end(sql);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`psql exited with code ${code}`));
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
