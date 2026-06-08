import type { Profile, User } from 'next-auth';
import NextAuth from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import { getRequiredAdminSql } from './src/admin-sql';
import { createPostgresAuthUserRepository, resolveAuthUser } from './src/auth-db';
import {
  createPostgresPasswordCredentialRepository,
  verifyPasswordCredential,
} from './src/password-auth';

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
      const authUser = await resolveAuthUser(
        {
          email: getProfileEmail(profile, user),
          emailVerified: isProfileEmailVerified(profile),
          name: getProfileName(profile, user),
          provider: requireProvider(account.provider),
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

export function getConfiguredAuthProviders(): readonly { id: 'github' | 'google'; name: string }[] {
  const providers: Array<{ id: 'github' | 'google'; name: string }> = [];
  if (hasGithubProviderEnv()) {
    providers.push({ id: 'github', name: 'GitHub' });
  }
  if (hasGoogleProviderEnv()) {
    providers.push({ id: 'google', name: 'Google' });
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

  const googleEnv = getGoogleProviderEnv();
  if (googleEnv) {
    providers.push(Google(googleEnv));
  }

  return providers;
}

function hasGithubProviderEnv(): boolean {
  return Boolean(getGithubProviderEnv());
}

function hasGoogleProviderEnv(): boolean {
  return Boolean(getGoogleProviderEnv());
}

function getGithubProviderEnv(): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env.AUTH_GITHUB_ID ?? process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.AUTH_GITHUB_SECRET ?? process.env.GITHUB_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function getGoogleProviderEnv(): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function getAuthSecret(): string | undefined {
  if (process.env.AUTH_SECRET) {
    return process.env.AUTH_SECRET;
  }
  return process.env.NODE_ENV === 'production' ? undefined : 'pufu-lens-local-development-secret';
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

function isProfileEmailVerified(profile: Profile | undefined): boolean {
  const verified = profile?.email_verified;
  if (typeof verified === 'boolean') {
    return verified;
  }
  return false;
}

function requireProvider(provider: string): 'github' | 'google' {
  if (provider === 'github' || provider === 'google') {
    return provider;
  }
  throw new Error(`Unsupported auth provider: ${provider}`);
}
