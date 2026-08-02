// Public signup: creates the organization + admin account, then redirects
// to Stripe's hosted Checkout page to add a payment method and start the
// subscription. No card details ever pass through this form or this
// server — Checkout is Stripe's own page.
const form = document.getElementById('signupForm');
const errorEl = document.getElementById('signupError');
const btn = document.getElementById('signupBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Setting up your account…';
  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgName: document.getElementById('orgName').value,
        contactName: document.getElementById('contactName').value,
        contactEmail: document.getElementById('contactEmail').value,
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
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
