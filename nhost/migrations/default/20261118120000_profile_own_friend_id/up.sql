-- A Crew ID is only ever visible to its owner. Other crew connect by user id (Connect on a profile); the
-- add-by-Crew-ID lookup runs server-side as admin. The app reads its own ID through own_friend_id, and the
-- user role loses select on the friend_id column (metadata), so no query can return someone else's.

CREATE OR REPLACE FUNCTION public.profile_own_friend_id(profile public.profiles, hasura_session json)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN profile.user_id = NULLIF(hasura_session ->> 'x-hasura-user-id', '')::uuid THEN profile.friend_id
  END
$$;

COMMENT ON COLUMN public.profiles.friend_id IS
  'Crew ID for adding a friend. Owner-only via profile_own_friend_id; other crew never receive it.';
