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
const otpBoxes = Array.from(document.querySelectorAll('.otp-box'));

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
      otpBoxes[0].focus();
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

// --- Segmented 6-digit code input -------------------------------------
// Auto-advances focus as each digit is typed, supports backspace-to-clear-
// previous-box, and lets you paste a full 6-digit code into any box at
// once (covers pasting from a password manager's built-in TOTP generator).
// Submits automatically once all 6 boxes are filled, same as the OTP
// inputs on GitHub/Stripe/etc. — the Verify button stays as a fallback for
// anyone who'd rather not rely on that.
function otpValue() {
  return otpBoxes.map((b) => b.value).join('');
}

function focusBox(i) {
  if (otpBoxes[i]) otpBoxes[i].focus();
}

otpBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
    box.classList.toggle('filled', box.value !== '');
    if (box.value && i < otpBoxes.length - 1) {
      focusBox(i + 1);
    }
    if (otpValue().length === otpBoxes.length) {
      mfaForm.requestSubmit();
    }
  });

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      focusBox(i - 1);
      otpBoxes[i - 1].value = '';
      otpBoxes[i - 1].classList.remove('filled');
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault();
      focusBox(i - 1);
    } else if (e.key === 'ArrowRight' && i < otpBoxes.length - 1) {
      e.preventDefault();
      focusBox(i + 1);
    }
  });

  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const digits = (e.clipboardData.getData('text') || '').replace(/[^0-9]/g, '').slice(0, otpBoxes.length);
    if (!digits) return;
    digits.split('').forEach((d, j) => {
      if (otpBoxes[j]) {
        otpBoxes[j].value = d;
        otpBoxes[j].classList.add('filled');
      }
    });
    const next = Math.min(digits.length, otpBoxes.length - 1);
    focusBox(next);
    if (digits.length === otpBoxes.length) {
      mfaForm.requestSubmit();
    }
  });
});

mfaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = otpValue();
  if (token.length !== otpBoxes.length) {
    mfaErrorEl.textContent = 'Enter all 6 digits.';
    return;
  }
  mfaErrorEl.textContent = '';
  mfaBtn.disabled = true;
  mfaBtn.textContent = 'Verifying…';
  otpBoxes.forEach((b) => (b.disabled = true));
  try {
    const res = await fetch('/api/login/verify-mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    const data = await res.json().catch(() => ({}));
    mfaErrorEl.textContent = data.error || 'Invalid code. Try again.';
    otpBoxes.forEach((b) => { b.value = ''; b.classList.remove('filled'); });
    focusBox(0);
    if (data.error && data.error.includes('sign in again')) {
      setTimeout(() => window.location.reload(), 1500);
    }
  } catch (err) {
    mfaErrorEl.textContent = 'Network error — could not reach the server.';
  } finally {
    mfaBtn.disabled = false;
    mfaBtn.textContent = 'Verify';
    otpBoxes.forEach((b) => (b.disabled = false));
  }
});
