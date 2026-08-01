#!/usr/bin/env bash
# Apply nhost.toml auth config (JWT custom claims) to Nhost Cloud.
#
# Prerequisites:
#   nhost login   # must be the account that owns the project
#   nhost list    # should show your subdomain (e.g. tvxoufuvglucgbdftsns)
#
# Usage:
#   npm run deploy:auth
#   NHOST_SUBDOMAIN=your-subdomain npm run deploy:auth
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBDOMAIN="${NHOST_SUBDOMAIN:-tvxoufuvglucgbdftsns}"

echo "Applying auth config to subdomain: ${SUBDOMAIN}"
cd "${ROOT}"
nhost config apply --subdomain "${SUBDOMAIN}" --yes
echo "Done. Sign out and sign in on the app so JWTs include x-hasura-airline-id."
