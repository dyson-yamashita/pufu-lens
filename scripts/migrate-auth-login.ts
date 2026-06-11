import { migrateDatabase } from './db-migrate.ts';

await migrateDatabase();
console.log('auth login migration completed');
