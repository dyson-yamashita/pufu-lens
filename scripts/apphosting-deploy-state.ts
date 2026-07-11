import {
  defaultDeployStateBucket,
  deployStateObjectPath,
  parseStoredCommitSha,
} from './lib/apphosting-deploy-state.ts';

type Command = 'read' | 'write' | 'object-path' | 'bucket';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!isCommand(command)) {
    printUsageAndExit();
  }

  switch (command) {
    case 'bucket': {
      const projectId = requiredFlag(rest, '--project') ?? process.env.PROJECT_ID;
      if (!projectId) {
        throw new Error('--project or PROJECT_ID is required.');
      }
      process.stdout.write(`${defaultDeployStateBucket(projectId)}\n`);
      return;
    }
    case 'object-path': {
      const env = requiredFlag(rest, '--env') ?? process.env._ENV;
      if (!env) {
        throw new Error('--env or _ENV is required.');
      }
      process.stdout.write(`${deployStateObjectPath(env)}\n`);
      return;
    }
    case 'read': {
      const bucket = requiredFlag(rest, '--bucket');
      const object = requiredFlag(rest, '--object');
      if (!bucket || !object) {
        throw new Error('--bucket and --object are required.');
      }
      const raw = await readObject(bucket, object);
      const sha = parseStoredCommitSha(raw);
      if (sha) {
        process.stdout.write(`${sha}\n`);
      }
      return;
    }
    case 'write': {
      const bucket = requiredFlag(rest, '--bucket');
      const object = requiredFlag(rest, '--object');
      const sha = requiredFlag(rest, '--sha');
      if (!bucket || !object || !sha) {
        throw new Error('--bucket, --object, and --sha are required.');
      }
      const parsed = parseStoredCommitSha(sha);
      if (!parsed) {
        throw new Error(`Invalid commit sha: ${sha}`);
      }
      await writeObject(bucket, object, `${parsed}\n`);
      return;
    }
  }
}

function isCommand(value: string | undefined): value is Command {
  return value === 'read' || value === 'write' || value === 'object-path' || value === 'bucket';
}

function requiredFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function printUsageAndExit(): never {
  process.stderr.write(
    [
      'Usage:',
      '  node --experimental-strip-types scripts/apphosting-deploy-state.ts bucket --project <id>',
      '  node --experimental-strip-types scripts/apphosting-deploy-state.ts object-path --env <staging|production>',
      '  node --experimental-strip-types scripts/apphosting-deploy-state.ts read --bucket <bucket> --object <object>',
      '  node --experimental-strip-types scripts/apphosting-deploy-state.ts write --bucket <bucket> --object <object> --sha <sha>',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

async function getAccessToken(): Promise<string> {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch metadata token: ${response.status}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('Metadata token response did not include access_token.');
  }
  return payload.access_token;
}

async function readObject(bucket: string, object: string): Promise<string> {
  const token = await getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    return '';
  }
  if (!response.ok) {
    throw new Error(
      `Failed to read gs://${bucket}/${object}: ${response.status} ${await response.text()}`,
    );
  }
  return await response.text();
}

async function writeObject(bucket: string, object: string, body: string): Promise<void> {
  const token = await getAccessToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to write gs://${bucket}/${object}: ${response.status} ${await response.text()}`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
