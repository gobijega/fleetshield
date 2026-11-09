#!/bin/sh
# One-time Fleet Shield setup on Fly.io (Sydney): database + app.
# Run from the repo root after `fly auth login`. Safe to re-run.
set -e

APP=fleetshield
DB=fleetshield-db
REGION=syd

command -v fly >/dev/null || { echo "Install flyctl first: https://fly.io/docs/flyctl/install/"; exit 1; }
fly auth whoami >/dev/null || { echo "Run: fly auth login"; exit 1; }

echo "== Database ($DB, $REGION) =="
fly apps create "$DB" 2>/dev/null || echo "  app exists"
if ! fly volumes list -a "$DB" 2>/dev/null | grep -q pgdata; then
  fly volumes create pgdata -a "$DB" -r "$REGION" -s 3 --yes
fi
if ! fly secrets list -a "$DB" 2>/dev/null | grep -q POSTGRES_PASSWORD; then
  PGPASS=$(openssl rand -hex 24)
  fly secrets set -a "$DB" --stage POSTGRES_PASSWORD="$PGPASS"
  NEW_DB_PASS=1
fi
fly deploy -c fly-db.toml --ha=false --yes

echo
echo "== App ($APP, $REGION) =="
fly apps create "$APP" 2>/dev/null || echo "  app exists"

if [ -n "$NEW_DB_PASS" ]; then
  fly secrets set -a "$APP" --stage \
    DATABASE_URL="postgres://fleetshield:$PGPASS@$DB.internal:5432/fleetshield" \
    PGSSL=disable \
    SESSION_SECRET="$(openssl rand -hex 32)"
fi

if ! fly secrets list -a "$APP" 2>/dev/null | grep -q ADMIN_PASSWORD_HASH; then
  printf "Admin username: "; read -r ADMIN_USER
  stty -echo; printf "Admin password (12+ chars): "; read -r ADMIN_PASS; stty echo; echo
  [ -d node_modules ] || npm install --silent
  HASH=$(node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" "$ADMIN_PASS")
  fly secrets set -a "$APP" --stage ADMIN_USERNAME="$ADMIN_USER" ADMIN_PASSWORD_HASH="$HASH"
fi

# --ha=false: exactly ONE app machine (simulator + WebSocket feed are in-process)
fly deploy --ha=false --yes

echo
echo "Done. Check: https://$APP.fly.dev/api/health  (expect {\"ok\":true,\"db\":\"connected\"})"
echo "Then point fleetshield.systems at it: fly certs add fleetshield.systems -a $APP"
