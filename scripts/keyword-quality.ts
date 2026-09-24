import { writeAtomicJson } from './lib/atomic-json.ts';
import { collectKeywordQuality } from './lib/keyword-quality.ts';

/** Local-only quality CLI: writes evidence before returning exit 1 for an unmet quality gate. */
const url = process.env.KEYWORD_EVAL_DATABASE_URL;
const output = process.argv[2];
if (!url || !output || process.argv.length !== 3) {
  throw new Error(
    'Usage: KEYWORD_EVAL_DATABASE_URL=<local synthetic DB> node --experimental-strip-types scripts/keyword-quality.ts <report.json>',
  );
}
const report = await collectKeywordQuality(url);
await writeAtomicJson(output, report);
console.info(
  JSON.stringify({ keywordExactGate: report.keywordExactGate, hybridGate: report.hybridGate }),
);
// Recording a residual is not a successful quality gate.
if (!report.keywordExactGate || !report.hybridGate) process.exitCode = 1;
