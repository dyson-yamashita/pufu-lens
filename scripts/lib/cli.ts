export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function validateGraphName(graphName: unknown): string {
  if (
    typeof graphName !== 'string' ||
    !/^graph_[a-z0-9_]+$/.test(graphName) ||
    graphName.length > 63
  ) {
    throw new Error(`Invalid AGE graph name: ${String(graphName)}`);
  }
  return graphName;
}

/** Parsed argv flags and value options returned by {@link parseScriptArgv}. */
export type ParsedScriptArgv<TCommand extends string = string> = {
  readonly command?: TCommand;
  readonly booleanFlags: ReadonlySet<string>;
  readonly valueOptions: ReadonlyMap<string, string>;
};

/** Allowlist configuration for {@link parseScriptArgv}. */
export type ScriptArgvParserConfig<TCommand extends string = string> = {
  /** Optional allowlist for a single positional command token. */
  readonly commands?: readonly TCommand[];
  /** Boolean flags that do not consume a following value. */
  readonly booleanFlags: readonly string[];
  /** Options that require exactly one following value token. */
  readonly valueOptions: readonly string[];
};

/**
 * Parses script CLI argv tokens after the node/script prefix.
 * Rejects unknown options, duplicate flags, missing values, and malformed tokens.
 * Only allowlisted commands, boolean flags, and value options are accepted.
 */
export function parseScriptArgv<TCommand extends string = string>(
  argv: readonly string[],
  config: ScriptArgvParserConfig<TCommand>,
  startIndex = 0,
): ParsedScriptArgv<TCommand> {
  const booleanFlags = new Set<string>();
  const valueOptions = new Map<string, string>();
  const seen = new Set<string>();
  let command: TCommand | undefined;
  let index = startIndex;
  const firstToken = argv[index];
  if (firstToken && !firstToken.startsWith('--')) {
    if (!config.commands) {
      throw new Error(`unsupported argument: ${firstToken}`);
    }
    if (!config.commands.includes(firstToken as TCommand)) {
      throw new Error(`unsupported command: ${firstToken}`);
    }
    command = firstToken as TCommand;
    index += 1;
  }

  for (; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) {
      throw new Error(`unsupported argument: ${key ?? '<empty>'}`);
    }
    if (seen.has(key)) {
      throw new Error(`duplicate argument: ${key}`);
    }
    seen.add(key);

    if (config.booleanFlags.includes(key)) {
      booleanFlags.add(key);
      continue;
    }

    if (config.valueOptions.includes(key)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`missing value for ${key}`);
      }
      valueOptions.set(key, value);
      index += 1;
      continue;
    }

    throw new Error(`unsupported argument: ${key}`);
  }

  return { command, booleanFlags, valueOptions };
}
