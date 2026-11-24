import { config } from 'dotenv';
config({ path: '../../.env' });
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './db/index.js';

try { await migrate(db, { migrationsFolder: './drizzle' }); console.info('Database migrations applied.'); }
finally { await pool.end(); }
