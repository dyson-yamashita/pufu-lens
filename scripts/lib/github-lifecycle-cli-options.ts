export const DEFAULT_GITHUB_LIFECYCLE_LIMIT = 50;
export const DEFAULT_GITHUB_LIFECYCLE_BATCH_SIZE = 50;
export const DEFAULT_GITHUB_LIFECYCLE_MAX_RUNTIME_SECONDS = 540;
export const MAX_GITHUB_LIFECYCLE_LIMIT = 10_000;
export const MAX_GITHUB_LIFECYCLE_BATCH_SIZE = 100;
export const MAX_GITHUB_LIFECYCLE_MAX_RUNTIME_SECONDS = 3_600;

export type GitHubLifecycleCliMode = 'backfill' | 'reconcile';

export type GitHubLifecycleCliOptions = {
  batchSize: number;
  dataSourceId?: string;
  dryRun: boolean;
  limit: number;
  maxRuntimeSeconds: number;
  mode: GitHubLifecycleCliMode;
  project: string;
  resumeAfter?: string;
};

export function parseGitHubLifecycleCliOptions(argv: string[]): GitHubLifecycleCliOptions {
  const options: {
    batchSize?: number;
    dataSourceId?: string;
    dryRun?: boolean;
    limit?: number;
    maxRuntimeSeconds?: number;
    mode?: GitHubLifecycleCliMode;
    project?: string;
    resumeAfter?: string;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
      continue;
    }
    if (arg === '--data-source-id') {
      options.dataSourceId = readUuid(readOptionValue(argv, ++index, arg), arg);
      continue;
    }
    if (arg === '--limit') {
      options.limit = readBoundedPositiveInt(
        readOptionValue(argv, ++index, arg),
        arg,
        MAX_GITHUB_LIFECYCLE_LIMIT,
      );
      continue;
    }
    if (arg === '--batch-size') {
      options.batchSize = readBoundedPositiveInt(
        readOptionValue(argv, ++index, arg),
        arg,
        MAX_GITHUB_LIFECYCLE_BATCH_SIZE,
      );
      continue;
    }
    if (arg === '--max-runtime-seconds') {
      options.maxRuntimeSeconds = readBoundedPositiveInt(
        readOptionValue(argv, ++index, arg),
        arg,
        MAX_GITHUB_LIFECYCLE_MAX_RUNTIME_SECONDS,
      );
      continue;
    }
    if (arg === '--resume-after') {
      options.resumeAfter = readOptionValue(argv, ++index, arg);
      continue;
    }
    if (arg === '--mode') {
      const mode = readOptionValue(argv, ++index, arg);
      if (mode !== 'backfill' && mode !== 'reconcile') {
        throw new Error('--mode must be reconcile or backfill.');
      }
      options.mode = mode;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.project?.trim()) {
    throw new Error('--project is required.');
  }
  const mode = options.mode ?? 'reconcile';
  return {
    batchSize: options.batchSize ?? DEFAULT_GITHUB_LIFECYCLE_BATCH_SIZE,
    dataSourceId: options.dataSourceId,
    dryRun: options.dryRun ?? false,
    limit:
      options.limit ??
      (mode === 'backfill' ? MAX_GITHUB_LIFECYCLE_LIMIT : DEFAULT_GITHUB_LIFECYCLE_LIMIT),
    maxRuntimeSeconds: options.maxRuntimeSeconds ?? DEFAULT_GITHUB_LIFECYCLE_MAX_RUNTIME_SECONDS,
    mode,
    project: options.project.trim(),
    resumeAfter: options.resumeAfter,
  };
}

export function readBoundedPositiveInt(value: string, optionName: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  if (parsed > max) {
    throw new Error(`${optionName} must be <= ${max}.`);
  }
  return parsed;
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readUuid(value: string, optionName: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${optionName} must be a valid UUID.`);
  }
  return value;
}
