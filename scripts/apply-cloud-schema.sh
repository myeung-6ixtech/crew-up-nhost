#!/usr/bin/env bash
# Apply CrewUp migrations + Hasura metadata to a Nhost Cloud project.
#
# Setup (once):
#   cp .env.deploy.example .env.deploy
#   # Paste Hasura admin secret from Nhost Dashboard → Settings → Hasura
#
# Run:
#   npm run deploy:cloud
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/load-deploy-env.sh"
load_deploy_env "${ROOT}/.env.deploy"

SUBDOMAIN="${NHOST_SUBDOMAIN:?Set NHOST_SUBDOMAIN in .env.deploy}"
REGION="${NHOST_REGION:-ap-southeast-1}"
ADMIN_SECRET="${HASURA_GRAPHQL_ADMIN_SECRET:?Set HASURA_GRAPHQL_ADMIN_SECRET in .env.deploy}"
ENDPOINT="https://${SUBDOMAIN}.hasura.${REGION}.nhost.run"
HASURA_VERSION="${HASURA_CLI_VERSION:-2.36.0}"

echo "Applying migrations to ${ENDPOINT} ..."
cd "${ROOT}/nhost/hasura"
npx --yes "hasura-cli@${HASURA_VERSION}" migrate apply \
  --database-name default \
  --endpoint "${ENDPOINT}" \
  --admin-secret "${ADMIN_SECRET}"

echo "Applying metadata ..."
npx --yes "hasura-cli@${HASURA_VERSION}" metadata apply \
  --endpoint "${ENDPOINT}" \
  --admin-secret "${ADMIN_SECRET}"

echo "Reloading metadata ..."
npx --yes "hasura-cli@${HASURA_VERSION}" metadata reload \
  --endpoint "${ENDPOINT}" \
  --admin-secret "${ADMIN_SECRET}"

echo "Checking metadata consistency ..."
if ! npx --yes "hasura-cli@${HASURA_VERSION}" metadata inconsistency status \
  --endpoint "${ENDPOINT}" \
  --admin-secret "${ADMIN_SECRET}"; then
  echo "Metadata inconsistencies found. Run: hasura metadata inconsistency list"
  exit 1
fi

echo "Done. Run npm run verify:schema to confirm events and threads.event are exposed."
