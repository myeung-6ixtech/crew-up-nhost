#!/usr/bin/env node
/**
 * Creates the App Review demo account and the people, trips, chat and meets it needs to show every feature.
 * Safe to run again: seed users are reused and their trips, meets and demo chat are recreated.
 *
 *   REVIEWER_PASSWORD='…' npm run seed:reviewer
 *
 * Reads NHOST_SUBDOMAIN, NHOST_REGION and HASURA_GRAPHQL_ADMIN_SECRET (or NHOST_ADMIN_SECRET) from the
 * environment or .env.deploy. Secrets and passwords are never printed.
 *
 * Optional: REVIEWER_EMAIL (default reviewer@crewup.app), REVIEWER_AIRLINE_CODE (default CX),
 * REVIEWER_BASE_IATA (default HKG).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    const value = line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(join(root, '.env.deploy'));
process.env.NHOST_ADMIN_SECRET ||= process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? '';

const { graphqlAsAdmin, nhostServiceUrl } = await import('../functions/_lib/graphql.ts');
const { GUIDELINES_VERSION } = await import('../functions/_shared/index.ts');

const REVIEWER_EMAIL = (process.env.REVIEWER_EMAIL || 'reviewer@crewup.app').toLowerCase();
const REVIEWER_PASSWORD = process.env.REVIEWER_PASSWORD ?? '';
const AIRLINE_CODE = process.env.REVIEWER_AIRLINE_CODE || 'CX';
const BASE_IATA = process.env.REVIEWER_BASE_IATA || 'HKG';

if (!process.env.NHOST_ADMIN_SECRET) {
  console.error('Set HASURA_GRAPHQL_ADMIN_SECRET (or NHOST_ADMIN_SECRET) in the environment or .env.deploy.');
  process.exit(1);
}
if (REVIEWER_PASSWORD.length < 9) {
  console.error('Set REVIEWER_PASSWORD (at least 9 characters). It is the password you give App Review.');
  process.exit(1);
}

const admin = (query, variables) => graphqlAsAdmin(query, variables, 'admin');

const DAY = 24 * 60 * 60 * 1000;
function at(daysFromNow, hourUtc) {
  const date = new Date(Date.now() + daysFromNow * DAY);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date.toISOString();
}

const PEOPLE = {
  reviewer: {
    email: REVIEWER_EMAIL,
    password: REVIEWER_PASSWORD,
    profile: {
      full_name: 'Alex Reviewer',
      preferred_name: 'Alex',
      username: 'alex_reviewer',
      date_of_birth: '1992-04-12',
      home_country_code: 'GB',
      hometown_city: 'Manchester',
      languages: ['en'],
      residence_country_code: 'HK',
      residence_city: 'Hong Kong',
      crew_role: 'cabin_crew',
    },
  },
  maya: {
    email: 'demo.maya@crewup.app',
    profile: {
      full_name: 'Maya Chen',
      preferred_name: 'Maya',
      username: 'maya_flies',
      date_of_birth: '1994-09-03',
      home_country_code: 'HK',
      hometown_city: 'Hong Kong',
      languages: ['en', 'zh'],
      residence_country_code: 'HK',
      residence_city: 'Hong Kong',
      crew_role: 'cabin_crew',
    },
  },
  kenji: {
    email: 'demo.kenji@crewup.app',
    profile: {
      full_name: 'Kenji Sato',
      preferred_name: 'Kenji',
      username: 'kenji_sato',
      date_of_birth: '1989-01-22',
      home_country_code: 'JP',
      hometown_city: 'Osaka',
      languages: ['en', 'ja'],
      residence_country_code: 'HK',
      residence_city: 'Hong Kong',
      crew_role: 'pilot',
    },
  },
};

async function findUserId(email) {
  const data = await admin(`query FindUser($email: citext!) { users(where: { email: { _eq: $email } }) { id } }`, { email });
  return data.users[0]?.id ?? null;
}

/** Signs up through Auth so the password is hashed the normal way, then marks the email verified. */
async function ensureUser(person) {
  let userId = await findUserId(person.email);
  let created = false;
  if (!userId) {
    const password = person.password ?? `${randomBytes(18).toString('base64url')}A1!`;
    const response = await fetch(`${nhostServiceUrl('auth')}/signup/email-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: person.email, password, options: { displayName: person.profile.preferred_name } }),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Sign-up for ${person.email} failed with status ${response.status}`);
    }
    userId = await findUserId(person.email);
    if (!userId) throw new Error(`Could not find ${person.email} after sign-up`);
    created = true;
  }
  await admin(
    `mutation VerifyEmail($id: uuid!, $name: String!) {
      updateUser(pk_columns: { id: $id }, _set: { emailVerified: true, disabled: false, displayName: $name }) { id }
    }`,
    { id: userId, name: person.profile.preferred_name },
  );
  return { userId, created };
}

async function crewReferences() {
  const data = await admin(
    `query CrewRefs($code: String!, $iata: String!) {
      airlines(where: { code: { _eq: $code }, is_active: { _eq: true } }) { id }
      fallback: airlines(where: { is_active: { _eq: true } }, order_by: { name: asc }, limit: 1) { id }
      airports_by_pk(iata: $iata) { iata }
    }`,
    { code: AIRLINE_CODE, iata: BASE_IATA },
  );
  const airlineId = data.airlines[0]?.id ?? data.fallback[0]?.id;
  if (!airlineId) throw new Error('No active airline found');
  if (!data.airports_by_pk) throw new Error(`Base airport ${BASE_IATA} is not in the airports table`);
  return { airlineId, baseIata: BASE_IATA };
}

/** Onboarded, verified and on the current guidelines, the same end state as finishing launched onboarding. */
async function completeAccount(userId, profile, refs) {
  const columns = {
    ...profile,
    display_name: profile.preferred_name,
    airline_id: refs.airlineId,
    base_airport_iata: refs.baseIata,
    default_visibility: 'all_verified',
  };
  await admin(
    `mutation UpsertProfile($object: profiles_insert_input!, $columns: [profiles_update_column!]!) {
      insert_profiles_one(object: $object, on_conflict: { constraint: profiles_pkey, update_columns: $columns }) { user_id }
    }`,
    { object: { user_id: userId, ...columns }, columns: Object.keys(columns) },
  );

  // onboarding_completed_at is write-once in Postgres, so it is only set while still empty.
  await admin(
    `mutation CompleteOnboarding($userId: uuid!, $version: String!) {
      insert_onboarding_state_one(object: { user_id: $userId }, on_conflict: { constraint: onboarding_state_pkey, update_columns: [] }) { user_id }
      done: update_onboarding_state(
        where: { user_id: { _eq: $userId }, onboarding_completed_at: { _is_null: true } }
        _set: { onboarding_completed_at: "now()" }
      ) { affected_rows }
      update_onboarding_state_by_pk(
        pk_columns: { user_id: $userId }
        _set: { current_step: null, guidelines_accepted_version: $version, guidelines_accepted_at: "now()" }
      ) { user_id }
    }`,
    { userId, version: GUIDELINES_VERSION },
  );

  const verified = await admin(
    `query Approved($userId: uuid!) {
      verifications(where: { user_id: { _eq: $userId }, status: { _eq: approved } }, limit: 1) { id }
    }`,
    { userId },
  );
  if (!verified.verifications.length) {
    await admin(
      `mutation Approve($userId: uuid!) {
        insert_verifications_one(
          object: { user_id: $userId, method: manual, status: approved, reviewed_at: "now()", notes: "demo reviewer seed" }
        ) { id }
      }`,
      { userId },
    );
  }

  // A pending deletion from an earlier review session would lock the account on the deletion screen.
  await admin(
    `mutation ClearDeletion($userId: uuid!) {
      update_account_deletions(
        where: { user_id: { _eq: $userId }, cancelled_at: { _is_null: true }, purged_at: { _is_null: true } }
        _set: { cancelled_at: "now()" }
      ) { affected_rows }
    }`,
    { userId },
  );
}

async function clearSeedContent(ids) {
  const all = Object.values(ids);
  await admin(
    `mutation ClearSeed($all: [uuid!]!, $hosts: [uuid!]!, $reviewer: uuid!, $maya: uuid!) {
      delete_user_trips(where: { user_id: { _in: $all } }) { affected_rows }
      delete_events(where: { creator_id: { _in: $hosts } }) { affected_rows }
      delete_threads(
        where: {
          type: { _eq: direct }
          _and: [{ participants: { user_id: { _eq: $reviewer } } }, { participants: { user_id: { _eq: $maya } } }]
        }
      ) { affected_rows }
      delete_user_blocks(where: { blocker_id: { _eq: $reviewer }, blocked_id: { _in: $hosts } }) { affected_rows }
    }`,
    { all, hosts: [ids.maya, ids.kenji], reviewer: ids.reviewer, maya: ids.maya },
  );
}

async function insertTrip(userId, title, stay) {
  const data = await admin(
    `mutation SeedTrip($object: user_trips_insert_input!) { insert_user_trips_one(object: $object) { id } }`,
    {
      object: {
        user_id: userId,
        title,
        source: 'manual',
        visibility: 'all_verified',
        starts_at: stay.starts_at,
        ends_at: stay.ends_at,
        stays: { data: [stay] },
      },
    },
  );
  return data.insert_user_trips_one.id;
}

/** Trip matching normally runs in client/trips/create; the seed writes both directions of a layover overlap. */
async function insertMatch(a, b, city, overlapStart, overlapEnd) {
  const row = (user, other) => ({
    user_id: user.userId,
    matched_user_id: other.userId,
    match_type: 'layover_overlap',
    score: 80,
    source_trip_id: user.tripId,
    matched_trip_id: other.tripId,
    city,
    overlap_start: overlapStart,
    overlap_end: overlapEnd,
  });
  await admin(`mutation SeedMatches($objects: [trip_matches_insert_input!]!) { insert_trip_matches(objects: $objects) { affected_rows } }`, {
    objects: [row(a, b), row(b, a)],
  });
}

async function insertDirectChat(reviewerId, mayaId) {
  const data = await admin(
    `mutation SeedDirect($thread: threads_insert_input!) { insert_threads_one(object: $thread) { id } }`,
    { thread: { type: 'direct', participants: { data: [{ user_id: reviewerId }, { user_id: mayaId }] } } },
  );
  const threadId = data.insert_threads_one.id;
  const messages = [
    [mayaId, "Hi Alex! Saw we're both in London on the same layover. Fancy a coffee near the hotel?"],
    [reviewerId, 'Sounds great. I land in the morning, free after a nap.'],
    [mayaId, "Perfect. I've also posted a crew meet by the river, join if you like!"],
  ];
  for (const [senderId, body] of messages) {
    await admin(`mutation SeedMessage($object: messages_insert_input!) { insert_messages_one(object: $object) { id } }`, {
      object: { thread_id: threadId, sender_id: senderId, body },
    });
  }
  return threadId;
}

async function insertMeet(hostId, guestIds, meet) {
  const data = await admin(
    `mutation SeedMeet($object: events_insert_input!) { insert_events_one(object: $object) { id } }`,
    { object: { creator_id: hostId, host_type: 'user', is_published: true, published_at: new Date().toISOString(), languages: ['en'], ...meet } },
  );
  const eventId = data.insert_events_one.id;
  const members = [hostId, ...guestIds];
  await admin(
    `mutation SeedMeetMembers($thread: threads_insert_input!, $attendees: [event_attendees_insert_input!]!) {
      insert_threads_one(object: $thread) { id }
      insert_event_attendees(objects: $attendees) { affected_rows }
    }`,
    {
      thread: { type: 'event_group', event_id: eventId, participants: { data: members.map((user_id) => ({ user_id })) } },
      attendees: members.map((user_id) => ({ event_id: eventId, user_id, status: 'going' })),
    },
  );
  return eventId;
}

async function main() {
  const refs = await crewReferences();
  const ids = {};
  for (const [key, person] of Object.entries(PEOPLE)) {
    const { userId, created } = await ensureUser(person);
    await completeAccount(userId, person.profile, refs);
    ids[key] = userId;
    console.log(`${created ? 'Created' : 'Updated'} ${person.email}`);
    if (key === 'reviewer' && !created) {
      console.log('  The reviewer account already existed, so its password was not changed.');
    }
  }

  await clearSeedContent(ids);

  const london = { city: 'LONDON', airport_iata: 'LHR', starts_at: at(5, 6), ends_at: at(7, 9) };
  const londonMaya = { city: 'LONDON', airport_iata: 'LHR', starts_at: at(5, 2), ends_at: at(6, 20) };
  const tokyo = { city: 'TOKYO', airport_iata: 'HND', starts_at: at(12, 4), ends_at: at(14, 3) };
  const tokyoKenji = { city: 'TOKYO', airport_iata: 'HND', starts_at: at(12, 8), ends_at: at(13, 22) };

  const reviewerLondon = await insertTrip(ids.reviewer, 'HKG → LHR', london);
  const reviewerTokyo = await insertTrip(ids.reviewer, 'HKG → HND', tokyo);
  const mayaLondon = await insertTrip(ids.maya, 'HKG → LHR', londonMaya);
  const kenjiTokyo = await insertTrip(ids.kenji, 'HKG → HND', tokyoKenji);

  await insertMatch({ userId: ids.reviewer, tripId: reviewerLondon }, { userId: ids.maya, tripId: mayaLondon }, 'LONDON', london.starts_at, londonMaya.ends_at);
  await insertMatch({ userId: ids.reviewer, tripId: reviewerTokyo }, { userId: ids.kenji, tripId: kenjiTokyo }, 'TOKYO', tokyoKenji.starts_at, tokyoKenji.ends_at);

  await insertDirectChat(ids.reviewer, ids.maya);

  await insertMeet(ids.maya, [ids.kenji], {
    title: 'Crew drinks by the river',
    description: 'Casual drinks for anyone on a London layover. Look for the CrewUp sticker on the table.',
    city: 'London',
    venue_name: 'The Riverside Terrace',
    venue_address: 'South Bank, London SE1',
    starts_at: at(6, 17),
    ends_at: at(6, 20),
    capacity: 12,
    visibility_scope: 'all_verified',
  });

  const privateMeetId = await insertMeet(ids.kenji, [ids.maya], {
    title: 'Ramen and karaoke (private)',
    description: 'Small group dinner in Kamata. Ask Kenji for the PIN, or use the one in the review notes.',
    city: 'Tokyo',
    venue_name: 'Kamata Ramen Alley',
    venue_address: 'Kamata, Ota City, Tokyo',
    starts_at: at(13, 10),
    ends_at: at(13, 13),
    capacity: 6,
    visibility_scope: 'friends',
  });
  const pin = await admin(`query MeetPin($id: uuid!) { event_access_codes_by_pk(event_id: $id) { pin } }`, { id: privateMeetId });

  console.log('\nDemo content ready:');
  console.log('  Trips: London (matches Maya) and Tokyo (matches Kenji)');
  console.log('  Direct chat with Maya Chen');
  console.log('  Public meet: "Crew drinks by the river" (London)');
  console.log(`  Private meet: "Ramen and karaoke (private)" (Tokyo), PIN ${pin.event_access_codes_by_pk?.pin ?? 'not generated'}`);
  console.log(`\nSign in as ${REVIEWER_EMAIL} with the REVIEWER_PASSWORD you set. Put the PIN in documentation/review-notes.md.`);
}

main().catch((error) => {
  console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
