import {
  checkEmbeddingProvider,
  createDeterministicEmbeddingProvider,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from '../packages/ingestion/dist/index.js';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const providerName = options.provider ?? 'deterministic';
  const dimensions = options.dimensions ?? 1536;
  const provider = createEmbeddingProvider({ dimensions, providerName });

  const result = await checkEmbeddingProvider({ dimensions, provider });
  console.log(JSON.stringify(result, null, 2));
}

function createEmbeddingProvider(input: { dimensions: number; providerName: string }) {
  if (input.providerName === 'deterministic') {
    return createDeterministicEmbeddingProvider({ dimensions: input.dimensions });
  }
  if (input.providerName === 'gemini') {
    return createGeminiEmbeddingProvider({
      apiKey: requiredEnv('GEMINI_API_KEY'),
      dimensions: input.dimensions,
      model: process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_GEMINI_EMBEDDING_MODEL,
    });
  }
  throw new Error(`Unknown provider: ${input.providerName}`);
}

function parseArgs(argv: string[]): { dimensions?: number; provider?: string } {
  const options: { dimensions?: number; provider?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') {
      options.provider = readOptionValue(argv, ++index, arg);
    } else if (arg === '--dimensions') {
      options.dimensions = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
