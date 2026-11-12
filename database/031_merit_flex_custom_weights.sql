-- ZELIMU CBC Flexible Merit custom weights. Run once after migration 030.
ALTER TABLE public.merit_flex_profiles
  ADD COLUMN IF NOT EXISTS custom_weights jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.merit_flex_profiles
  DROP CONSTRAINT IF EXISTS merit_flex_profiles_cat_group_mode_check;
ALTER TABLE public.merit_flex_profiles
  ADD CONSTRAINT merit_flex_profiles_cat_group_mode_check
  CHECK (cat_group_mode IN ('CAT_GROUP','INDIVIDUAL','CUSTOM'));
