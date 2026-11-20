// Migration runner — db/*.sql ko order me chalao, ek hi transaction me nahi
// (file khud BEGIN/COMMIT rakhti hai)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../src/lib/db.js';
import log from '../src/lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'db');

async function main() {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await fs.readFile(path.join(dir, f), 'utf8');
    process.stdout.write(`→ ${f} ... `);
    await pool.query(sql);
    console.log('ok');
  }
  log.info('migrate.complete', { files: files.length });
  await pool.end();
}

main().catch(async (e) => {
  log.error('migrate.failed', { err: e.message });
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});

