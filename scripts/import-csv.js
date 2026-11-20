// Retention CSV import — CLI
// Chalao: npm run import -- retention-export.csv
import fs from 'node:fs/promises';
import path from 'node:path';
import { importRetentionCsv } from '../src/retention/import.js';
import { pool } from '../src/lib/db.js';
import log from '../src/lib/logger.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- path/to/retention.csv');
  process.exit(1);
}

const csv = await fs.readFile(file, 'utf8');
const res = await importRetentionCsv(csv, { filename: path.basename(file), source: 'cli' });
console.log(JSON.stringify(res, null, 2));
log.info('import.done', { imported: res.imported, rejected: res.rejected });
await pool.end();

