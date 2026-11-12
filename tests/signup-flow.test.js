// Automated tests for the future (currently disabled) self-service signup
// flow: the PUBLIC_SIGNUP_ENABLED-gated /signup-form.html route and the
// server-side validation enforced by /api/signup.
//
// Run with: node --test tests/signup-flow.test.js  (or `npm test`)
//
// server.js requires DATABASE_URL and SESSION_SECRET to be set at module
// load (see db/index.js and auth.js) and calls boot() — which connects to
// Postgres and binds a port — only when run directly (`require.main ===
// module`), guarded specifically so this test suite can require() it and
// get a fully-routed Express `app` without a live database. Every route
// exercised below (the gated static route, and validateSignupInput) does
// not touch the database, so this is real request-handling logic under
// test, not a re-implementation of it.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test_not_a_real_db';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-not-for-production';

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

function loadServerWithFlag(enabled) {
  if (enabled) {
    process.env.PUBLIC_SIGNUP_ENABLED = 'true';
  } else {
    delete process.env.PUBLIC_SIGNUP_ENABLED;
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  return require(SERVER_PATH);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

describe('GET /signup-form.html — gated by PUBLIC_SIGNUP_ENABLED', () => {
  test('route is unavailable (404) while disabled — the default', async () => {
    const { app } = loadServerWithFlag(false);
    const server = await listen(app);
    try {
      const res = await fetch(`${baseUrl(server)}/signup-form.html`);
      assert.equal(res.status, 404);
    } finally {
      server.close();
    }
  });

  for (const nonEnablingValue of ['0', 'false', 'yes', 'enabled', '']) {
    test(`an explicit non-"true" value (${JSON.stringify(nonEnablingValue)}) also keeps it disabled`, async () => {
      process.env.PUBLIC_SIGNUP_ENABLED = nonEnablingValue;
      delete require.cache[require.resolve(SERVER_PATH)];
      const { app } = require(SERVER_PATH);
      const server = await listen(app);
      try {
        const res = await fetch(`${baseUrl(server)}/signup-form.html`);
        assert.equal(res.status, 404);
      } finally {
        server.close();
        delete process.env.PUBLIC_SIGNUP_ENABLED;
      }
    });
  }

  test('route serves the real form (200) when explicitly enabled', async () => {
    const { app } = loadServerWithFlag(true);
    const server = await listen(app);
    try {
      const res = await fetch(`${baseUrl(server)}/signup-form.html`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Create an account/);
      assert.match(html, /agreedToTerms/);
    } finally {
      server.close();
      delete process.env.PUBLIC_SIGNUP_ENABLED;
    }
  });

  test('the terms checkbox is not pre-ticked in the served form', async () => {
    const { app } = loadServerWithFlag(true);
    const server = await listen(app);
    try {
      const res = await fetch(`${baseUrl(server)}/signup-form.html`);
      const html = await res.text();
      const termsInputMatch = html.match(/<input[^>]*id="su-terms"[^>]*>/);
      assert.ok(termsInputMatch, 'expected to find the terms checkbox in the form');
      assert.equal(/checked/.test(termsInputMatch[0]), false, 'terms checkbox must not be pre-ticked');
      const authorisedInputMatch = html.match(/<input[^>]*id="su-authorised"[^>]*>/);
      assert.ok(authorisedInputMatch);
      assert.equal(/checked/.test(authorisedInputMatch[0]), false, 'authorisation checkbox must not be pre-ticked');
    } finally {
      server.close();
      delete process.env.PUBLIC_SIGNUP_ENABLED;
    }
  });

  test('each legal document title links to the correct page', async () => {
    const { app } = loadServerWithFlag(true);
    const server = await listen(app);
    try {
      const res = await fetch(`${baseUrl(server)}/signup-form.html`);
      const html = await res.text();
      assert.match(html, /href="\/terms\.html"[^>]*>Terms of Service/);
      assert.match(html, /href="\/privacy\.html"[^>]*>Privacy Notice/);
      assert.match(html, /href="\/billing-terms\.html"[^>]*>Subscription and Billing Terms/);
    } finally {
      server.close();
      delete process.env.PUBLIC_SIGNUP_ENABLED;
    }
  });
});

describe('POST /api/signup — gated by PUBLIC_SIGNUP_ENABLED', () => {
  test('signup endpoint itself stays 403 while the flag is off, even if the form route is somehow reached', async () => {
    const { app } = loadServerWithFlag(false);
    const server = await listen(app);
    try {
      const res = await fetch(`${baseUrl(server)}/api/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403);
    } finally {
      server.close();
    }
  });
});

describe('validateSignupInput — server-side consent and data validation', () => {
  let validateSignupInput;
  before(() => {
    ({ validateSignupInput } = loadServerWithFlag(false));
  });

  function validBody(overrides = {}) {
    return {
      orgName: 'Example Utility',
      contactName: 'Jordan Smith',
      contactEmail: 'jordan@example-utility.com.au',
      username: 'jordan.smith',
      password: 'a-genuinely-long-password',
      confirmPassword: 'a-genuinely-long-password',
      agreedToTerms: true,
      authorisedToActForOrg: true,
      ...overrides,
    };
  }

  test('accepts a fully valid submission', () => {
    assert.equal(validateSignupInput(validBody()), null);
  });

  test('rejects when terms are not agreed to (consent required)', () => {
    const err = validateSignupInput(validBody({ agreedToTerms: false }));
    assert.match(err, /agree to the Terms of Service/);
  });

  test('rejects when agreedToTerms is merely truthy but not === true', () => {
    const err = validateSignupInput(validBody({ agreedToTerms: 'yes' }));
    assert.match(err, /agree to the Terms of Service/);
  });

  test('rejects when organisational authority is not confirmed', () => {
    const err = validateSignupInput(validBody({ authorisedToActForOrg: false }));
    assert.match(err, /authorised to act/);
  });

  test('rejects a missing organisation name', () => {
    const err = validateSignupInput(validBody({ orgName: '' }));
    assert.match(err, /Organisation name/);
  });

  test('rejects an invalid email address', () => {
    const err = validateSignupInput(validBody({ contactEmail: 'not-an-email' }));
    assert.match(err, /valid contact email/);
  });

  test('rejects a password below the minimum length', () => {
    const err = validateSignupInput(validBody({ password: 'short', confirmPassword: 'short' }));
    assert.match(err, /at least/);
  });

  test('rejects mismatched password confirmation', () => {
    const err = validateSignupInput(validBody({ confirmPassword: 'a-different-password' }));
    assert.match(err, /do not match/);
  });

  test('rejects an invalid username format', () => {
    const err = validateSignupInput(validBody({ username: 'ab' })); // too short
    assert.match(err, /Username must be/);
  });
});

describe('document version tracking', () => {
  test('TERMS_VERSION is exported and recorded against every signup consent event', () => {
    const { TERMS_VERSION } = loadServerWithFlag(false);
    assert.equal(typeof TERMS_VERSION, 'string');
    assert.ok(TERMS_VERSION.length > 0);
  });
});

describe('checkout cannot occur before authentication (i.e. before a completed signup)', () => {
  test('POST /api/vehicles/checkout requires an authenticated session', async () => {
    const { app } = loadServerWithFlag(false);
    const server = await listen(app);
    try {
      const res = await fetch(`${baseUrl(server)}/api/vehicles/checkout`, { method: 'POST' });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.match(data.error, /[Nn]ot authenticated/);
    } finally {
      server.close();
    }
  });
});
