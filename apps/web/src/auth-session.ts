import { auth } from '../auth';

export async function getSessionUserId(): Promise<string | undefined> {
  const session = await auth();
  return session?.user?.id;
}

export async function requireSessionUserId(): Promise<string> {
  const userId = await getSessionUserId();
  if (userId) {
    return userId;
  }
  if (process.env.PUFU_LENS_ALLOW_FIXED_USER_FALLBACK === 'true') {
    const fallbackUserId =
      process.env.PUFU_LENS_CHAT_USER_ID ??
      process.env.PUFU_LENS_REPORT_USER_ID ??
      process.env.PUFU_LENS_ADMIN_USER_ID;
    if (fallbackUserId) {
      return fallbackUserId;
    }
  }
  throw new AuthRequiredError();
}

export class AuthRequiredError extends Error {
  constructor() {
    super('Authentication is required.');
    this.name = 'AuthRequiredError';
  }
}
