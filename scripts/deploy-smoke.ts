import { spawn } from 'node:child_process';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.local) {
    await runLocalSmoke();
    return;
  }

  const required = ['MASTRA_SERVER_URL', 'SCHEDULER_SERVICE_ACCOUNT'];
  const missing = required.filter((name) => !process.env[name]);
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        env: options.env,
        missing,
        mode: 'remote_smoke',
        status: missing.length === 0 ? 'ready' : 'blocked',
      },
      null,
      2,
    ),
  );
  if (missing.length > 0) {
    process.exitCode = 1;
  }
}

async function runLocalSmoke(): Promise<void> {
  const child = spawn(process.execPath, [...process.execArgv, 'scripts/deploy-dry-run.ts'], {
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`local deploy smoke failed with exit code ${exitCode ?? '<unknown>'}`);
  }
}

function parseArgs(argv: readonly string[]): { env: 'production' | 'staging'; local: boolean } {
  let env: 'production' | 'staging' | undefined;
  let local = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--local') {
      local = true;
    } else if (arg === '--env') {
      const value = argv[++index];
      if (value !== 'staging' && value !== 'production') {
        throw new Error('--env must be staging or production.');
      }
      env = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { env: env ?? 'staging', local };
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
