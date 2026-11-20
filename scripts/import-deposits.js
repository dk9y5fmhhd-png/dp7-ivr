// Daily deposit file import — CLI
// Chalao: npm run import-deposits -- 20-11-2026.xlsx
import fs from 'node:fs/promises';
import path from 'node:path';
import { importDepositFile } from '../src/retention/depositImport.js';
import { pool } from '../src/lib/db.js';
import log from '../src/lib/logger.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import-deposits -- path/to/deposits.xlsx');
  process.exit(1);
}

const buf = await fs.readFile(file);
const isXlsx = /\.xlsx?$/i.test(file) || (buf[0] === 0x50 && buf[1] === 0x4b);

const res = await importDepositFile(buf, { filename: path.basename(file), isXlsx });
console.log(JSON.stringify(res, null, 2));
log.info('deposits.cli_done', { imported: res.imported, duplicate: res.duplicate });
await pool.end();

