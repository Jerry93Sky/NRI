import { config } from 'dotenv';
config({ path: '../../.env' });
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;
const databaseUrl = URL.parse(process.env.DATABASE_URL ?? '');
if (!databaseUrl || !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname || !databaseUrl.username || databaseUrl.pathname.length < 2) {
  throw new Error('DATABASE_URL must be a PostgreSQL connection URL with a host, user and database');
}
export const pool = new Pool({ connectionString: databaseUrl.href, connectionTimeoutMillis: 5000, max: 10 });
export const db = drizzle(pool, { schema });
