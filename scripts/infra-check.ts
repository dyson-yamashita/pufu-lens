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
type Profile = 'deploy' | 'collect-drive' | 'collect-gmail' | 'collect-github' | 'workflow-job';

const PROFILE_REQUIREMENTS = {
  'collect-drive': ['DATABASE_URL', 'GOOGLE_DRIVE_ACCESS_TOKEN'],
  'collect-gmail': ['DATABASE_URL', 'GMAIL_ACCESS_TOKEN'],
  'collect-github': ['DATABASE_URL', 'GITHUB_TOKEN'],
  'workflow-job': ['DATABASE_URL', 'WORKFLOW_ID'],
} as const satisfies Record<Exclude<Profile, 'deploy'>, readonly string[]>;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const required = REQUIRED_BY_ENV[options.env];
  const profileRequired = profileRequirements(options.profile);
  const allRequired = [...required, ...profileRequired];
  const missing = missingEnv(allRequired);
  const gemini = checkGeminiAuth();
  const status = missing.length === 0 && gemini.status === 'passed' ? 'passed' : 'blocked';

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        env: options.env,
        gemini,
        missing,
        profile: options.profile,
        profileRequired,
        required: allRequired,
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
      status: missingEnv(required).length === 0 ? 'passed' : 'blocked',
    };
  }
  const required = ['GEMINI_API_KEY_SECRET', 'GEMINI_CHAT_MODEL', 'GEMINI_EMBEDDING_MODEL'];
  return {
    mode: 'google-ai',
    required,
    status: missingEnv(required).length === 0 ? 'passed' : 'blocked',
  };
}

function missingEnv(required: readonly string[]): string[] {
  return [...new Set(required)].filter((name) => !process.env[name]);
}

function profileRequirements(profile: Profile): readonly string[] {
  if (profile === 'deploy') {
    return [];
  }
  return PROFILE_REQUIREMENTS[profile];
}

function parseArgs(argv: readonly string[]): {
  allowMissing: boolean;
  env: DeployEnv;
  profile: Profile;
} {
  let allowMissing = false;
  let env: DeployEnv | undefined;
  let profile: Profile = 'deploy';
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
    } else if (arg === '--profile') {
      const value = argv[++index];
      if (!isProfile(value)) {
        throw new Error(
          '--profile must be deploy, collect-drive, collect-gmail, collect-github, or workflow-job.',
        );
      }
      profile = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!env) {
    throw new Error('--env is required.');
  }
  return { allowMissing, env, profile };
}

function isProfile(value: string | undefined): value is Profile {
  return (
    value === 'deploy' ||
    value === 'collect-drive' ||
    value === 'collect-gmail' ||
    value === 'collect-github' ||
    value === 'workflow-job'
  );
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
