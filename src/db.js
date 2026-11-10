import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Return TIMESTAMPTZ values as JS Dates (default) and BIGINT (seq) as strings (default).
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1|host=\/tmp/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

let ready;
// Creates the tables on first use, once per running instance. On serverless hosts a burst
// of traffic starts many instances at once, so the setup runs under a database-wide lock
// and is skipped entirely when the tables already exist.
export function ensureSchema() {
  if (!ready) {
    ready = createSchema().catch((err) => { ready = undefined; throw err; });
  }
  return ready;
}

async function createSchema() {
  const exists = await pool.query(`SELECT to_regclass('public.booking_attempts') IS NOT NULL AS ok`);
  if (exists.rows[0].ok) return;
  // A transaction-level lock works through connection poolers such as Neon's.
  await withTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(727274)');
    await db.query(readFileSync(join(here, 'schema.sql'), 'utf8'));
  });
}

// Runs fn(client) inside a transaction and always releases the connection.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
