-- Starter blocklist: slurs and explicit sexual terms in the launch languages. Staff extend it in crew-up-admin
-- (Moderation → Blocked words). Kept in a migration rather than nhost/seeds because seeds don't run on Nhost Cloud.
-- Terms are normalized by the moderation_terms_normalize trigger, so write them plainly.

INSERT INTO public.moderation_terms (term, lang) VALUES
  -- English: slurs
  ('nigger', 'en'), ('niggers', 'en'), ('nigga', 'en'), ('niggas', 'en'),
  ('faggot', 'en'), ('faggots', 'en'),
  ('tranny', 'en'), ('trannies', 'en'),
  ('gook', 'en'), ('gooks', 'en'),
  ('spic', 'en'), ('spics', 'en'), ('wetback', 'en'), ('wetbacks', 'en'),
  ('kike', 'en'), ('kikes', 'en'), ('paki', 'en'), ('pakis', 'en'),
  ('raghead', 'en'), ('towelhead', 'en'), ('coon', 'en'), ('coons', 'en'),
  ('jap', 'en'), ('japs', 'en'),
  -- English: explicit sexual and abusive
  ('cunt', 'en'), ('cunts', 'en'), ('whore', 'en'), ('whores', 'en'),
  ('slut', 'en'), ('sluts', 'en'), ('motherfucker', 'en'), ('motherfuckers', 'en'),
  ('blowjob', 'en'), ('handjob', 'en'), ('cumshot', 'en'), ('gangbang', 'en'),
  ('rape you', 'en'), ('kill yourself', 'en'), ('kys', 'en'),
  ('send nudes', 'en'), ('nudes for', 'en'), ('dick pic', 'en'), ('dick pics', 'en'),
  ('child porn', 'en'), ('cp for sale', 'en'),
  -- Spanish
  ('maricon', 'es'), ('maricones', 'es'), ('puta', 'es'), ('putas', 'es'),
  ('sudaca', 'es'), ('negrata', 'es'), ('hijo de puta', 'es'),
  -- French
  ('salope', 'fr'), ('salopes', 'fr'),
  ('bougnoule', 'fr'), ('youpin', 'fr'), ('enculé', 'fr'), ('nique ta mere', 'fr'),
  -- German
  ('kanake', 'de'), ('kanaken', 'de'), ('schwuchtel', 'de'), ('fotze', 'de'), ('neger', 'de'),
  -- Portuguese
  ('viado', 'pt'), ('buceta', 'pt'), ('vadia', 'pt'), ('filho da puta', 'pt'),
  -- Italian
  ('frocio', 'it'), ('negro di merda', 'it'),
  -- Japanese / Chinese / Korean (substring match)
  ('ガイジ', 'ja'), ('死ね', 'ja'),
  ('婊子', 'zh'), ('傻逼', 'zh'), ('操你妈', 'zh'), ('支那', 'zh'),
  ('병신', 'ko'), ('씨발', 'ko'), ('개새끼', 'ko')
ON CONFLICT (term) DO NOTHING;
