-- Reverses the zh → yue rewrite. Also turns a Cantonese choice made after the migration back into zh.

UPDATE public.profiles AS profile
SET languages = array_replace(profile.languages, 'yue', 'zh')
WHERE profile.languages IS NOT NULL
  AND 'yue' = ANY (profile.languages);
