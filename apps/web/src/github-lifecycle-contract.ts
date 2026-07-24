/**
 * Internal GitHub lifecycle contract shared by chat retrieval paths.
 *
 * Issue #648 should treat `statusKnown=false` as lifecycle not yet synchronized.
 */
export type { GitHubDocumentLifecycle } from '@pufu-lens/ingestion/github-lifecycle';
export { parseGitHubDocumentLifecycle } from '@pufu-lens/ingestion/github-lifecycle';
