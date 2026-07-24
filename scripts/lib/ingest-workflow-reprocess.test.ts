import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  REPROCESS_SUPPORTED_SOURCE_TYPES,
  validateReprocessCommandOptions,
} from './ingest-workflow-reprocess.ts';

const reprocessSource = await readFile(
  new URL('./ingest-workflow-reprocess.ts', import.meta.url),
  'utf8',
);
const parseRawDocumentsSource = await readFile(
  new URL('../parse-raw-documents.ts', import.meta.url),
  'utf8',
);
const builtInParserProfilesSource = await readFile(
  new URL('../../packages/ingestion/src/built-in-parser-profiles.ts', import.meta.url),
  'utf8',
);
const adminDataSourceActionsSource = await readFile(
  new URL('../../apps/web/src/admin-data-source-actions.ts', import.meta.url),
  'utf8',
);
const ingestWorkflowSource = await readFile(
  new URL('../ingest-workflow.ts', import.meta.url),
  'utf8',
);

test('ingest workflow step selection injects default resumeFrom only when step is absent', () => {
  assert.match(ingestWorkflowSource, /function selectWorkflowSteps/);
  assert.match(
    ingestWorkflowSource,
    /options\.step \? options : \{ resumeFrom: options\.resumeFrom \?\? 'parse' \}/,
  );
  assert.match(ingestWorkflowSource, /Cannot specify both --step and --resume-from/);
  assert.match(ingestWorkflowSource, /selectWorkflowSteps\(options\)/);
  assert.doesNotMatch(
    ingestWorkflowSource,
    /selectSteps\(\{ \.\.\.options, resumeFrom: options\.resumeFrom \?\? 'parse' \}\)/,
  );
});

test('validateReprocessCommandOptions requires project, source, and apply or dry-run', () => {
  assert.throws(() => validateReprocessCommandOptions({ dryRun: true }), /--project is required/);
  assert.throws(
    () => validateReprocessCommandOptions({ dryRun: true, project: 'sample-a' }),
    /--source is required/,
  );
  assert.throws(
    () =>
      validateReprocessCommandOptions({
        project: 'sample-a',
        source: 'gmail',
        dryRun: true,
      }),
    /supports --source github only/,
  );
  assert.throws(
    () =>
      validateReprocessCommandOptions({
        project: 'sample-a',
        source: 'github',
      }),
    /requires --apply or --dry-run/,
  );

  assert.deepEqual(
    validateReprocessCommandOptions({
      apply: true,
      project: 'sample-a',
      source: 'github',
    }),
    { projectSlug: 'sample-a', sourceType: 'github' },
  );

  assert.deepEqual(
    validateReprocessCommandOptions({
      dryRun: true,
      project: 'sample-a',
      source: 'github',
    }),
    { projectSlug: 'sample-a', sourceType: 'github' },
  );
});

test('stale parser raw query selects queue-bound latest raws behind active parser', () => {
  assert.match(reprocessSource, /rd\.parser_version_id IS DISTINCT FROM pp\.active_version_id/);
  assert.match(reprocessSource, /rd\.ingest_status IN \('parsed', 'indexed'\)/);
  assert.match(reprocessSource, /NOT EXISTS\s*\(\s*SELECT 1\s*FROM public\.raw_documents newer/s);
  assert.match(reprocessSource, /newer\.source_type = rd\.source_type/);
  assert.match(reprocessSource, /ON ds\.id = q\.data_source_id/);
  assert.match(reprocessSource, /pp\.name = \$\{builtInProfileName\}/);
  assert.match(reprocessSource, /builtInParserProfileName\(input\.sourceType\)/);
  assert.doesNotMatch(reprocessSource, /raw_document_data_sources/);
  assert.match(reprocessSource, /parsed_uri = null/);
  assert.match(reprocessSource, /FOR UPDATE OF q SKIP LOCKED/);
  assert.match(reprocessSource, /sql\.begin/);
  assert.match(reprocessSource, /parser_profile_id = null/);
  assert.match(reprocessSource, /parser_version_id = null/);
  assert.deepEqual(REPROCESS_SUPPORTED_SOURCE_TYPES, ['github']);
});

test('reprocess reset clears parsed_uri so retry cannot reuse stale parsed JSON', () => {
  assert.match(
    reprocessSource,
    /ingest_status = 'fetched'[\s\S]*parsed_uri = null[\s\S]*parser_version_id = null/,
  );
});

test('built-in parser seed keeps legacy versions immutable', () => {
  assert.match(
    builtInParserProfilesSource,
    /ON CONFLICT \(parser_profile_id, version\) DO NOTHING/,
  );
  assert.doesNotMatch(
    builtInParserProfilesSource,
    /ON CONFLICT \(parser_profile_id, version\)[\s\S]*artifact_hash = EXCLUDED\.artifact_hash/,
  );
  assert.match(builtInParserProfilesSource, /BUILT_IN_PARSER_VERSION/);
  assert.match(builtInParserProfilesSource, /async function activateBuiltInParserVersion/);
  assert.match(builtInParserProfilesSource, /active_version_id IS DISTINCT FROM pv\.id/);
  assert.match(parseRawDocumentsSource, /ensureBuiltInParserProfilesForProjectScope\(/);
  assert.match(adminDataSourceActionsSource, /ensureBuiltInParserProfileForDataSource\(/);
});

test('ingest:reprocess normalizes graph before chunk when both steps are selected', () => {
  assert.match(
    ingestWorkflowSource,
    /async function reprocessCommand[\s\S]*normalizeReprocessWorkflowSteps\(/,
  );
});
