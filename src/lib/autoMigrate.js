// =====================================================================
//  Boot pe migration — Railway settings pe depend nahi
//
//  Wajah: "Pre-Deploy Command" har deploy pe nahi chalta (Railway ka
//  behaviour), aur console me `npm` PATH me nahi hota. To tables banane
//  ka sabse bharosemand tareeka: app start hote hi khud chala do.
//
//  Safe hai: db/*.sql idempotent hain (IF NOT EXISTS / OR REPLACE /
//  DO blocks). Dobara chalane pe kuch nahi todta.
// =====================================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from './db.js';
import log from './logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export default async function autoMigrate() {
  const dir = path.join(here, '..', '..', 'db');
  const applied = [];
  const failed = [];

  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch (e) {
    log.warn('migrate.no_dir', { dir, err: e.message });
    return { applied, failed };
  }

  for (const f of files) {
    try {
      const sql = await fs.readFile(path.join(dir, f), 'utf8');
      await pool.query(sql);
      applied.push(f);
    } catch (e) {
      // ek file fail ho to baaki mat rukna
      failed.push({ file: f, err: e.message, code: e.code });
      log.error('migrate.file_failed', { file: f, err: e.message, code: e.code });
    }
  }

  log.info('migrate.complete', { files: applied.length, failed: failed.length, auto: true });
  return { applied, failed };
}

