import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type postgres from 'postgres';

const scryptAsync = promisify(scrypt);
const keyLength = 64;
const saltBytes = 16;
const missingCredentialPasswordHash =
  'scrypt:v1:pufu-lens-dummy-salt:b0hjJnuSJWzipQMsMim6a_hGrJorfFmNusChrNg9mzCpUyqB3ENtQ6-B_ldf9Si3nwuVH2bx0Wv12h0sOGO3-w';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export type PasswordCredentialRecord = {
  readonly email: string;
  readonly id: string;
  readonly name: string | null;
  readonly password_hash: string;
  readonly role: 'admin' | 'member';
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(saltBytes).toString('base64url');
  const hash = (await scryptAsync(password, salt, keyLength)) as Buffer;
  return `scrypt:v1:${salt}:${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== 'v1') {
    return false;
  }
  const salt = parts[2];
  const encodedHash = parts[3];
  if (!salt || !encodedHash) {
    return false;
  }
  const expected = Buffer.from(encodedHash, 'base64url');
  if (expected.length === 0) {
    return false;
  }
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function verifyPasswordCredential(
  input: { readonly email: string; readonly password: string },
  repository: {
    readonly findPasswordCredential: (
      email: string,
    ) => Promise<PasswordCredentialRecord | undefined>;
  },
): Promise<Omit<PasswordCredentialRecord, 'password_hash'> | undefined> {
  const email = normalizeEmail(input.email);
  if (!email || !input.password) {
    return undefined;
  }
  const credential = await repository.findPasswordCredential(email);
  const valid = await verifyPassword(
    input.password,
    credential?.password_hash ?? missingCredentialPasswordHash,
  );
  if (!credential || !valid) {
    return undefined;
  }
  return {
    email: credential.email,
    id: credential.id,
    name: credential.name,
    role: credential.role,
  };
}

export function createPostgresPasswordCredentialRepository(sql: SqlExecutor) {
  return {
    async createOrUpdatePasswordCredential(input: {
      readonly email: string;
      readonly name: string | null;
      readonly password: string;
    }): Promise<string> {
      const email = normalizeEmail(input.email);
      if (!email) {
        throw new Error('email is required.');
      }
      const passwordHash = await hashPassword(input.password);
      const rows = (await sql`
        INSERT INTO public.users (email, name, role)
        VALUES (${email}, ${input.name}, 'member')
        ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, public.users.name)
        RETURNING id::text
      `) as Array<{ id: string }>;
      const user = rows[0];
      if (!user) {
        throw new Error('Failed to create credentials user.');
      }
      await sql`
        INSERT INTO public.auth_password_credentials (user_id, password_hash)
        VALUES (${user.id}, ${passwordHash})
        ON CONFLICT (user_id)
        DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
      `;
      return user.id;
    },
    async findPasswordCredential(email: string): Promise<PasswordCredentialRecord | undefined> {
      const rows = (await sql`
        SELECT
          users.id::text,
          users.email,
          users.name,
          users.role,
          auth_password_credentials.password_hash
        FROM public.users
        JOIN public.auth_password_credentials
          ON auth_password_credentials.user_id = users.id
        WHERE users.email = ${normalizeEmail(email)}
      `) as PasswordCredentialRecord[];
      return rows[0];
    },
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
