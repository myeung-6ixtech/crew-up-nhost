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

for field in users user; do
  if ! echo "${ROOT_FIELDS}" | jq -e --arg f "$field" '.data.__type.fields[] | select(.name == $f)' >/dev/null; then
    echo "MISSING on query_root: ${field} (required for Nhost Auth JWT custom claims)"
    missing=1
  else
    echo "OK query_root.${field}"
  fi
done

USER_CLAIMS_QUERY='query UserClaimsProbe($id: uuid!) { user(id: $id) { profile { airline_id is_verified } } }'
# Probe shape only — id may not exist; validation-failed on nested fields is the signal we care about.
USER_PROBE="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$USER_CLAIMS_QUERY" | jq -Rs .),\"variables\":{\"id\":\"00000000-0000-0000-0000-000000000001\"}}")"
if echo "${USER_PROBE}" | jq -e '.errors[] | select(.message | test("field .user. not found|field .profile. not found"))' >/dev/null 2>&1; then
  echo "MISSING auth.users GraphQL shape for JWT claims (user.profile)"
  missing=1
elif echo "${USER_PROBE}" | jq -e '.errors[] | select(.message | test("field .user. not found"))' >/dev/null 2>&1; then
  echo "MISSING query_root.user for JWT custom claims"
  missing=1
else
  echo "OK user(id).profile (JWT custom claims query shape)"
fi

for field in buckets files; do
  if ! echo "${ROOT_FIELDS}" | jq -e --arg f "$field" '.data.__type.fields[] | select(.name == $f)' >/dev/null; then
    echo "MISSING on query_root: ${field} (required for Nhost Storage)"
    missing=1
  else
    echo "OK query_root.${field}"
  fi
done

BUCKETS_PROBE="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { buckets(limit: 1) { id maxUploadFileSize } }"}')"
if echo "${BUCKETS_PROBE}" | jq -e '.errors[] | select(.message | test("field .buckets. not found"))' >/dev/null 2>&1; then
  echo "MISSING query_root.buckets for Nhost Storage"
  missing=1
else
  echo "OK buckets query (Nhost Storage)"
fi

if [[ "${missing}" -ne 0 ]]; then
  echo ""
  echo "Schema is incomplete. Run: npm run deploy:cloud"
  exit 1
fi

echo ""
echo "Schema check passed."
