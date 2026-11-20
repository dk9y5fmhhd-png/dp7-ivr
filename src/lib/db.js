import pg from 'pg';
import config from './config.js';
import log from './logger.js';

// Railway Postgres SSL maangta hai, local nahi
const needsSsl = config.dbSsl;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => log.error('pg pool error', { err: err.message }));

export const q = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}

export default pool;

