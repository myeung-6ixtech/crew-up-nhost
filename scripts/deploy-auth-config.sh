#!/usr/bin/env bash
# Apply nhost.toml auth config (JWT custom claims) to Nhost Cloud.
#
# IMPORTANT: nhost config apply REPLACES the entire cloud config with local
# nhost/nhost.toml. Before first apply (or after drift), run:
#   nhost config pull --subdomain "$NHOST_SUBDOMAIN"
# then re-merge CrewUp-specific settings (custom claims, OAuth, redirect URLs).
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
nhost config validate
nhost config apply --subdomain "${SUBDOMAIN}" --yes
echo "Done. Auth config applied (x-hasura-is-verified, x-hasura-airline-id claims)."
echo "Ensure metadata is deployed (npm run deploy:cloud) so query_root exposes user/users."
