-- ZELIMU CBC non-teaching staff: additive, no data deletion.
CREATE TABLE IF NOT EXISTS public.non_teaching_staff (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
 staff_no text NOT NULL,
 first_name text NOT NULL,
 last_name text NOT NULL,
 email text,
 phone text,
 designation text NOT NULL,
 department text,
 employment_type text,
 employment_date date,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(school_id,staff_no)
);
CREATE INDEX IF NOT EXISTS idx_non_teaching_staff_school ON public.non_teaching_staff(school_id);
