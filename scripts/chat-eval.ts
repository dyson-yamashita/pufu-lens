import { readFile } from 'node:fs/promises';

interface ChatEvalFixture {
  readonly baseUrl?: string;
  readonly cases: readonly ChatEvalCase[];
  readonly project: string;
  readonly report?: string;
}

interface ChatEvalCase {
  readonly expectAnswerIncludes?: readonly string[];
  readonly expectErrorIncludes?: string;
  readonly expectForbiddenAnswerIncludes?: readonly string[];
  readonly expectHttpStatus?: number;
  readonly expectStatus: string;
  readonly minSources: number;
  readonly project?: string;
  readonly question: string;
  readonly requestBody?: Record<string, unknown>;
  readonly report?: string;
  readonly requiredToolCalls: readonly string[];
}

interface ChatEvalResponse {
  readonly answer?: string;
  readonly error?: { readonly code?: string; readonly message?: string } | string | null;
  readonly sources?: readonly unknown[];
  readonly status?: string;
  readonly toolCalls?: ReadonlyArray<{ readonly name?: string }>;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(await readFile(options.fixture, 'utf8')) as ChatEvalFixture;
  const project = options.project ?? fixture.project;
  const report = options.report ?? fixture.report;
  const baseUrl = options.baseUrl ?? fixture.baseUrl ?? 'http://localhost:3000';
  if (options.publicMode && !report) {
    throw new Error('--public requires --report or fixture.report.');
  }
  const results = [];

  for (const testCase of fixture.cases) {
    const caseProject = testCase.project ?? project;
    const caseReport = testCase.report ?? report;
    const endpoint =
      options.publicMode && caseReport
        ? `${baseUrl}/api/public/reports/${caseReport}/chat?projectSlug=${encodeURIComponent(
            caseProject,
          )}`
        : `${baseUrl}/api/projects/${caseProject}/chat`;
    const response = await fetch(endpoint, {
      body: JSON.stringify({ ...testCase.requestBody, question: testCase.question }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await readJsonResponse(response);
    assertCase(testCase, response.status, body);
    results.push({
      httpStatus: response.status,
      project: caseProject,
      question: testCase.question,
      report: caseReport ?? null,
      sourceCount: body.sources?.length ?? 0,
      status: body.status ?? errorCode(body) ?? null,
      toolCalls: body.toolCalls?.map((toolCall) => toolCall.name) ?? [],
    });
  }

  console.log(
    JSON.stringify({ mode: options.publicMode ? 'public' : 'private', project, results }, null, 2),
  );
}

async function readJsonResponse(response: Response): Promise<ChatEvalResponse> {
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  if (!isJson) {
    return {};
  }
  try {
    return (await response.json()) as ChatEvalResponse;
  } catch {
    return {};
  }
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
  const answer = response.answer ?? '';
  for (const expected of testCase.expectAnswerIncludes ?? []) {
    if (!answer.includes(expected)) {
      throw new Error(
        `Expected answer including "${expected}" for "${testCase.question}", got "${answer}".`,
      );
    }
  }
  for (const forbidden of testCase.expectForbiddenAnswerIncludes ?? []) {
    if (answer.includes(forbidden)) {
      throw new Error(
        `Expected answer not to include "${forbidden}" for "${testCase.question}", got "${answer}".`,
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
  return response.error && typeof response.error === 'object' ? response.error.code : undefined;
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
  readonly publicMode: boolean;
  readonly report?: string;
} {
  const options: {
    baseUrl?: string;
    fixture?: string;
    project?: string;
    publicMode: boolean;
    report?: string;
  } = { publicMode: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') {
      options.fixture = readOptionValue(argv, ++index, arg);
    } else if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--base-url') {
      options.baseUrl = readOptionValue(argv, ++index, arg);
    } else if (arg === '--public') {
      options.publicMode = true;
    } else if (arg === '--report') {
      options.report = readOptionValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return {
    baseUrl: options.baseUrl,
    fixture:
      options.fixture ??
      (options.publicMode
        ? 'fixtures/chat/public-chat-eval.json'
        : 'fixtures/chat/private-chat-eval.json'),
    project: options.project,
    publicMode: options.publicMode,
    report: options.report,
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
