// HTTP-level tests for POST /api/telemetry/import/csv — the route wiring
// around the CSV ingestion prototype (lib/ingestion/). These cover access
// control and the request-size limit, which can be exercised without a
// live Postgres instance. The parsing/validation/cumulative-total logic
// itself is covered directly in tests/csv-ingestion.test.js; consent/auth
// patterns here follow the same require.main guard used by
// tests/signup-flow.test.js.
//
// Run with: node --test tests/telemetry-import-route.test.js  (or `npm test`)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test_not_a_real_db';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-not-for-production';

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
delete require.cache[require.resolve(SERVER_PATH)];
const { app } = require(SERVER_PATH);

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

describe('POST /api/telemetry/import/csv — access control', () => {
  test('rejects an unauthenticated request (no session) with 401', async () => {
    const server = await listen();
    try {
      const res = await fetch(`${baseUrl(server)}/api/telemetry/import/csv`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: 'vehicle_id,timestamp,lat,lng\nVIC-01,2026-06-01T08:00:00Z,-37.8,144.9\n',
      });
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });

  test('rejects an oversized body before any auth/parsing logic runs', async () => {
    const server = await listen();
    try {
      const oversized = 'x'.repeat(2 * 1024 * 1024 + 1000);
      const res = await fetch(`${baseUrl(server)}/api/telemetry/import/csv`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: oversized,
      });
      assert.equal(res.status, 413);
    } finally {
      server.close();
    }
  });

  test('a request with the wrong content-type is still rejected (falls through to the auth gate, never reaches the handler unauthenticated)', async () => {
    const server = await listen();
    try {
      const res = await fetch(`${baseUrl(server)}/api/telemetry/import/csv`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv: 'irrelevant' }),
      });
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });
});
