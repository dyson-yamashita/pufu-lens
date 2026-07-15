import { expect, test } from '@playwright/test';

const memberGraphCredentials = {
  email: process.env.PUFU_LENS_E2E_CHAT_EMAIL,
  password: process.env.PUFU_LENS_E2E_CHAT_PASSWORD,
};

type GraphRequestBody = {
  limit?: number;
  periodEnd?: string;
  periodStart?: string;
  queryId?: string;
};

const publicGraphQueryResult = {
  documentCount: 1,
  edges: [],
  graphName: 'graph_sample_a',
  limit: 50,
  nodes: [
    {
      id: 'doc-public-1',
      label: 'Spec Update',
      labels: ['Document'],
      properties: { title: 'Spec Update' },
    },
  ],
  preset: {
    defaultLimit: 50,
    description: 'Actor に紐づく Document を表示します。',
    id: 'actor-documents',
    label: 'Actor Documents',
    maxLimit: 500,
    preview: 'MATCH preview',
  },
  rawRows: [{ document_id: 'doc-public-1' }],
  rowCount: 1,
  truncated: false,
};

const privateGraphQueryResult = {
  documentCount: 1,
  edges: [],
  graphName: 'graph_local_dev',
  limit: 50,
  nodes: [
    {
      id: 'doc-member-1',
      label: 'Local Dev Doc',
      labels: ['Document'],
      properties: { title: 'Local Dev Doc' },
    },
  ],
  preset: publicGraphQueryResult.preset,
  rawRows: [{ document_id: 'doc-member-1' }],
  rowCount: 1,
  truncated: false,
};

test('scenario: public project side menu exposes Graph and marks it active on the graph page', async ({
  page,
}) => {
  await page.goto('/projects/sample-a/chat');

  const graphNav = page.getByTestId('global-nav-graph');
  await expect(graphNav).toBeVisible();
  await expect(graphNav).toHaveAttribute('href', '/projects/sample-a/graph');

  await graphNav.click();
  await expect(page).toHaveURL('/projects/sample-a/graph');
  await expect(graphNav).toHaveAttribute('aria-current', 'page');
});

test('scenario: public graph page renders GraphViewerPanel via the public Graph API', async ({
  page,
}) => {
  const graphRequestBodies: GraphRequestBody[] = [];
  let graphApiPath: string | undefined;
  let privateGraphApiCalls = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/projects/sample-a/graph') {
      privateGraphApiCalls += 1;
    }
  });
  await page.route('**/api/public/projects/sample-a/graph', async (route) => {
    graphApiPath = new URL(route.request().url()).pathname;
    const requestBody = route.request().postDataJSON() as GraphRequestBody;
    graphRequestBodies.push(requestBody);
    await route.fulfill({
      body: JSON.stringify(publicGraphQueryResult),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/graph');

  await expect(page.getByTestId('graph-viewer-panel')).toBeVisible();
  await expect(page.locator('label[for="graph-preset-select"]')).toContainText('Preset:');
  await expect(page.locator('label[for="graph-limit-select"]')).toContainText('Document count:');
  await expect(page.locator('label[for="graph-layout-select"]')).toContainText('Layout:');
  await expect(page.locator('label[for="graph-period-start-input"]')).toContainText('Start:');
  await expect(page.locator('label[for="graph-period-end-input"]')).toContainText('End:');
  await expect(page.getByTestId('graph-period-start-input')).toBeVisible();
  await expect(page.getByTestId('graph-period-end-input')).toBeVisible();
  await expect(page.getByTestId('graph-period-start-input')).toHaveValue('');
  await expect(page.getByTestId('graph-period-end-input')).toHaveValue('');

  await expect.poll(() => graphRequestBodies.length).toBeGreaterThan(0);
  const initialBody = graphRequestBodies[0];
  expect(initialBody?.periodStart).toBeUndefined();
  expect(initialBody?.periodEnd).toBeUndefined();
  expect(initialBody?.limit).toBe(50);
  expect(typeof initialBody?.queryId).toBe('string');

  await page.getByTestId('graph-period-start-input').fill('2026-01-01');
  await page.getByTestId('graph-period-end-input').fill('2026-01-31');

  await expect
    .poll(() =>
      graphRequestBodies.find(
        (body) =>
          body.periodStart === '2026-01-01' &&
          body.periodEnd === '2026-01-31' &&
          typeof body.limit === 'number' &&
          typeof body.queryId === 'string',
      ),
    )
    .toBeTruthy();

  await expect(page.getByTestId('graph-result-count')).toHaveText('1 document');
  await expect.poll(() => graphApiPath).toBe('/api/public/projects/sample-a/graph');
  expect(privateGraphApiCalls).toBe(0);
});

test('scenario: unauthenticated visitor cannot open private project graph', async ({ page }) => {
  await page.goto('/projects/sample-b/graph');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('graph-viewer-panel')).toHaveCount(0);
});

test('scenario: unknown project graph route redirects to projects list', async ({ page }) => {
  await page.goto('/projects/unknown-project-slug/graph');

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId('graph-viewer-panel')).toHaveCount(0);
});

test('scenario: authenticated project member uses private graph API on member project graph', async ({
  page,
}) => {
  test.skip(
    !process.env.DATABASE_URL || !memberGraphCredentials.email || !memberGraphCredentials.password,
    'DATABASE_URL, PUFU_LENS_E2E_CHAT_EMAIL, and PUFU_LENS_E2E_CHAT_PASSWORD are required.',
  );

  let privateGraphApiPath: string | undefined;
  let publicGraphApiCalls = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/public/projects/local-dev/graph') {
      publicGraphApiCalls += 1;
    }
  });
  await page.route('**/api/projects/local-dev/graph', async (route) => {
    privateGraphApiPath = new URL(route.request().url()).pathname;
    await route.fulfill({
      body: JSON.stringify(privateGraphQueryResult),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/login');
  await page.getByTestId('credentials-email-input').fill(memberGraphCredentials.email ?? '');
  await page.getByTestId('credentials-password-input').fill(memberGraphCredentials.password ?? '');
  await page.getByTestId('credentials-login-button').click();
  await expect(page).toHaveURL(/\/projects$/);

  await page.goto('/projects/local-dev/graph');

  await expect(page.getByTestId('graph-viewer-panel')).toBeVisible();
  await expect(page.getByTestId('graph-result-count')).toHaveText('1 document');
  await expect.poll(() => privateGraphApiPath).toBe('/api/projects/local-dev/graph');
  expect(publicGraphApiCalls).toBe(0);
});
