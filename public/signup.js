// Public signup: creates the organization + admin account, then redirects
// to Stripe's hosted Checkout page to add a payment method and start the
// subscription. No card details ever pass through this form or this
// server — Checkout is Stripe's own page.
const form = document.getElementById('signupForm');
const errorEl = document.getElementById('signupError');
const btn = document.getElementById('signupBtn');
const emailInput = document.getElementById('contactEmail');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirmPassword');
const confirmPasswordHint = document.getElementById('confirmPasswordHint');

// Same shape the server checks (see validateSignupInput in server.js) —
// this is just for instant feedback; the server is the source of truth
// and re-validates everything regardless of what the client sends.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function updateConfirmPasswordHint() {
  if (!confirmPasswordInput.value) {
    confirmPasswordHint.textContent = '';
    confirmPasswordHint.className = 'field-hint';
    return true;
  }
  const matches = passwordInput.value === confirmPasswordInput.value;
  confirmPasswordHint.textContent = matches ? 'Passwords match.' : 'Passwords do not match.';
  confirmPasswordHint.className = matches ? 'field-hint success' : 'field-hint error';
  return matches;
}
passwordInput.addEventListener('input', updateConfirmPasswordHint);
confirmPasswordInput.addEventListener('input', updateConfirmPasswordHint);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';

  const contactEmail = emailInput.value.trim();
  const password = passwordInput.value;
  const confirmPassword = confirmPasswordInput.value;

  if (!EMAIL_RE.test(contactEmail)) {
    errorEl.textContent = 'Please enter a valid email address.';
    emailInput.focus();
    return;
  }
  if (password !== confirmPassword) {
    updateConfirmPasswordHint();
    errorEl.textContent = 'Passwords do not match — please re-enter them.';
    confirmPasswordInput.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Setting up your account…';
  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgName: document.getElementById('orgName').value,
        contactName: document.getElementById('contactName').value,
        contactEmail,
        username: document.getElementById('username').value,
        password,
        confirmPassword,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorEl.textContent = data.error || 'Something went wrong. Please try again.';
      return;
    }
    if (data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
      return;
    }
    // Billing not configured on this deployment — account is active
    // immediately, send them straight to sign in.
    window.location.href = '/login.html?signedUp=1';
  } catch (err) {
    errorEl.textContent = 'Network error — could not reach the server.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue to payment';
  }
});
