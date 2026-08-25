import { parseScriptArgv } from './cli.ts';

export const GRAPH_MIGRATION_COMMANDS = ['rebuild', 'compare'] as const;
export type GraphMigrationCommand = (typeof GRAPH_MIGRATION_COMMANDS)[number];

export const DEFAULT_GRAPH_REBUILD_LIMIT = 100;
export const MAX_GRAPH_REBUILD_LIMIT = 10_000;
export const DEFAULT_GRAPH_COMPARE_LIMIT = 50_000;
export const MAX_GRAPH_COMPARE_LIMIT = 100_000;

const RESUME_CURSOR_PATTERN = /^[0-9a-f]{64}$/;

export type GraphMigrationRebuildCliOptions = {
  readonly command: 'rebuild';
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly limit: number;
  readonly project: string;
  readonly resumeCursor?: string;
};

export type GraphMigrationCompareCliOptions = {
  readonly command: 'compare';
  readonly limit: number;
  readonly project: string;
};

export type GraphMigrationCliOptions =
  | GraphMigrationRebuildCliOptions
  | GraphMigrationCompareCliOptions;

/** argv validation failure raised before graph migration side effects run. */
export class GraphMigrationCliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphMigrationCliValidationError';
  }
}

/**
 * Parses argv for `graph-migration` without executing side effects.
 * Accepts `rebuild` and `compare` commands with project-scoped bounded limits.
 */
export function parseGraphMigrationCliOptions(argv: string[]): GraphMigrationCliOptions {
  try {
    return parseGraphMigrationCliOptionsCore(argv);
  } catch (error) {
    if (error instanceof GraphMigrationCliValidationError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new GraphMigrationCliValidationError(error.message);
    }
    throw new GraphMigrationCliValidationError('graph-migration argv validation failed.');
  }
}

function parseGraphMigrationCliOptionsCore(argv: string[]): GraphMigrationCliOptions {
  const parsed = parseScriptArgv(argv, {
    booleanFlags: ['--dry-run', '--execute'],
    commands: GRAPH_MIGRATION_COMMANDS,
    valueOptions: ['--project', '--limit', '--resume-cursor'],
  });
  const command = parsed.command;
  if (!command) {
    throwCliValidationError('graph-migration requires a command: rebuild or compare.');
  }
  const project = parsed.valueOptions.get('--project')?.trim();
  if (!project) {
    throwCliValidationError('--project is required.');
  }

  if (command === 'compare') {
    if (parsed.booleanFlags.has('--dry-run') || parsed.booleanFlags.has('--execute')) {
      throwCliValidationError('compare does not accept --dry-run or --execute.');
    }
    if (parsed.valueOptions.has('--resume-cursor')) {
      throwCliValidationError('compare does not accept --resume-cursor.');
    }
    return {
      command,
      limit: readBoundedPositiveInt(
        parsed.valueOptions.get('--limit'),
        '--limit',
        DEFAULT_GRAPH_COMPARE_LIMIT,
        MAX_GRAPH_COMPARE_LIMIT,
      ),
      project,
    };
  }

  const dryRun = parsed.booleanFlags.has('--dry-run');
  const execute = parsed.booleanFlags.has('--execute');
  if (dryRun === execute) {
    throwCliValidationError('rebuild requires exactly one of --dry-run or --execute.');
  }
  const resumeCursor = parsed.valueOptions.get('--resume-cursor');
  if (resumeCursor !== undefined && !RESUME_CURSOR_PATTERN.test(resumeCursor)) {
    throwCliValidationError('--resume-cursor must be a 64-character lowercase hex digest.');
  }
  return {
    command,
    dryRun,
    execute,
    limit: readBoundedPositiveInt(
      parsed.valueOptions.get('--limit'),
      '--limit',
      DEFAULT_GRAPH_REBUILD_LIMIT,
      MAX_GRAPH_REBUILD_LIMIT,
    ),
    project,
    resumeCursor,
  };
}

function readBoundedPositiveInt(
  value: string | undefined,
  optionName: string,
  defaultValue: number,
  max: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throwCliValidationError(`${optionName} must be a positive integer.`);
  }
  if (parsed > max) {
    throwCliValidationError(`${optionName} must be <= ${max}.`);
  }
  return parsed;
}

function throwCliValidationError(message: string): never {
  throw new GraphMigrationCliValidationError(message);
}
