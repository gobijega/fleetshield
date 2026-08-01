/**
 * Admin authentication for the Fleet Shield dashboard.
 *
 * Single-admin session gate: one username/password (bcrypt hash) configured
 * via environment variables, backed by a signed session cookie. Protects the
 * dashboard static files, the REST API, and the WebSocket stream (via
 * verifyClient on the WS upgrade — otherwise someone could bypass the login
 * page and connect straight to /ws).
 *
 * This is deliberately simple (no user table, no roles) to match the MVP's
 * scope. See README for how multi-user auth would replace this.
 */
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cookie = require('cookie');
const cookieSignature = require('cookie-signature');

const SESSION_COOKIE_NAME = 'fs.sid';
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!SESSION_SECRET || !ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
  console.error(
    'Missing auth environment variables. Required: SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH.\n' +
    'Generate a password hash with: npm run hash-password -- "your-password"'
  );
  process.exit(1);
}

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

// --- routes -------------------------------------------------------------

function attachAuthRoutes(app) {
  app.post('/api/login', express_json_guard, async (req, res) => {
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
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    clearAttempts(ip);
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Could not start session.' });
      req.session.authenticated = true;
      req.session.username = username;
      req.session.save((err2) => {
        if (err2) return res.status(500).json({ error: 'Could not save session.' });
        res.json({ ok: true });
      });
    });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE_NAME);
      res.json({ ok: true });
    });
  });
}

// express.json() must run before /api/login reads req.body; server.js already
// applies express.json() globally before this router, so this is a no-op
// guard kept for clarity/robustness if route wiring ever changes.
function express_json_guard(req, res, next) {
  next();
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

module.exports = { sessionMiddleware, attachAuthRoutes, requireAuth, verifyWsClient };
