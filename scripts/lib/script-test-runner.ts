import { spawn } from 'node:child_process';

export type ScriptRunResult = {
  exitCode: number | null;
  events: Array<Record<string, unknown>>;
  stderr: string;
};

export async function runJsonLineScript(input: {
  args?: readonly string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  scriptPath: string;
}): Promise<ScriptRunResult> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', input.scriptPath, ...(input.args ?? [])],
    {
      cwd: input.cwd,
      env: scriptEnv(input.env ?? {}),
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  return {
    exitCode,
    events: parseJsonLines(stdout),
    stderr,
  };
}

function scriptEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
