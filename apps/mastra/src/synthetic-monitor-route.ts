import { registerApiRoute } from '@mastra/core/server';
import { handleSyntheticMonitorObservationsRequest } from '@pufu-lens/web/synthetic-monitor';

export const syntheticMonitorRoute = registerApiRoute('/internal/monitoring/v1/observations', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const result = await handleSyntheticMonitorObservationsRequest({
      authorizationHeader: context.req.header('authorization') ?? null,
      body: context.req.raw.body,
      contentLengthHeader: context.req.raw.headers.get('content-length'),
      env: process.env,
    });
    return context.json(result.body, result.status as 200 | 400 | 401 | 403 | 503);
  },
});
