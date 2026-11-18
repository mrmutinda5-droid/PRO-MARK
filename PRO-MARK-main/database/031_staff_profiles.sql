-- ZELIMU CBC: additive teacher profile details. Existing teachers are preserved.
CREATE TABLE IF NOT EXISTS public.teacher_staff_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
 teacher_id uuid NOT NULL UNIQUE REFERENCES public.teachers(id) ON DELETE CASCADE,
 phone text, designation text, department text, employment_type text,
 employment_date date, tsc_number text, qualifications text, notes text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teacher_staff_profiles_school ON public.teacher_staff_profiles(school_id);
