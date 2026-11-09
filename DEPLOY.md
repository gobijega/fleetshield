# Deploying Fleet Shield: Fly.io, Sydney (app + database)

App and database both run in Sydney on Fly.io, talking over Fly's private
network, so Australian users get ~10–30 ms round trips with no cold starts.

- `fly.toml` — the app: one always-on `shared-cpu-1x` / 512 MB machine.
- `fly-db.toml` — TimescaleDB on a private 1 GB machine with a 3 GB volume
  (daily snapshots kept 14 days). Not reachable from the internet.

Rough cost: US$8–10/month total. Fly needs a card on file.

## 1. One-time setup

```sh
# install flyctl: https://fly.io/docs/flyctl/install/
fly auth login
./scripts/fly-setup.sh          # macOS/Linux/Git Bash
# Windows PowerShell:
# powershell -ExecutionPolicy Bypass -File scripts\fly-setup.ps1
```

The script creates both apps and the volume, generates the DB password and
`SESSION_SECRET`, asks for the admin username/password (hashed locally — the
plain password never leaves your machine), then deploys. Migrations run
automatically before each app release (`release_command` in `fly.toml`).

Check `https://fleetshield.fly.dev/api/health` → `{"ok":true,"db":"connected"}`.

Optional extras, any time (each restarts the app):

```sh
fly secrets set -a fleetshield ADMIN_TOTP_SECRET=...            # MFA, see README
fly secrets set -a fleetshield PUBLIC_SIGNUP_ENABLED=true       # only when intended
fly secrets set -a fleetshield STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... STRIPE_PRICE_ID=...
```

Useful: `fly logs -a fleetshield`, `fly ssh console -a fleetshield-db` then
`psql -U fleetshield` for a SQL shell, `fly volumes snapshots list <vol-id>`
for backups.

**Exactly one app machine.** The fleet simulator and WebSocket feed run
in-process. Always deploy with `--ha=false`; if `fly status` ever shows two
app machines, run `fly scale count 1 -a fleetshield --yes`.

### Auto-deploy on push

`.github/workflows/deploy.yml` deploys after CI passes on `main`. Create a token
with `fly tokens create deploy -x 999999h` and add it as the `FLY_API_TOKEN`
repo secret (GitHub → Settings → Secrets and variables → Actions).

## 3. Cut the domain over (Cloudflare)

1. `fly certs add fleetshield.systems` (and `fly certs add www.fleetshield.systems`
   if used). Fly prints the records it needs.
2. In Cloudflare DNS, replace the record pointing at `*.onrender.com` with a
   CNAME to `fleetshield.fly.dev`. Set it to **DNS only (grey cloud)** until
   `fly certs show fleetshield.systems` says the certificate is issued, then
   you can switch to **Proxied** if you want Cloudflare in front. SSL/TLS mode
   must be **Full (strict)**.
3. Update the Stripe webhook endpoint if its URL used the `onrender.com` host.
4. Once the domain serves from Fly and a login works, suspend/delete the Render
   service and `render.yaml`.

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
4. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_ID` (from steps 1-3) with `fly secrets set ...`, which restarts the machine.
   `APP_BASE_URL` is already set in `fly.toml`.
5. Visit `/signup.html` and run through a full signup with a real (or, in test mode, a
   test) card to confirm: the org is created, Checkout redirects back to
   `/signup-success.html`, the webhook fires and flips `subscription_status` to `active`,
   and logging in reaches the dashboard with an empty fleet ready for vehicles to be
   added.

## Notes for a tender / client demo

- **No cold starts**: `fly.toml` sets `auto_stop_machines = "off"` and
  `min_machines_running = 1`, so the app is always warm.
- **DB storage**: the volume is 3 GB. Grow it with
  `fly volumes extend <vol-id> -s 10 -a fleetshield-db`. `DB_WRITE_EVERY_N_TICKS=3`
  throttles position writes.
- **Re-seeding**: the fleet seeds itself only when the `vehicles` table is empty.
- **Admin login**: rotate with `npm run hash-password -- "new-password"` then
  `fly secrets set ADMIN_PASSWORD_HASH='...'` (restarts the machine).
- **Logs**: `fly logs`. **Shell**: `fly ssh console`.
