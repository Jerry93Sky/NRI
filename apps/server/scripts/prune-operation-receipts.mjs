import { config } from 'dotenv';
import pg from 'pg';

config({ path: '../../.env', quiet: true });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
let removed = 0;
try {
  for (;;) {
    const result = await pool.query(`WITH expired AS (
      SELECT id FROM rest_operation_receipts WHERE expires_at <= statement_timestamp()
      ORDER BY expires_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED
    )
    DELETE FROM rest_operation_receipts receipt USING expired
    WHERE receipt.id = expired.id AND receipt.expires_at <= statement_timestamp()
    RETURNING receipt.id`);
    removed += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < 1000) break;
  }
  console.info(`Removed ${removed} expired REST operation receipts.`);
} catch {
  console.error('REST receipt cleanup failed. Check database connectivity and receipt-table permissions.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
