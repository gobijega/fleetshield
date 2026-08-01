/**
 * Postgres/TimescaleDB connection layer.
 *
 * Reads DATABASE_URL from the environment. Works against:
 *  - local docker-compose Timescale instance (no SSL)
 *  - Timescale Cloud / most managed Postgres (SSL required)
 *
 * Set PGSSL=disable for local/no-SSL connections. Defaults to requiring SSL
 * (with relaxed cert checking, which is normal for managed PG providers that
 * use a proxy-terminated cert chain) since production targets are cloud DBs.
 */
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

const useSSL = process.env.PGSSL !== 'disable';

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
