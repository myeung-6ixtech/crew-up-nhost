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
for field in events threads thread_participants presence profiles airlines activities connections rosters notifications messages; do
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

USER_CLAIMS_QUERY='query UserClaimsProbe($id: uuid!) { user(id: $id) { profile { airline_id is_verified } displayName userProviders { id providerId } } }'
# Probe shape only — id may not exist; validation-failed on nested fields is the signal we care about.
USER_PROBE="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$USER_CLAIMS_QUERY" | jq -Rs .),\"variables\":{\"id\":\"00000000-0000-0000-0000-000000000001\"}}")"
if echo "${USER_PROBE}" | jq -e '.errors[] | select(.message | test("field .displayName. not found|field .userProviders. not found|field .user. not found|field .profile. not found"))' >/dev/null 2>&1; then
  echo "MISSING auth.users GraphQL shape for Nhost Auth (user.displayName / user.userProviders / user.profile)"
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
  -d '{"query":"query { buckets(limit: 1) { id minUploadFileSize maxUploadFileSize downloadExpiration } }"}')"
if echo "${BUCKETS_PROBE}" | jq -e '.errors[] | select(.message | test("field .buckets. not found|field .minUploadFileSize. not found"))' >/dev/null 2>&1; then
  echo "MISSING buckets camelCase fields for Nhost Storage"
  missing=1
else
  echo "OK buckets query (Nhost Storage camelCase fields)"
fi

MUTATION_QUERY='query { __type(name: "mutation_root") { fields { name } } }'
MUTATION_FIELDS="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$MUTATION_QUERY" | jq -Rs .)}")"

for field in insertFiles updateFile; do
  if ! echo "${MUTATION_FIELDS}" | jq -e --arg f "$field" '.data.__type.fields[] | select(.name == $f)' >/dev/null; then
    echo "MISSING on mutation_root: ${field} (required for Nhost Storage uploads)"
    missing=1
  else
    echo "OK mutation_root.${field}"
  fi
done

for field in authRoles authUserRoles authUserProviders authProviders; do
  if ! echo "${ROOT_FIELDS}" | jq -e --arg f "$field" '.data.__type.fields[] | select(.name == $f)' >/dev/null; then
    echo "MISSING on query_root: ${field} (required for Nhost Auth / Storage permissions UI)"
    missing=1
  else
    echo "OK query_root.${field}"
  fi
done

AUTH_ROLES_PROBE="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { authRoles { role } }"}')"
if echo "${AUTH_ROLES_PROBE}" | jq -e '.errors[] | select(.message | test("field .authRoles. not found"))' >/dev/null 2>&1; then
  echo "MISSING authRoles query for Nhost dashboard"
  missing=1
else
  echo "OK authRoles query (Nhost Auth / Storage permissions)"
fi

USERS_BOOL_EXP_QUERY='query { __type(name: "users_bool_exp") { inputFields { name } } }'
USERS_BOOL_EXP="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$USERS_BOOL_EXP_QUERY" | jq -Rs .)}")"
if ! echo "${USERS_BOOL_EXP}" | jq -e '.data.__type.inputFields[] | select(.name == "displayName")' >/dev/null; then
  echo "MISSING users_bool_exp.displayName (Nhost Auth user filters require camelCase column_config on auth.users)"
  missing=1
else
  echo "OK users_bool_exp.displayName (Nhost Auth camelCase columns)"
fi

USERS_TYPE_QUERY='query { __type(name: "users") { fields { name } } }'
USERS_TYPE="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$USERS_TYPE_QUERY" | jq -Rs .)}")"
if ! echo "${USERS_TYPE}" | jq -e '.data.__type.fields[] | select(.name == "userProviders")' >/dev/null; then
  echo "MISSING users.userProviders relationship (track auth.user_providers + auth_user_providers.yaml)"
  missing=1
else
  echo "OK users.userProviders (Nhost Auth users list / OAuth linking)"
fi

if [[ "${missing}" -ne 0 ]]; then
  echo ""
  echo "Schema is incomplete. Run: npm run deploy:cloud"
  exit 1
fi

# Admin portal: staff_admin aggregate permissions (shape check via admin introspection)
ADMIN_AGG_QUERY='query { events_aggregate { aggregate { count } } profiles_aggregate { aggregate { count } } usersAggregate { aggregate { count } } }'
ADMIN_AGG="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$ADMIN_AGG_QUERY" | jq -Rs .)}")"
if echo "${ADMIN_AGG}" | jq -e '.errors[] | select(.message | test("field .events_aggregate. not found|field .profiles_aggregate. not found|field .usersAggregate. not found"))' >/dev/null 2>&1; then
  echo "MISSING aggregate root fields for admin dashboard (staff_admin permissions)"
  missing=1
else
  echo "OK aggregate root fields (events_aggregate, profiles_aggregate, usersAggregate)"
fi

for field in users usersAggregate authUserRoles authRoles; do
  if ! echo "${ROOT_FIELDS}" | jq -e --arg f "$field" '.data.__type.fields[] | select(.name == $f)' >/dev/null; then
    echo "MISSING on query_root: ${field} (required for admin user/role management)"
    missing=1
  else
    echo "OK query_root.${field}"
  fi
done

if [[ "${missing}" -ne 0 ]]; then
  echo ""
  echo "Schema is incomplete. Run: npm run deploy:cloud"
  exit 1
fi

EVENTS_TYPE_QUERY='query { __type(name: "events") { fields { name } } }'
EVENTS_TYPE="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$EVENTS_TYPE_QUERY" | jq -Rs .)}")"
for field in host_type is_published published_at featured_until; do
  if ! echo "${EVENTS_TYPE}" | jq -e --arg f "$field" '.data.__type.fields[] | select(.name == $f)' >/dev/null; then
    echo "MISSING on events: ${field} (platform events migration)"
    missing=1
  else
    echo "OK events.${field}"
  fi
done

EVENT_HOST_TYPE_QUERY='query { __type(name: "event_host_type") { enumValues { name } } } }'
EVENT_HOST_TYPE="$(curl -sf "${ENDPOINT}/v1/graphql" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":$(printf '%s' "$EVENT_HOST_TYPE_QUERY" | jq -Rs .)}")"
for value in user platform; do
  if ! echo "${EVENT_HOST_TYPE}" | jq -e --arg v "$value" '.data.__type.enumValues[] | select(.name == $v)' >/dev/null; then
    echo "MISSING enum event_host_type value: ${value}"
    missing=1
  else
    echo "OK event_host_type.${value}"
  fi
done

if [[ "${missing}" -ne 0 ]]; then
  echo ""
  echo "Schema is incomplete. Run: npm run deploy:cloud"
  exit 1
fi

echo ""
echo "Schema check passed."
