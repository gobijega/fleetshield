/**
 * Runs db/migrations/*.sql against DATABASE_URL, in filename order.
 * Safe to re-run — statements use IF NOT EXISTS / idempotent guards.
 *
 * Usage: node scripts/migrate.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function main() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('No migration files found.');
    return;
  }
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`Applying ${file} ...`);
    await pool.query(sql);
    console.log(`  done.`);
  }
  console.log('All migrations applied.');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
