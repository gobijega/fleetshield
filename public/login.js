// Two-step login: password first, then (if the server says MFA is
// configured) a 6-digit TOTP code. Kept as an external file rather than an
// inline <script> in login.html so the CSP's script-src can be 'self' only,
// with no 'unsafe-inline' exception.
const passwordForm = document.getElementById('loginForm');
const mfaForm = document.getElementById('mfaForm');
const errorEl = document.getElementById('loginError');
const mfaErrorEl = document.getElementById('mfaError');
const loginBtn = document.getElementById('loginBtn');
const mfaBtn = document.getElementById('mfaBtn');

passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.mfaRequired) {
      passwordForm.style.display = 'none';
      mfaForm.style.display = 'block';
      document.getElementById('mfaCode').focus();
      return;
    }
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    errorEl.textContent = data.error || 'Sign-in failed. Check your credentials and try again.';
  } catch (err) {
    errorEl.textContent = 'Network error — could not reach the server.';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in';
  }
});

mfaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  mfaErrorEl.textContent = '';
  mfaBtn.disabled = true;
  mfaBtn.textContent = 'Verifying…';
  try {
    const res = await fetch('/api/login/verify-mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: document.getElementById('mfaCode').value }),
    });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    const data = await res.json().catch(() => ({}));
    mfaErrorEl.textContent = data.error || 'Invalid code. Try again.';
    if (data.error && data.error.includes('sign in again')) {
      setTimeout(() => window.location.reload(), 1500);
    }
  } catch (err) {
    mfaErrorEl.textContent = 'Network error — could not reach the server.';
  } finally {
    mfaBtn.disabled = false;
    mfaBtn.textContent = 'Verify';
  }
});
