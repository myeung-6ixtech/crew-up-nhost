#!/usr/bin/env bash
# Verify deployed Hasura schema exposes fields the CrewUp app requires.
#
# Usage:
#   npm run verify:schema
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

echo "Checking schema at ${ENDPOINT} ..."

QUERY='query SchemaCheck { __type(name: "query_root") { fields { name } } }'
ROOT_FIELDS="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$QUERY" | jq -Rs .)}")"

missing=0
for field in events threads thread_participants presence profiles airlines connections rosters notifications messages; do
  if ! echo "${ROOT_FIELDS}" | jq -e --arg f "$field" '.data.__type.fields[] | select(.name == $f)' >/dev/null; then
    echo "MISSING on query_root: ${field}"
    missing=1
  else
    echo "OK query_root.${field}"
  fi
done

THREADS_QUERY='query { __type(name: "threads") { fields { name } } }'
THREAD_FIELDS="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$THREADS_QUERY" | jq -Rs .)}")"

if ! echo "${THREAD_FIELDS}" | jq -e '.data.__type.fields[] | select(.name == "event")' >/dev/null; then
  echo "MISSING on threads: event (relationship to public.events)"
  missing=1
else
  echo "OK threads.event"
fi

for field in participants messages event_id; do
  if ! echo "${THREAD_FIELDS}" | jq -e --arg f "$field" '.data.__type.fields[] | select(.name == $f)' >/dev/null; then
    echo "MISSING on threads: ${field}"
    missing=1
  else
    echo "OK threads.${field}"
  fi
done

EVENTS_PK_QUERY='query { __type(name: "query_root") { fields(includeDeprecated: true) { name } } } }'
if echo "${ROOT_FIELDS}" | jq -e '.data.__type.fields[] | select(.name == "events_by_pk")' >/dev/null; then
  echo "OK query_root.events_by_pk"
else
  echo "MISSING on query_root: events_by_pk"
  missing=1
fi

if [[ "${missing}" -ne 0 ]]; then
  echo ""
  echo "Schema is incomplete. Run: npm run deploy:cloud"
  exit 1
fi

echo ""
echo "Schema check passed."
