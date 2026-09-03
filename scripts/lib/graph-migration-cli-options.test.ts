import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GRAPH_COMPARE_LIMIT,
  DEFAULT_GRAPH_REBUILD_LIMIT,
  GraphMigrationCliValidationError,
  MAX_GRAPH_COMPARE_LIMIT,
  MAX_GRAPH_REBUILD_LIMIT,
  parseGraphMigrationCliOptions,
} from './graph-migration-cli-options.ts';

test('parseGraphMigrationCliOptions parses rebuild defaults and requires dry-run xor execute', () => {
  const options = parseGraphMigrationCliOptions(['rebuild', '--project', 'sample-a', '--dry-run']);
  assert.equal(options.command, 'rebuild');
  if (options.command !== 'rebuild') {
    return;
  }
  assert.equal(options.project, 'sample-a');
  assert.equal(options.limit, DEFAULT_GRAPH_REBUILD_LIMIT);
  assert.equal(options.dryRun, true);
  assert.equal(options.execute, false);
});

test('parseGraphMigrationCliOptions validates rebuild resume cursor and bounded limit', () => {
  const resumeCursor = 'a'.repeat(64);
  const options = parseGraphMigrationCliOptions([
    'rebuild',
    '--project',
    'sample-a',
    '--execute',
    '--limit',
    '250',
    '--resume-cursor',
    resumeCursor,
  ]);
  if (options.command !== 'rebuild') {
    throw new Error('expected rebuild command');
  }
  assert.equal(options.limit, 250);
  assert.equal(options.resumeCursor, resumeCursor);
});

test('parseGraphMigrationCliOptions rejects rebuild mutation and cursor misuse', () => {
  assert.throws(
    () => parseGraphMigrationCliOptions(['rebuild', '--project', 'sample-a']),
    /exactly one of --dry-run or --execute/,
  );
  assert.throws(
    () =>
      parseGraphMigrationCliOptions(['rebuild', '--project', 'sample-a', '--dry-run', '--execute']),
    /exactly one of --dry-run or --execute/,
  );
  assert.throws(
    () =>
      parseGraphMigrationCliOptions([
        'rebuild',
        '--project',
        'sample-a',
        '--dry-run',
        '--resume-cursor',
        'not-a-digest',
      ]),
    /--resume-cursor must be a 64-character lowercase hex digest/,
  );
  assert.throws(
    () =>
      parseGraphMigrationCliOptions([
        'rebuild',
        '--project',
        'sample-a',
        '--dry-run',
        '--limit',
        String(MAX_GRAPH_REBUILD_LIMIT + 1),
      ]),
    /--limit must be <=/,
  );
});

test('parseGraphMigrationCliOptions parses compare defaults and rejects mutation flags', () => {
  const options = parseGraphMigrationCliOptions(['compare', '--project', 'sample-a']);
  assert.equal(options.command, 'compare');
  if (options.command !== 'compare') {
    return;
  }
  assert.equal(options.limit, DEFAULT_GRAPH_COMPARE_LIMIT);
  assert.throws(
    () => parseGraphMigrationCliOptions(['compare', '--project', 'sample-a', '--dry-run']),
    /compare does not accept --dry-run or --execute/,
  );
  assert.throws(
    () =>
      parseGraphMigrationCliOptions([
        'compare',
        '--project',
        'sample-a',
        '--resume-cursor',
        'a'.repeat(64),
      ]),
    /compare does not accept --resume-cursor/,
  );
  assert.throws(
    () =>
      parseGraphMigrationCliOptions([
        'compare',
        '--project',
        'sample-a',
        '--limit',
        String(MAX_GRAPH_COMPARE_LIMIT + 1),
      ]),
    /--limit must be <=/,
  );
});

test('parseGraphMigrationCliOptions rejects duplicate and unknown options', () => {
  assert.throws(
    () =>
      parseGraphMigrationCliOptions(['rebuild', '--project', 'sample-a', '--dry-run', '--dry-run']),
    /duplicate argument: --dry-run/,
  );
  assert.throws(
    () => parseGraphMigrationCliOptions(['rebuild', '--project', 'sample-a', '--unknown', 'x']),
    /unsupported argument: --unknown/,
  );
  assert.throws(
    () => parseGraphMigrationCliOptions(['rebuild', '--project']),
    /missing value for --project/,
  );
});

test('parseGraphMigrationCliOptions throws GraphMigrationCliValidationError for argv validation failures', () => {
  assert.throws(
    () => parseGraphMigrationCliOptions(['rebuild', '--project', 'sample-a']),
    (error: unknown) => {
      assert.equal(error instanceof GraphMigrationCliValidationError, true);
      if (!(error instanceof GraphMigrationCliValidationError)) {
        return false;
      }
      assert.equal(error.name, 'GraphMigrationCliValidationError');
      assert.match(error.message, /exactly one of --dry-run or --execute/);
      return true;
    },
  );
});
