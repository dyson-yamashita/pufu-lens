import { readFile } from 'node:fs/promises';

interface ChatEvalFixture {
  readonly baseUrl?: string;
  readonly cases: readonly ChatEvalCase[];
  readonly project: string;
}

interface ChatEvalCase {
  readonly expectErrorIncludes?: string;
  readonly expectHttpStatus?: number;
  readonly expectStatus: string;
  readonly minSources: number;
  readonly project?: string;
  readonly question: string;
  readonly requiredToolCalls: readonly string[];
}

interface ChatEvalResponse {
  readonly error?: { readonly code?: string; readonly message?: string } | string;
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
    const caseProject = testCase.project ?? project;
    const response = await fetch(`${baseUrl}/api/projects/${caseProject}/chat`, {
      body: JSON.stringify({ question: testCase.question }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = (await response.json()) as ChatEvalResponse;
    assertCase(testCase, response.status, body);
    results.push({
      httpStatus: response.status,
      project: caseProject,
      question: testCase.question,
      sourceCount: body.sources?.length ?? 0,
      status: body.status ?? errorCode(body),
      toolCalls: body.toolCalls?.map((toolCall) => toolCall.name) ?? [],
    });
  }

  console.log(JSON.stringify({ project, results }, null, 2));
}

function assertCase(testCase: ChatEvalCase, httpStatus: number, response: ChatEvalResponse): void {
  const expectedHttpStatus = testCase.expectHttpStatus ?? 200;
  if (httpStatus !== expectedHttpStatus) {
    throw new Error(
      `Expected HTTP ${expectedHttpStatus} for "${testCase.question}", got ${httpStatus}.`,
    );
  }
  const status = response.status ?? errorCode(response);
  if (status !== testCase.expectStatus) {
    throw new Error(
      `Expected status ${testCase.expectStatus} for "${testCase.question}", got ${String(status)}.`,
    );
  }
  if (testCase.expectErrorIncludes) {
    const message = errorMessage(response);
    if (!message.includes(testCase.expectErrorIncludes)) {
      throw new Error(
        `Expected error including "${testCase.expectErrorIncludes}" for "${testCase.question}", got "${message}".`,
      );
    }
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

function errorCode(response: ChatEvalResponse): string | undefined {
  return typeof response.error === 'object' ? response.error.code : undefined;
}

function errorMessage(response: ChatEvalResponse): string {
  if (typeof response.error === 'string') {
    return response.error;
  }
  if (typeof response.error?.message === 'string') {
    return response.error.message;
  }
  return '';
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
