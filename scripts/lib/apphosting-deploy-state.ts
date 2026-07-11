export const DEFAULT_STATE_OBJECT_PREFIX = 'pufu-lens/deploy-state';

export function defaultDeployStateBucket(projectId: string): string {
  const trimmed = projectId.trim();
  if (!trimmed) {
    throw new Error('projectId is required.');
  }
  return `${trimmed}_cloudbuild`;
}

export function deployStateObjectPath(env: string): string {
  if (env !== 'staging' && env !== 'production') {
    throw new Error(`env must be staging or production, got: ${env}`);
  }
  return `${DEFAULT_STATE_OBJECT_PREFIX}/${env}/apphosting-last-success`;
}

export function parseStoredCommitSha(raw: string): string | null {
  const sha = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    return null;
  }
  return sha;
}
