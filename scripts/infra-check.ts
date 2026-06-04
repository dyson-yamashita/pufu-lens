const REQUIRED_BY_ENV = {
  production: [
    'GCP_PROJECT',
    'GCP_REGION',
    'ARTIFACT_REGISTRY_REPOSITORY',
    'STORAGE_BUCKET',
    'MASTRA_SERVER_URL',
    'MASTRA_RUNTIME_SERVICE_ACCOUNT',
    'SCHEDULER_SERVICE_ACCOUNT',
    'VPC_CONNECTOR',
    'DATABASE_URL_SECRET',
  ],
  staging: [
    'GCP_PROJECT',
    'GCP_REGION',
    'ARTIFACT_REGISTRY_REPOSITORY',
    'STORAGE_BUCKET',
    'MASTRA_SERVER_URL',
    'MASTRA_RUNTIME_SERVICE_ACCOUNT',
    'SCHEDULER_SERVICE_ACCOUNT',
    'VPC_CONNECTOR',
    'DATABASE_URL_SECRET',
  ],
} as const;

type DeployEnv = keyof typeof REQUIRED_BY_ENV;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const required = REQUIRED_BY_ENV[options.env];
  const missing = required.filter((name) => !process.env[name]);
  const gemini = checkGeminiAuth();
  const status = missing.length === 0 && gemini.status === 'passed' ? 'passed' : 'blocked';

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        env: options.env,
        gemini,
        missing,
        required,
        status,
      },
      null,
      2,
    ),
  );

  if (status !== 'passed' && !options.allowMissing) {
    process.exitCode = 1;
  }
}

function checkGeminiAuth():
  | { mode: 'google-ai'; required: string[]; status: 'blocked' | 'passed' }
  | { mode: 'vertex-ai'; required: string[]; status: 'blocked' | 'passed' } {
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
    const required = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'];
    return {
      mode: 'vertex-ai',
      required,
      status: required.every((name) => process.env[name]) ? 'passed' : 'blocked',
    };
  }
  const required = ['GEMINI_API_KEY_SECRET', 'GEMINI_CHAT_MODEL', 'GEMINI_EMBEDDING_MODEL'];
  return {
    mode: 'google-ai',
    required,
    status: required.every((name) => process.env[name]) ? 'passed' : 'blocked',
  };
}

function parseArgs(argv: readonly string[]): { allowMissing: boolean; env: DeployEnv } {
  let allowMissing = false;
  let env: DeployEnv | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-missing') {
      allowMissing = true;
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
  if (!env) {
    throw new Error('--env is required.');
  }
  return { allowMissing, env };
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
