const { readFileSync } = require('node:fs');
const { parseDocument } = require('yaml');

// Run before any deployment mutation. Firebase tools supplies yaml in the builder.
if (process.env.DEPLOY_ENV === 'production') {
  try {
    const document = parseDocument(readFileSync('apps/web/apphosting.yaml', 'utf8'));
    if (document.errors.length > 0) throw new Error('invalid YAML');
    const config = document.toJS();
    const entries = config.env.filter(
      (entry) => entry.variable === 'PUFU_LENS_GRAPH_TRANSITION_MODE',
    );
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      typeof entry.value !== 'string' ||
      entry.secret !== undefined ||
      !['off', 'dual-write', 'dual-write-shadow-read', 'relational-primary'].includes(
        entry.value,
      ) ||
      (entry.availability !== undefined &&
        (!Array.isArray(entry.availability) || !entry.availability.includes('RUNTIME'))) ||
      entry.value !== process.env.GRAPH_TRANSITION_MODE
    ) {
      throw new Error('graph mode mismatch');
    }
  } catch {
    console.error(
      'Production graph mode validation failed: _GRAPH_TRANSITION_MODE must match a single runtime PUFU_LENS_GRAPH_TRANSITION_MODE value in apps/web/apphosting.yaml.',
    );
    process.exitCode = 1;
  }
}
