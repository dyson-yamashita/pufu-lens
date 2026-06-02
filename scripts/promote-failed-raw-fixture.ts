import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

interface Args {
  inputPath: string;
  outputName: string;
}

const args = parseArgs(process.argv.slice(2));
const raw = await readFile(args.inputPath, 'utf8');
const sanitized = sanitizeRaw(raw);
const outputDir = join(process.cwd(), 'fixtures/ingestion/regression');
const outputPath = join(outputDir, basename(args.outputName));

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, sanitized.endsWith('\n') ? sanitized : `${sanitized}\n`);
console.log(`Wrote ${outputPath}`);

function parseArgs(argv: string[]): Args {
  const inputIndex = argv.indexOf('--input');
  const outputIndex = argv.indexOf('--output');
  const inputPath = inputIndex >= 0 ? argv[inputIndex + 1] : undefined;
  const outputName = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;

  if (!inputPath || !outputName) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/promote-failed-raw-fixture.ts --input <path> --output <file>',
    );
  }

  return { inputPath, outputName };
}

function sanitizeRaw(raw: string): string {
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email: string): string => {
      const local = email.split('@')[0] ?? 'sample';
      return `${local.replace(/[^a-z0-9._+-]/gi, 'sample')}@example.test`;
    })
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url: string): string => sanitizeUrl(url))
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, 'ghp_example_redacted')
    .replace(/ya29\.[A-Za-z0-9_-]+/g, 'ya29.example-redacted')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer example-redacted')
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token": "example-redacted"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token": "example-redacted"')
    .replace(/"password"\s*:\s*"[^"]+"/gi, '"password": "example-redacted"')
    .replace(/"client_secret"\s*:\s*"[^"]+"/gi, '"client_secret": "example-redacted"')
    .replace(/"api_key"\s*:\s*"[^"]+"/gi, '"api_key": "example-redacted"')
    .replace(/"secret"\s*:\s*"[^"]+"/gi, '"secret": "example-redacted"');
}

function sanitizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'https://example.test/redacted';
  }

  if (url.hostname === 'example.test') {
    return redactSensitiveQueryParams(url).toString();
  }

  if (url.hostname === 'github.com' && url.pathname.startsWith('/example-org/')) {
    return redactSensitiveQueryParams(url).toString();
  }

  return 'https://example.test/redacted';
}

function redactSensitiveQueryParams(url: URL): URL {
  const sanitized = new URL(url.toString());
  for (const key of sanitized.searchParams.keys()) {
    if (/token|secret|password|key|code/i.test(key)) {
      sanitized.searchParams.set(key, 'example-redacted');
    }
  }
  return sanitized;
}
