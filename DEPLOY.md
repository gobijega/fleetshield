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
4. Before deploying, set the `DATABASE_URL` environment variable to the Timescale
   connection string from step 1.4. (`render.yaml` marks it `sync: false` deliberately —
   secrets like this shouldn't live in the repo.)
5. Click **Apply** / **Deploy**. Render will:
   - run `npm install` (build),
   - run `npm run migrate` (pre-deploy — creates the tables + hypertable in Timescale),
   - run `npm start` (boot the server, which seeds the 10-vehicle fleet on first run).
6. Once it's live, open `https://<your-service>.onrender.com/api/health` — you should
   see `{"ok":true,"db":"connected"}`. Then open the root URL for the dashboard itself.

## Notes for a tender / client demo

- **Cold starts**: Render's free plan spins a service down after 15 minutes of no
  traffic; the next request takes ~30–50s to wake it back up. Fine for casual use, but
  jarring if you're live-demoing it to GMW. Upgrade to the **Starter** plan (~US$7/mo)
  before any real walkthrough so it's instant and always-on.
- **Free-tier DB storage**: Timescale's free tier has a storage cap; once hit, the
  service goes read-only. `render.yaml` sets `DB_WRITE_EVERY_N_TICKS=3` to throttle
  position-write volume by default — raise it further, or upgrade the Timescale plan,
  if you run it for days at a time.
- **Custom domain**: Render → your service → Settings → Custom Domains. You could route
  something like `fleet.jegasec.com` here the same way `jegasec.com` was pointed at
  Cloudflare — a CNAME to Render's provided hostname.
- **Re-seeding**: the fleet only seeds itself once, when the `vehicles` table is empty.
  To reset demo data, drop the tables in Timescale's SQL console and redeploy (or just
  wait for the pre-deploy migration to re-run against empty tables).
