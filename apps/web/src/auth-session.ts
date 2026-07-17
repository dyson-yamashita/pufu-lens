import { auth } from '../auth';
import { AuthRequiredError } from './auth-errors.ts';
import { isDevelopmentBypassEnabled } from './runtime-guards';

export { AuthRequiredError } from './auth-errors.ts';

export async function getSessionUserId(): Promise<string | undefined> {
  const session = await auth();
  return session?.user?.id;
}

export async function requireSessionUserId(): Promise<string> {
  const userId = await getSessionUserId();
  if (userId) {
    return userId;
  }
  if (isDevelopmentBypassEnabled('PUFU_LENS_ALLOW_FIXED_USER_FALLBACK')) {
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
