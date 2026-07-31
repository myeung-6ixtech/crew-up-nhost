# CrewUp Nhost Backend

Nhost backend for the CrewUp mobile app: Postgres, Hasura GraphQL, Auth, Storage, and serverless Functions.

Schema reference: [`../documentation/sql/`](../documentation/sql/) (MVP tables; `audit_log` deferred).

Architecture reference: [`../documentation/nhost-prd.md`](../documentation/nhost-prd.md).

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (required for `nhost up`)
- Node.js 20+
- Nhost CLI (`npm install -D @nhost/cli` in this repo, or `npm i -g @nhost/cli`)

## Quick start

```bash
cd crew-up-nhost
cp .secrets.example .secrets   # if .secrets does not exist yet
npm install
cd functions && npm install && cd ..
nhost up
```

Local endpoints (after `nhost up`):

| Service | URL |
|---|---|
| GraphQL | `https://local.graphql.local.nhost.run/v1/graphql` |
| Auth | `https://local.auth.local.nhost.run/v1` |
| Storage | `https://local.storage.local.nhost.run/v1` |
| Functions | `https://local.functions.local.nhost.run/v1` |
| Dashboard | `https://local.dashboard.local.nhost.run` |

Stop: `nhost down` · Logs: `nhost logs`

## Project layout

```
crew-up-nhost/
├── functions/                 # Serverless TypeScript endpoints
│   ├── _lib/                  # Shared auth + GraphQL helpers
│   ├── roster-parse.ts        # Hasura Action: parseRoster
│   ├── presence-compute.ts    # Event trigger on rosters
│   ├── notification-dispatch.ts
│   ├── moderation-webhook.ts  # Hasura Action: submitReport
│   ├── oauth-wechat.ts        # Stub (501)
│   └── oauth-line.ts          # Stub (501)
└── nhost/
    ├── nhost.toml             # Auth roles, JWT custom claims, services
    ├── migrations/default/    # MVP schema (no audit_log)
    └── metadata/              # Hasura tables, permissions, actions, triggers
```

## Database

Initial migration: `nhost/migrations/default/20260724100000_init_mvp_schema/up.sql`

Includes tables from `documentation/sql/001`–`008` and `010`, plus:

- `auth.roles` entries: `moderator`, `staff_admin`, `service`
- Storage buckets: `avatars`, `rosters`, `verification-docs`

**Excluded:** `audit_log` (deferred).

## Auth roles & JWT claims

Application roles in [`nhost/nhost.toml`](nhost/nhost.toml):

- `user` (default)
- `moderator`, `staff_admin` (assign via `auth.user_roles`)

Custom JWT claims (requires `auth.users` → `profile` relationship):

- `x-hasura-is-verified` ← `profiles.is_verified`
- `x-hasura-airline-id` ← `profiles.airline_id`

Assign staff roles in SQL or dashboard:

```sql
INSERT INTO auth.user_roles (user_id, role) VALUES ('<uuid>', 'staff_admin');
```

## GraphQL Actions

| Mutation | Function | Purpose |
|---|---|---|
| `parseRoster(fileId: uuid!)` | `/v1/functions/roster-parse` | Mock/heuristic roster parse for confirmation |
| `submitReport(...)` | `/v1/functions/moderation-webhook` | Create safety report |

## Event triggers & cron

| Trigger | Table / schedule | Function |
|---|---|---|
| `rosters_presence_compute` | `rosters` insert/update/delete | `presence-compute` |
| `messages_notify` | `messages` insert | `notification-dispatch` |
| `notification_digest_daily` | `0 8 * * *` | `notification-dispatch` (`mode: digest`) |

Event/cron calls require header `nhost-webhook-secret` = `NHOST_WEBHOOK_SECRET`.

## Functions (local smoke tests)

```bash
# OAuth stubs
curl -i https://local.functions.local.nhost.run/v1/oauth-wechat

# parseRoster (requires user JWT)
curl -i https://local.functions.local.nhost.run/v1/roster-parse \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":{"name":"parseRoster"},"input":{"fileId":"00000000-0000-0000-0000-000000000001"},"session_variables":{}}'
```

## Secrets

Local: [`.secrets`](.secrets) (gitignored). Template: [`.secrets.example`](.secrets.example).

Cloud: `nhost secrets create|update` per environment.

| Variable | Used by |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Nhost Auth → Google OAuth provider |
| `OCR_PROVIDER_API_KEY` | `roster-parse` (stub checks presence) |
| `FCM_SERVER_KEY` / `APNS_KEY` | `notification-dispatch` (push stub) |
| `NHOST_WEBHOOK_SECRET` | Event triggers + cron |
| `NHOST_ADMIN_SECRET` | Functions → Hasura `service` role |

## Google OAuth

Google generates the credentials — you do **not** invent a Client ID or Client Secret. Create them in [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID** → type **Web application**.

### Redirect URIs (required in Google)

Add **both** if you use local dev and Nhost Cloud:

| Environment | Authorized JavaScript origin | Authorized redirect URI |
|---|---|---|
| Local (`nhost up`) | `https://local.auth.local.nhost.run` | `https://local.auth.local.nhost.run/v1/signin/provider/google/callback` |
| Cloud | `https://<subdomain>.auth.<region>.nhost.run` | `https://<subdomain>.auth.<region>.nhost.run/v1/signin/provider/google/callback` |

Replace `<subdomain>` and `<region>` with your Nhost Cloud project values (e.g. `abcdefgh`, `eu-central-1`). Find the exact callback URL in the Nhost Dashboard → **Authentication** → **Google** when enabling the provider.

OAuth consent screen: while in **Testing**, add your Google account under **Test users**. For production, complete Google's verification (or use a custom auth domain on Nhost).

### Wire secrets into `crew-up-nhost`

`nhost/nhost.toml` references:

```toml
[auth.method.oauth.google]
enabled = true
clientId = '{{ secrets.GOOGLE_CLIENT_ID }}'
clientSecret = '{{ secrets.GOOGLE_CLIENT_SECRET }}'
```

**Local** — add to `.secrets` (gitignored):

```bash
GOOGLE_CLIENT_ID='123456789-xxxx.apps.googleusercontent.com'
GOOGLE_CLIENT_SECRET='GOCSPX-xxxxxxxx'
```

Then restart: `nhost down && nhost up`

**Nhost Cloud** — set the same keys in Dashboard → **Settings** → **Secrets**, or:

```bash
nhost secrets create GOOGLE_CLIENT_ID --value '123456789-xxxx.apps.googleusercontent.com'
nhost secrets create GOOGLE_CLIENT_SECRET --value 'GOCSPX-xxxxxxxx'
```

Use separate Google OAuth clients (or separate secret values) per environment (local vs dev vs prod) if redirect URIs differ.

## Validation

```bash
nhost config validate
npm run config:validate
```

With Docker running:

```bash
nhost up
# In Hasura console: confirm tables tracked, run parseRoster / insert roster → presence rows
```

## Deploy

1. Connect this repo to a Nhost Cloud project (GitHub integration).
2. Use separate projects for dev / staging / production (see nhost-prd §7.2).
3. Push `nhost/migrations`, `nhost/metadata`, `functions/`, and `nhost/nhost.toml`.

## Known MVP simplifications

- Presence/event visibility filters omit friends-of-friends graph and block-list joins (Phase 2 hardening).
- Roster parsing returns mock data until OCR provider is integrated.
- Push notifications log only when FCM/APNS keys are unset.
- WeChat/LINE OAuth endpoints return `501`.
