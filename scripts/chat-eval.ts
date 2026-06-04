import { readFile } from 'node:fs/promises';

interface ChatEvalFixture {
  readonly baseUrl?: string;
  readonly cases: readonly ChatEvalCase[];
  readonly project: string;
}

interface ChatEvalCase {
  readonly expectStatus: string;
  readonly minSources: number;
  readonly question: string;
  readonly requiredToolCalls: readonly string[];
}

interface ChatEvalResponse {
  readonly sources?: readonly unknown[];
  readonly status?: string;
  readonly toolCalls?: ReadonlyArray<{ readonly name?: string }>;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(await readFile(options.fixture, 'utf8')) as ChatEvalFixture;
  const project = options.project ?? fixture.project;
  const baseUrl = options.baseUrl ?? fixture.baseUrl ?? 'http://localhost:3000';
  const results = [];

  for (const testCase of fixture.cases) {
    const response = await fetch(`${baseUrl}/api/projects/${project}/chat`, {
      body: JSON.stringify({ question: testCase.question }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = (await response.json()) as ChatEvalResponse;
    assertCase(testCase, body);
    results.push({
      question: testCase.question,
      sourceCount: body.sources?.length ?? 0,
      status: body.status,
      toolCalls: body.toolCalls?.map((toolCall) => toolCall.name) ?? [],
    });
  }

  console.log(JSON.stringify({ project, results }, null, 2));
}

function assertCase(testCase: ChatEvalCase, response: ChatEvalResponse): void {
  if (response.status !== testCase.expectStatus) {
    throw new Error(
      `Expected status ${testCase.expectStatus} for "${testCase.question}", got ${String(
        response.status,
      )}.`,
    );
  }
  const sourceCount = response.sources?.length ?? 0;
  if (sourceCount < testCase.minSources) {
    throw new Error(
      `Expected at least ${testCase.minSources} sources for "${testCase.question}", got ${sourceCount}.`,
    );
  }
  const toolCallNames = new Set(response.toolCalls?.map((toolCall) => toolCall.name) ?? []);
  for (const requiredToolCall of testCase.requiredToolCalls) {
    if (!toolCallNames.has(requiredToolCall)) {
      throw new Error(`Missing required tool call ${requiredToolCall} for "${testCase.question}".`);
    }
  }
}

function parseArgs(argv: readonly string[]): {
  readonly baseUrl?: string;
  readonly fixture: string;
  readonly project?: string;
} {
  const options: { baseUrl?: string; fixture?: string; project?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') {
      options.fixture = readOptionValue(argv, ++index, arg);
    } else if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--base-url') {
      options.baseUrl = readOptionValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return {
    baseUrl: options.baseUrl,
    fixture: options.fixture ?? 'fixtures/chat/private-chat-eval.json',
    project: options.project,
  };
}

function readOptionValue(argv: readonly string[], index: number, optionName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
