-- Run once in Supabase SQL Editor before using Flexible Merit.
CREATE TABLE IF NOT EXISTS public.merit_flex_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid NOT NULL REFERENCES public.schools(id),
 academic_year_id uuid NOT NULL REFERENCES public.academic_years(id),
 term_id uuid NOT NULL REFERENCES public.terms(id),
 class_id uuid NOT NULL REFERENCES public.classes(id),
 selected_assessment_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(selected_assessment_ids)='array'),
 cat_group_mode text NOT NULL DEFAULT 'CAT_GROUP' CHECK(cat_group_mode IN ('CAT_GROUP','INDIVIDUAL')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(school_id,academic_year_id,term_id,class_id)
);
