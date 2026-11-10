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
// Creates the tables on first use, once per running instance.
export function ensureSchema() {
  if (!ready) {
    const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
    ready = pool.query(sql).catch((err) => { ready = undefined; throw err; });
  }
  return ready;
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
