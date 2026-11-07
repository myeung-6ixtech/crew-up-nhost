-- Activity groups: a row with no parent is a group; Dinner, Coffee, and every other tag point at one.
-- Events and profile preferences keep the same child ids.

ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.activities (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS activities_parent_id_idx ON public.activities (parent_id);

CREATE OR REPLACE FUNCTION public.activities_one_level()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.category := NEW.slug;
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'ACTIVITY_PARENT_SELF' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.activities p WHERE p.id = NEW.parent_id AND p.parent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ACTIVITY_PARENT_NOT_GROUP' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM public.activities c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'ACTIVITY_GROUP_HAS_CHILDREN' USING ERRCODE = 'P0001';
  END IF;
  NEW.category := (SELECT p.slug FROM public.activities p WHERE p.id = NEW.parent_id);
  RETURN NEW;
END;
$$;

INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active)
SELECT groups.slug, groups.name, groups.slug, groups.sort_order, 'activity', true
FROM (VALUES
  ('food_drink', 'Food & drink', 10),
  ('outdoors', 'Outdoors', 20),
  ('nightlife', 'Nightlife', 30),
  ('wellness', 'Wellness', 40),
  ('culture', 'Culture', 50),
  ('general', 'General', 60)
) AS groups (slug, name, sort_order)
WHERE groups.slug IN (SELECT DISTINCT category FROM public.activities)
   OR groups.slug = 'general'
ON CONFLICT (slug) DO NOTHING;

-- A category outside the known list still gets a group, named after its key.
INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active)
SELECT DISTINCT a.category, initcap(replace(a.category, '_', ' ')), a.category, 900, 'activity', true
FROM public.activities a
WHERE a.category ~ '^[a-z0-9_]+$'
  AND NOT EXISTS (SELECT 1 FROM public.activities g WHERE g.slug = a.category)
ON CONFLICT (slug) DO NOTHING;

UPDATE public.activities AS child
SET parent_id = parent.id
FROM public.activities AS parent
WHERE parent.slug = child.category
  AND parent.id <> child.id
  AND child.parent_id IS NULL
  AND child.slug <> child.category;

UPDATE public.activities AS child
SET parent_id = (SELECT id FROM public.activities WHERE slug = 'general')
WHERE child.parent_id IS NULL
  AND child.slug <> child.category;

DROP TRIGGER IF EXISTS activities_one_level ON public.activities;
CREATE TRIGGER activities_one_level
  BEFORE INSERT OR UPDATE OF parent_id, category, slug ON public.activities
  FOR EACH ROW
  EXECUTE FUNCTION public.activities_one_level();

CREATE OR REPLACE FUNCTION public.activity_link_not_group()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.activities a WHERE a.id = NEW.activity_id AND a.parent_id IS NULL) THEN
    RAISE EXCEPTION 'ACTIVITY_IS_GROUP' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS event_activities_not_group ON public.event_activities;
CREATE TRIGGER event_activities_not_group
  BEFORE INSERT OR UPDATE OF activity_id ON public.event_activities
  FOR EACH ROW
  EXECUTE FUNCTION public.activity_link_not_group();

DROP TRIGGER IF EXISTS profile_activity_preferences_not_group ON public.profile_activity_preferences;
CREATE TRIGGER profile_activity_preferences_not_group
  BEFORE INSERT OR UPDATE OF activity_id ON public.profile_activity_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.activity_link_not_group();

COMMENT ON COLUMN public.activities.parent_id IS
  'Group this activity belongs to. Null means the row is a group. One level only; events attach children.';
COMMENT ON COLUMN public.activities.category IS
  'Slug of the parent group, kept in sync by activities_one_level. Groups hold their own slug.';
