export type CredentialsRateLimitResult = {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
};

export type CredentialsRateLimiter = {
  readonly check: (key: string, now?: number) => CredentialsRateLimitResult;
  readonly recordFailure: (key: string, now?: number) => void;
  readonly reset: (key: string) => void;
};

type CredentialsRateLimitEntry = {
  readonly resetAt: number;
  readonly failures: number;
};

export function createCredentialsRateLimiter(input: {
  readonly limit: number;
  readonly windowMs: number;
}): CredentialsRateLimiter {
  const attempts = new Map<string, CredentialsRateLimitEntry>();
  return {
    check(key, now = Date.now()) {
      const entry = attempts.get(key);
      if (!entry || entry.resetAt <= now) {
        if (entry) {
          attempts.delete(key);
        }
        return { allowed: true, retryAfterMs: 0 };
      }
      if (entry.failures < input.limit) {
        return { allowed: true, retryAfterMs: 0 };
      }
      return { allowed: false, retryAfterMs: entry.resetAt - now };
    },
    recordFailure(key, now = Date.now()) {
      const entry = attempts.get(key);
      if (!entry || entry.resetAt <= now) {
        attempts.set(key, { failures: 1, resetAt: now + input.windowMs });
        return;
      }
      attempts.set(key, { failures: entry.failures + 1, resetAt: entry.resetAt });
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}

export function credentialsRateLimitKey(email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  return normalizedEmail || 'anonymous';
}
