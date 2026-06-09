import type postgres from 'postgres';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export type AuthProviderId = 'github' | 'google';

export type AuthAccountInput = {
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly provider: AuthProviderId;
  readonly providerAccountId: string;
};

export type AuthUserRecord = {
  readonly email: string;
  readonly id: string;
  readonly name: string | null;
  readonly role: 'admin' | 'member';
};

export type AuthUserRepository = {
  readonly createUser: (input: {
    readonly email: string;
    readonly name: string | null;
  }) => Promise<AuthUserRecord>;
  readonly findAccountUser: (input: {
    readonly provider: AuthProviderId;
    readonly providerAccountId: string;
  }) => Promise<AuthUserRecord | undefined>;
  readonly findUserByEmail: (email: string) => Promise<AuthUserRecord | undefined>;
  readonly linkAccount: (input: {
    readonly email: string;
    readonly emailVerified: boolean;
    readonly provider: AuthProviderId;
    readonly providerAccountId: string;
    readonly userId: string;
  }) => Promise<void>;
  readonly updateUserProfile: (input: {
    readonly email: string;
    readonly name: string | null;
    readonly userId: string;
  }) => Promise<void>;
};

export class AuthAccountLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthAccountLinkError';
  }
}

export async function resolveAuthUser(
  input: AuthAccountInput,
  repository: AuthUserRepository,
): Promise<AuthUserRecord> {
  const existingAccountUser = await repository.findAccountUser({
    provider: input.provider,
    providerAccountId: input.providerAccountId,
  });
  const normalizedEmail = normalizeEmail(input.email);

  if (existingAccountUser) {
    if (normalizedEmail) {
      const updatedName = normalizeName(input.name) ?? existingAccountUser.name;
      await repository.updateUserProfile({
        email: normalizedEmail,
        name: updatedName,
        userId: existingAccountUser.id,
      });
      return {
        ...existingAccountUser,
        email: normalizedEmail,
        name: updatedName,
      };
    }
    return existingAccountUser;
  }

  if (!normalizedEmail) {
    throw new AuthAccountLinkError('OAuth provider did not return an email address.');
  }

  const existingEmailUser = await repository.findUserByEmail(normalizedEmail);
  if (existingEmailUser && !input.emailVerified) {
    throw new AuthAccountLinkError('Verified email is required to link an existing account.');
  }

  const user =
    existingEmailUser ??
    (await repository.createUser({
      email: normalizedEmail,
      name: normalizeName(input.name),
    }));

  await repository.linkAccount({
    email: normalizedEmail,
    emailVerified: input.emailVerified,
    provider: input.provider,
    providerAccountId: input.providerAccountId,
    userId: user.id,
  });
  const updatedName = normalizeName(input.name) ?? user.name;
  await repository.updateUserProfile({
    email: normalizedEmail,
    name: updatedName,
    userId: user.id,
  });

  return {
    ...user,
    email: normalizedEmail,
    name: updatedName,
  };
}

export function createPostgresAuthUserRepository(sql: SqlExecutor): AuthUserRepository {
  return {
    async createUser({ email, name }) {
      const rows = (await sql`
        INSERT INTO public.users (email, name, role)
        VALUES (${email}, ${name}, 'member')
        RETURNING id::text, email, name, role
      `) as AuthUserRecord[];
      const user = rows[0];
      if (!user) {
        throw new Error('Failed to create auth user.');
      }
      return user;
    },
    async findAccountUser({ provider, providerAccountId }) {
      const rows = (await sql`
        SELECT users.id::text, users.email, users.name, users.role
        FROM public.auth_accounts
        JOIN public.users ON users.id = auth_accounts.user_id
        WHERE auth_accounts.provider = ${provider}
          AND auth_accounts.provider_account_id = ${providerAccountId}
      `) as AuthUserRecord[];
      return rows[0];
    },
    async findUserByEmail(email) {
      const rows = (await sql`
        SELECT id::text, email, name, role
        FROM public.users
        WHERE email = ${email}
      `) as AuthUserRecord[];
      return rows[0];
    },
    async linkAccount({ email, emailVerified, provider, providerAccountId, userId }) {
      await sql`
        INSERT INTO public.auth_accounts (
          provider,
          provider_account_id,
          user_id,
          email,
          email_verified
        )
        VALUES (${provider}, ${providerAccountId}, ${userId}, ${email}, ${emailVerified})
        ON CONFLICT (provider, provider_account_id)
        DO UPDATE SET
          email = EXCLUDED.email,
          email_verified = EXCLUDED.email_verified,
          updated_at = now()
      `;
    },
    async updateUserProfile({ email, name, userId }) {
      await sql`
        UPDATE public.users
        SET email = ${email},
            name = ${name}
        WHERE id = ${userId}
      `;
    },
  };
}

function normalizeEmail(email: string | null): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

function normalizeName(name: string | null): string | null {
  const normalized = name?.trim();
  return normalized || null;
}
