-- Spoken Chinese was stored as the generic code zh. Cantonese is yue; Mandarin is cmn.
-- Existing zh values become Cantonese. People who speak Mandarin add cmn themselves.

UPDATE public.profiles AS profile
SET languages = (
  SELECT COALESCE(array_agg(code ORDER BY ord), ARRAY[]::text[])
  FROM (
    SELECT code, min(ord) AS ord
    FROM unnest(array_replace(profile.languages, 'zh', 'yue')) WITH ORDINALITY AS item(code, ord)
    GROUP BY code
  ) AS unique_codes
)
WHERE profile.languages IS NOT NULL
  AND 'zh' = ANY (profile.languages);
