import type { Profile, User } from 'next-auth';
import NextAuth from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import { getRequiredAdminSql } from './src/admin-sql';
import { createPostgresAuthUserRepository, resolveAuthUser } from './src/auth-db';
import {
  createPostgresPasswordCredentialRepository,
  verifyPasswordCredential,
} from './src/password-auth';
import { isProductionBuildPhase, isProductionRuntime } from './src/runtime-guards';

const authProviders = buildProviders();

export const { auth, handlers, signIn, signOut } = NextAuth({
  callbacks: {
    async jwt({ account, profile, token, user }) {
      if (!account || !user) {
        return token;
      }
      if (account.provider === 'credentials') {
        token.userId = user.id;
        token.role = user.role;
        return token;
      }
      const provider = requireProvider(account.provider);
      const authUser = await resolveAuthUser(
        {
          email: getProfileEmail(profile, user),
          emailVerified: isProviderEmailVerified(provider, profile),
          name: getProfileName(profile, user),
          provider,
          providerAccountId: account.providerAccountId,
        },
        createPostgresAuthUserRepository(getRequiredAdminSql()),
      );
      token.userId = authUser.id;
      token.role = authUser.role;
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.userId === 'string') {
        session.user.id = token.userId;
      }
      if (session.user && typeof token.role === 'string') {
        session.user.role = token.role;
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  providers: authProviders,
  secret: getAuthSecret(),
  session: {
    strategy: 'jwt',
  },
  trustHost: true,
});
export const { GET, POST } = handlers;

export function getConfiguredAuthProviders(): readonly { id: 'github'; name: string }[] {
  const providers: Array<{ id: 'github'; name: string }> = [];
  if (hasGithubProviderEnv()) {
    providers.push({ id: 'github', name: 'GitHub' });
  }
  return providers;
}

function buildProviders(): Provider[] {
  const providers: Provider[] = [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = typeof credentials.email === 'string' ? credentials.email : '';
        const password = typeof credentials.password === 'string' ? credentials.password : '';
        const user = await verifyPasswordCredential(
          { email, password },
          createPostgresPasswordCredentialRepository(getRequiredAdminSql()),
        );
        return user ? { email: user.email, id: user.id, name: user.name, role: user.role } : null;
      },
    }),
  ];
  const githubEnv = getGithubProviderEnv();
  if (githubEnv) {
    providers.push(GitHub(githubEnv));
  }

  return providers;
}

function hasGithubProviderEnv(): boolean {
  return Boolean(getGithubProviderEnv());
}

function getGithubProviderEnv(): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env.AUTH_GITHUB_ID ?? process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.AUTH_GITHUB_SECRET ?? process.env.GITHUB_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function getAuthSecret(): string | undefined {
  if (process.env.AUTH_SECRET) {
    return process.env.AUTH_SECRET;
  }
  if (isProductionRuntime() && !isProductionBuildPhase()) {
    throw new Error('AUTH_SECRET is required in production environment.');
  }
  console.warn(
    'AUTH_SECRET is not set. Set AUTH_SECRET outside local development to protect Auth.js sessions.',
  );
  return 'pufu-lens-local-development-secret';
}

function getProfileEmail(profile: Profile | undefined, user: User): string | null {
  return getStringProfileValue(profile, 'email') ?? user.email ?? null;
}

function getProfileName(profile: Profile | undefined, user: User): string | null {
  return getStringProfileValue(profile, 'name') ?? user.name ?? null;
}

function getStringProfileValue(profile: Profile | undefined, key: string): string | null {
  const value = profile?.[key as keyof Profile];
  return typeof value === 'string' ? value : null;
}

function isProviderEmailVerified(
  provider: 'github' | 'google',
  profile: Profile | undefined,
): boolean {
  const verified = getBooleanProfileValue(profile, 'email_verified');
  if (typeof verified === 'boolean') {
    return verified;
  }
  if (provider === 'github') {
    return getBooleanProfileValue(profile, 'verified') ?? false;
  }
  return false;
}

function getBooleanProfileValue(profile: Profile | undefined, key: string): boolean | null {
  const value = profile?.[key as keyof Profile];
  return typeof value === 'boolean' ? value : null;
}

function requireProvider(provider: string): 'github' | 'google' {
  if (provider === 'github' || provider === 'google') {
    return provider;
  }
  throw new Error(`Unsupported auth provider: ${provider}`);
}
