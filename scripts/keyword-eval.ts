import { readFile, writeFile } from 'node:fs/promises';
import { parseScriptArgv, requiredEnv } from './lib/cli.ts';
import { evaluateKeywordRun, keywordReportMarkdown, parseKeywordRun } from './lib/keyword-eval.ts';
import { keywordCorpus } from './lib/keyword-eval-corpus.ts';
import { collectPgroongaBaseline } from './lib/keyword-eval-pgroonga.ts';
import { collectPortableKeywords } from './lib/keyword-eval-portable.ts';

/** Runs synthetic collection or offline evaluation; spike comparison requires a baseline.
 * Failed gates exit 1 after writing the report; invalid arguments fail before evaluation.
 */
async function main(): Promise<void> {
  const args = parseScriptArgv(process.argv.slice(2), {
    commands: ['corpus', 'collect', 'spike', 'evaluate', 'evaluate-spike'],
    booleanFlags: [],
    valueOptions: ['--input', '--baseline', '--output', '--markdown'],
  });
  const get = (key: string) => args.valueOptions.get(key);
  if (!args.command)
    throw new Error('Expected corpus, collect, spike, evaluate or evaluate-spike.');
  const allowed =
    args.command === 'evaluate'
      ? ['--input', '--baseline', '--output', '--markdown']
      : args.command === 'evaluate-spike'
        ? ['--input', '--baseline', '--output']
        : ['--output'];
  if ([...args.valueOptions.keys()].some((key) => !allowed.includes(key)))
    throw new Error('Option not allowed for this command.');
  if (args.command === 'corpus') {
    await output(keywordCorpus, get('--output'));
  } else if (args.command === 'collect') {
    await output(
      await collectPgroongaBaseline(requiredEnv('KEYWORD_EVAL_DATABASE_URL')),
      get('--output'),
    );
  } else if (args.command === 'spike') {
    await output(
      await collectPortableKeywords(requiredEnv('KEYWORD_EVAL_DATABASE_URL')),
      get('--output'),
    );
  } else {
    const input = get('--input');
    if (!input) throw new Error('evaluate requires --input.');
    const baseline = get('--baseline');
    if (args.command === 'evaluate-spike' && !baseline)
      throw new Error('evaluate-spike requires --baseline.');
    const reference = baseline
      ? parseKeywordRun(JSON.parse(await readFile(baseline, 'utf8')))
      : undefined;
    const data: unknown = JSON.parse(await readFile(input, 'utf8'));
    if (args.command === 'evaluate-spike') {
      if (!Array.isArray(data) || !data.length) throw new Error('Expected nonempty spike array.');
      const reports = data.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || !('run' in entry))
          throw new Error('Invalid spike entry.');
        return evaluateKeywordRun(parseKeywordRun(entry.run), reference);
      });
      await output(reports, get('--output'));
      if (reports.some((report) => !report.gate)) process.exitCode = 1;
      return;
    }
    const report = evaluateKeywordRun(parseKeywordRun(data), reference);
    await output(report, get('--output'));
    const markdown = get('--markdown');
    if (markdown) await writeFile(markdown, keywordReportMarkdown(report));
    if (!report.gate) process.exitCode = 1;
  }
}

async function output(value: unknown, path?: string): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (path) await writeFile(path, json);
  else process.stdout.write(json);
}

main().catch(() => {
  // Driver errors may contain SQL/query/connection details. Do not serialize them into logs.
  console.error(
    'Keyword evaluation failed. Check command, snapshot schema and local evaluation DB configuration.',
  );
  process.exitCode = 1;
});
