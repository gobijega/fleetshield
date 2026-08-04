# Deploying Fleet Shield: Timescale Cloud + Render

Two accounts, both free to start. ~15 minutes.

## 1. Database — Timescale Cloud

1. Go to [console.cloud.timescale.com](https://console.cloud.timescale.com/) and sign
   up (email + password, verify via the confirmation email).
2. Click **Create service**. Choose the **Time-series** service type.
3. Pick the free tier, any region (closer to your Render region = lower latency —
   `us-east` is a safe default since Render's free plan runs there too).
4. Once the service is provisioning, copy the connection string it gives you. It looks
   like:
   ```
   postgres://tsdbadmin:<password>@<service>.tsdb.cloud.timescale.com:<port>/tsdb?sslmode=require
   ```
   Save this somewhere — you'll paste it into Render as `DATABASE_URL` in step 2.4.
   (Timescale's free tier includes the TimescaleDB extension pre-installed, so
   `CREATE EXTENSION timescaledb` in the migration will work without any extra setup.)

## 2. App — Render

1. Push the latest `telematics-mvp` code (including `render.yaml`) to the `fleetshield`
   GitHub repo if you haven't already.
2. Go to [dashboard.render.com](https://dashboard.render.com/) and sign up / log in
   (GitHub sign-in is the quickest — it also handles repo access).
3. Click **New** → **Blueprint**, and select the `fleetshield` repo. Render will detect
   `render.yaml` and show you the `fleetshield` web service it defines.
4. Before deploying, set these environment variables in the Render dashboard
   (`render.yaml` marks them `sync: false` deliberately — secrets shouldn't live in the
   repo):
   - `DATABASE_URL` — the Timescale connection string from step 1.4.
   - `ADMIN_USERNAME` — whatever username you want to log in with.
   - `ADMIN_PASSWORD_HASH` — generate this locally first: `npm run hash-password -- "your-password"`,
     then paste the output (a `$2b$...` bcrypt hash, not the plain password) here.
   - `SESSION_SECRET` is handled for you — `render.yaml` sets `generateValue: true`, so
     Render generates and stores a random one automatically.
   - `ADMIN_TOTP_SECRET` — optional, turns on mandatory MFA for login. Skip it for now if
     you want the service up quickly; run `npm run setup-mfa` later and add this var
     (Environment tab → Save, which restarts the service) whenever you're ready. See the
     README's "Security" section.
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `APP_BASE_URL` —
     optional, enable self-service signup + subscription billing. Skip all four to launch
     without public signup (the existing single-admin login still works fine). See
     "Enabling billing" below whenever you're ready to turn it on.
5. Click **Apply** / **Deploy**. Render will:
   - run `npm install && npm run migrate` (build — installs deps, then creates the tables
     + hypertable in Timescale; folded into the build step since `preDeployCommand` is a
     paid-plan-only Render feature and the migration is safe to (re-)run on every build),
   - run `npm start` (boot the server, which seeds the 10-vehicle fleet on first run).
6. Once it's live, open `https://<your-service>.onrender.com/api/health` — you should
   see `{"ok":true,"db":"connected"}`. Then open the root URL — it should redirect you to
   `/login.html`. Sign in with the username/password you set above.

## 3. Custom domain — Cloudflare

If you bought a domain through Cloudflare and want it pointing at this app instead of
(or alongside) `jegasec.com`:

1. **Render side**: your service → **Settings** → **Custom Domains** → **Add Custom
   Domain**. Enter something like `fleet.jegasec.com`. Render shows you a CNAME target
   (looks like `<your-service>.onrender.com`).
2. **Cloudflare side**: DNS → **Add record** → type `CNAME`, name `fleet` (or whatever
   subdomain you chose), target the hostname Render gave you, proxy status **Proxied**
   (orange cloud) — Cloudflare's proxy supports WebSockets on every plan, including
   free, so live vehicle updates will keep working through it.
3. **SSL/TLS mode**: same setup as `jegasec.com` — SSL/TLS → Overview → set to **Full**
   or **Full (strict)**, and turn on **Always Use HTTPS** under Edge Certificates. Render
   issues its own certificate for the custom domain automatically once DNS resolves.
4. Give it a few minutes for DNS to propagate, then visit `https://fleet.jegasec.com` —
   you should land on the login page.

## Enabling billing

1. In the [Stripe dashboard](https://dashboard.stripe.com/apikeys), grab your secret key
   (`sk_live_...` for real charges, or switch the dashboard to Test mode first and use a
   `sk_test_...` key plus a test-mode Price ID while you verify the flow with a
   [test card](https://docs.stripe.com/testing) before going live).
2. Create a recurring Price for the subscription (Products → Add product): AUD $17.50,
   billing period Monthly, pricing model "Standard pricing" (per-unit/"licensed" usage
   type — quantity is set by the app, not self-reported by the customer). Copy its
   `price_...` ID.
3. Developers → Webhooks → Add endpoint: URL `https://<your-domain>/api/webhooks/stripe`,
   events `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy the
   signing secret (`whsec_...`).
4. In Render's Environment tab, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_ID` (from steps 1-3) and `APP_BASE_URL` (your live domain, e.g.
   `https://fleetshield.systems`) → Save, which restarts the service.
5. Visit `/signup.html` and run through a full signup with a real (or, in test mode, a
   test) card to confirm: the org is created, Checkout redirects back to
   `/signup-success.html`, the webhook fires and flips `subscription_status` to `active`,
   and logging in reaches the dashboard with an empty fleet ready for vehicles to be
   added.

## Notes for a tender / client demo

- **Cold starts**: Render's free plan spins a service down after 15 minutes of no
  traffic; the next request takes ~30–50s to wake it back up. Fine for casual use, but
  jarring if you're live-demoing it to a prospective partner. Upgrade to the
  **Starter** plan (~US$7/mo) before any real walkthrough so it's instant and always-on.
- **Free-tier DB storage**: Timescale's free tier has a storage cap; once hit, the
  service goes read-only. `render.yaml` sets `DB_WRITE_EVERY_N_TICKS=3` to throttle
  position-write volume by default — raise it further, or upgrade the Timescale plan,
  if you run it for days at a time.
- **Re-seeding**: the fleet only seeds itself once, when the `vehicles` table is empty.
  To reset demo data, drop the tables in Timescale's SQL console and redeploy (or just
  wait for the pre-deploy migration to re-run against empty tables).
- **Admin login**: there's a single admin account (see step 2.4) protecting the whole
  dashboard, API, and live WebSocket feed. Rotate the password by re-running
  `npm run hash-password -- "new-password"` and updating `ADMIN_PASSWORD_HASH` in Render
  — no redeploy needed, just save the env var and Render restarts the service.
