import postgres from 'postgres';

const globalForSql = globalThis as typeof globalThis & {
  pufuLensAdminSql?: postgres.Sql;
};

export function getOptionalAdminSql(): postgres.Sql | undefined {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return undefined;
  }
  return getAdminSql(databaseUrl);
}

export function getRequiredAdminSql(): postgres.Sql {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for admin operations.');
  }
  return getAdminSql(databaseUrl);
}

function getAdminSql(databaseUrl: string): postgres.Sql {
  globalForSql.pufuLensAdminSql ??= postgres(databaseUrl, { max: 5 });
  return globalForSql.pufuLensAdminSql;
}
