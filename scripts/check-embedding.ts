import {
  checkEmbeddingProvider,
  createDeterministicEmbeddingProvider,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from '../packages/ingestion/dist/index.js';

async function main(): Promise<any> {
  const options = parseArgs(process.argv.slice(2));
  const providerName = options.provider ?? 'deterministic';
  const dimensions = options.dimensions ?? 1536;
  const provider = createEmbeddingProvider({ dimensions, providerName });

  const result = await checkEmbeddingProvider({ dimensions, provider });
  console.log(JSON.stringify(result, null, 2));
}

function createEmbeddingProvider(input: any): any {
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

function parseArgs(argv: any): any {
  const options: any = {};
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

function readOptionValue(argv: any, index: any, optionName: any): any {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readPositiveInteger(value: any, name: any): any {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function requiredEnv(name: any): any {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

main().catch((error: any): any => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
