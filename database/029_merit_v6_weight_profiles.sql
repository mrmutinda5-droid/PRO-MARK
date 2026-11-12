-- ZELIMU V6: additive, tenant-scoped weighting profiles. Run after review and backup.
-- class_id NULL means school default; class_id set means a class-specific override.
CREATE TABLE IF NOT EXISTS merit_weight_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
 term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
 class_id uuid REFERENCES classes(id) ON DELETE CASCADE,
 weights jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT merit_weight_profiles_weights_array CHECK (jsonb_typeof(weights)='array')
);
CREATE UNIQUE INDEX IF NOT EXISTS merit_weight_profiles_school_default_uq
 ON merit_weight_profiles(school_id,academic_year_id,term_id) WHERE class_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS merit_weight_profiles_class_uq
 ON merit_weight_profiles(school_id,academic_year_id,term_id,class_id) WHERE class_id IS NOT NULL;
