#!/bin/sh
# Repeatable pre-deploy verification for Fleet Shield (fleetshield.systems).
#
# This script does NOT trigger a Fly.io deployment itself -- deployment
# happens automatically when this repository's `main` branch is pushed
# to GitHub (.github/workflows/deploy.yml runs `fly deploy` after CI passes). What
# this script does is everything that should happen BEFORE that push.
# Pair with docs/deployment-verification-checklist.md for the steps to
# run AFTER the push, against the live URL.
#
# Does not run a live database migration -- that's `npm run migrate`,
# executed automatically as Fly's release_command (fly.toml)
# (see fly.toml), against the real DATABASE_URL, not something to run
# casually from a local machine against production.

set -e

echo "== Fleet Shield deploy-check =="
echo

echo "-- Repository state --"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT=$(git rev-parse HEAD)
echo "Branch: $BRANCH"
echo "Commit: $COMMIT"
if [ "$BRANCH" != "main" ]; then
  echo "WARNING: not on main -- this is fine for local testing, but only a" \
       "push to main triggers the real Fly.io deploy."
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: working tree has uncommitted changes."
fi
echo

echo "-- Clean install --"
npm ci
echo

echo "-- Lint --"
npm run lint
echo

echo "-- Test --"
npm test
echo

echo "== deploy-check passed for commit $COMMIT =="
echo "Next: push to main, then run docs/deployment-verification-checklist.md's"
echo "post-deploy section against the live URL -- do not consider this commit"
echo "deployed until that anonymous live check passes."
