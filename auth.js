/**
 * Admin authentication for the Fleet Shield dashboard.
 *
 * Single-admin session gate: one username/password (bcrypt hash) configured
 * via environment variables, backed by a signed session cookie. Protects the
 * dashboard static files, the REST API, and the WebSocket stream (via
 * verifyClient on the WS upgrade — otherwise someone could bypass the login
 * page and connect straight to /ws).
 *
 * Also handles: optional TOTP-based MFA as a second login step, a
 * double-submit CSRF cookie for state-changing API requests, and an audit
 * trail of security-relevant events (login/MFA success+failure, logout).
 *
 * This is deliberately single-account (no user table, no roles) to match
 * the MVP's scope. See README for how multi-user auth would replace this.
 */
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cookie = require('cookie');
const cookieSignature = require('cookie-signature');
const { authenticator } = require('otplib');
const db = require('./db');

const SESSION_COOKIE_NAME = 'fs.sid';
const CSRF_COOKIE_NAME = 'fs.csrf';
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
// Optional — if set, MFA is required on top of the password. Generate with
// `npm run setup-mfa`. Deliberately optional (not exit-if-missing like the
// other three) so existing deployments keep working password-only until
// someone deliberately turns MFA on.
const ADMIN_TOTP_SECRET = process.env.ADMIN_TOTP_SECRET || null;

if (!SESSION_SECRET || !ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
  console.error(
    'Missing auth environment variables. Required: SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH.\n' +
    'Generate a password hash with: npm run hash-password -- "your-password"'
  );
  process.exit(1);
}

if (!ADMIN_TOTP_SECRET) {
  console.warn(
    'ADMIN_TOTP_SECRET not set — logging in only requires a password. ' +
    'Run `npm run setup-mfa` and set ADMIN_TOTP_SECRET to require a second factor.'
  );
}

// A pending-MFA session (password verified, code not yet entered) expires
// after this long — forces starting the login over rather than leaving a
// half-authenticated session sitting around indefinitely.
const MFA_PENDING_WINDOW_MS = 5 * 60 * 1000;

const sessionStore = new session.MemoryStore();

const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto', // requires app.set('trust proxy', 1) behind Render/Cloudflare
    maxAge: 12 * 60 * 60 * 1000, // 12h
  },
});

// --- basic brute-force throttling (in-memory, per-IP) -----------------------
// Shared between the password step and the MFA-code step — both are things
// an attacker could try to brute force, so both count against the same
// per-IP budget.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { count, windowStart }

function isRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// --- audit log ---------------------------------------------------------
// Deliberately awaited at auth call sites (unlike the fire-and-forget
// alert/position writes elsewhere in the app) — for a security audit trail,
// the point is that the record exists before the client is told the
// security-relevant action (login/logout/MFA) succeeded. Still never
// throws: a database hiccup shouldn't be able to lock an admin out, it just
// means that one audit entry didn't make it (logged to stderr).
async function audit(eventType, { username = null, ip = null, success = true, detail = null } = {}) {
  try {
    await db.query(
      `INSERT INTO audit_log (event_type, username, ip, success, detail) VALUES ($1,$2,$3,$4,$5)`,
      [eventType, username, ip, success, detail]
    );
  } catch (err) {
    console.error('Failed to write audit log entry', err.message);
  }
}

// --- CSRF (double-submit cookie) ----------------------------------------
// Issued alongside the session cookie once a login is fully complete
// (after MFA, if configured). Not httpOnly — the frontend JS needs to read
// it to echo it back as a header; that's the point of the pattern: a
// cross-site page can trigger a request with the session cookie attached
// automatically, but it can't read this cookie's value to forge the header,
// since cookies are scoped to the origin that set them.
function issueCsrfCookie(res) {
  const token = crypto.randomBytes(24).toString('hex');
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 12 * 60 * 60 * 1000,
  });
  return token;
}

function clearCsrfCookie(res) {
  res.clearCookie(CSRF_COOKIE_NAME);
}

// Only enforced on mutating methods — GET/HEAD/OPTIONS are unaffected so
// this can be mounted broadly without touching read endpoints. Parses the
// cookie header directly (via the same `cookie` package already used for
// the WS auth check) rather than pulling in cookie-parser as a dependency
// just for this one read.
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookies = cookie.parse(req.headers.cookie || '');
  const cookieToken = cookies[CSRF_COOKIE_NAME];
  const headerToken = req.get('X-CSRF-Token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF token missing or invalid.' });
  }
  next();
}

// --- routes -------------------------------------------------------------

function attachAuthRoutes(app) {
  app.post('/api/login', async (req, res) => {
    const ip = req.ip;
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const validUsername = username === ADMIN_USERNAME;
    const validPassword = validUsername && (await bcrypt.compare(password, ADMIN_PASSWORD_HASH));
    if (!validUsername || !validPassword) {
      recordFailedAttempt(ip);
      await audit('login_failed', { username, ip, success: false });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    req.session.regenerate(async (err) => {
      if (err) return res.status(500).json({ error: 'Could not start session.' });

      if (ADMIN_TOTP_SECRET) {
        // Password correct, but not authenticated yet — the MFA step still
        // has to succeed. Deliberately does NOT set `authenticated`, so
        // requireAuth/verifyWsClient keep blocking this session until then.
        clearAttempts(ip);
        req.session.pendingMfa = true;
        req.session.pendingMfaAt = Date.now();
        req.session.username = username;
        req.session.save((err2) => {
          if (err2) return res.status(500).json({ error: 'Could not save session.' });
          res.json({ ok: true, mfaRequired: true });
        });
        return;
      }

      clearAttempts(ip);
      req.session.authenticated = true;
      req.session.username = username;
      req.session.save(async (err2) => {
        if (err2) return res.status(500).json({ error: 'Could not save session.' });
        issueCsrfCookie(res);
        await audit('login_success', { username, ip });
        res.json({ ok: true, mfaRequired: false });
      });
    });
  });

  app.post('/api/login/verify-mfa', async (req, res) => {
    const ip = req.ip;
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    if (!ADMIN_TOTP_SECRET) {
      return res.status(400).json({ error: 'MFA is not configured.' });
    }
    if (!req.session || !req.session.pendingMfa) {
      return res.status(401).json({ error: 'No login in progress. Sign in again.' });
    }
    if (Date.now() - (req.session.pendingMfaAt || 0) > MFA_PENDING_WINDOW_MS) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'That took too long — sign in again.' });
    }

    const { token } = req.body || {};
    const valid = typeof token === 'string' && authenticator.verify({ token, secret: ADMIN_TOTP_SECRET });

    if (!valid) {
      recordFailedAttempt(ip);
      await audit('mfa_failed', { username: req.session.username, ip, success: false });
      return res.status(401).json({ error: 'Invalid or expired code.' });
    }

    clearAttempts(ip);
    const username = req.session.username;
    req.session.authenticated = true;
    delete req.session.pendingMfa;
    delete req.session.pendingMfaAt;
    req.session.save(async (err) => {
      if (err) return res.status(500).json({ error: 'Could not save session.' });
      issueCsrfCookie(res);
      await audit('login_success', { username, ip, detail: 'mfa' });
      res.json({ ok: true });
    });
  });

  app.post('/api/logout', (req, res) => {
    const username = req.session && req.session.username;
    const ip = req.ip;
    req.session.destroy(async () => {
      res.clearCookie(SESSION_COOKIE_NAME);
      clearCsrfCookie(res);
      await audit('logout', { username, ip });
      res.json({ ok: true });
    });
  });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  res.redirect('/login.html');
}

// --- WebSocket upgrade auth ----------------------------------------------
// ws's verifyClient runs before the HTTP connection is upgraded, so it's the
// right place to reject unauthenticated socket connections outright rather
// than relying only on the page-level redirect.
function verifyWsClient(info, done) {
  try {
    const cookies = cookie.parse(info.req.headers.cookie || '');
    const raw = cookies[SESSION_COOKIE_NAME];
    if (!raw || !raw.startsWith('s:')) return done(false, 401, 'Unauthorized');
    const sid = cookieSignature.unsign(raw.slice(2), SESSION_SECRET);
    if (!sid) return done(false, 401, 'Unauthorized');
    sessionStore.get(sid, (err, sessionData) => {
      if (err || !sessionData || !sessionData.authenticated) {
        return done(false, 401, 'Unauthorized');
      }
      done(true);
    });
  } catch (err) {
    console.error('verifyWsClient error', err);
    done(false, 401, 'Unauthorized');
  }
}

module.exports = { sessionMiddleware, attachAuthRoutes, requireAuth, verifyWsClient, requireCsrf, audit };
