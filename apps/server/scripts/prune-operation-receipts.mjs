import { config } from 'dotenv';
import pg from 'pg';

config({ path: '../../.env' });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
let removed = 0;
try {
  for (;;) {
    const result = await pool.query(`DELETE FROM rest_operation_receipts
      WHERE id IN (SELECT id FROM rest_operation_receipts WHERE expires_at <= now() ORDER BY expires_at LIMIT 1000)
      RETURNING id`);
    removed += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < 1000) break;
  }
  console.info(`Removed ${removed} expired REST operation receipts.`);
} finally {
  await pool.end();
}
