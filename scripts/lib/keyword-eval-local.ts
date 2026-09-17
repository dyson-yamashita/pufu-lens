/** Rejects everything except the explicitly named loopback synthetic DB, before connecting. */
export function validateKeywordEvalUrl(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/keyword_eval' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'KEYWORD_EVAL_DATABASE_URL must be a loopback evaluation DB URL without options.',
    );
}
