#!/usr/bin/env bash
# Full cloud deploy: Hasura schema/metadata + auth JWT custom claims.
#
# Setup (once):
#   cp .env.deploy.example .env.deploy
#   # Add HASURA_GRAPHQL_ADMIN_SECRET from Nhost Dashboard → Settings → Hasura
#
# Prerequisites for auth config:
#   nhost login && nhost list   # must show your project subdomain
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

echo "=== 1/2 Hasura migrations + metadata ==="
npm run deploy:cloud

echo ""
echo "=== 2/2 Auth config (JWT custom claims) ==="
bash scripts/deploy-auth-config.sh

echo ""
echo "All done. Sign out and sign in on the app to pick up x-hasura-airline-id."
