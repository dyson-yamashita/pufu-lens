import { expect, test } from '@playwright/test';

const publicGraphQueryResult = {
  edges: [],
  graphName: 'graph_sample_a',
  limit: 100,
  nodes: [
    {
      id: 'doc-public-1',
      label: 'Spec Update',
      labels: ['Document'],
      properties: { title: 'Spec Update' },
    },
  ],
  preset: {
    defaultLimit: 100,
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
  let graphApiPath: string | undefined;
  let privateGraphApiCalls = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/projects/sample-a/graph') {
      privateGraphApiCalls += 1;
    }
  });
  await page.route('**/api/public/projects/sample-a/graph', async (route) => {
    graphApiPath = new URL(route.request().url()).pathname;
    await route.fulfill({
      body: JSON.stringify(publicGraphQueryResult),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/graph');

  await expect(page.getByTestId('graph-viewer-panel')).toBeVisible();
  await expect(page.getByTestId('graph-result-count')).toHaveText('1 rows');
  await expect.poll(() => graphApiPath).toBe('/api/public/projects/sample-a/graph');
  expect(privateGraphApiCalls).toBe(0);
});

test('scenario: unauthenticated visitor cannot open private project graph', async ({ page }) => {
  await page.goto('/projects/sample-b/graph');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('graph-viewer-panel')).toHaveCount(0);
});
