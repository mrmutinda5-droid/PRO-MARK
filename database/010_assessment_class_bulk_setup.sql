-- Assessment class-wide setup support. Safe to run on existing databases.
BEGIN;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE CASCADE;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES subjects(id) ON DELETE CASCADE;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cat_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS final_conversion_weight numeric(6,2) DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_assessments_class_subject_period ON assessments(school_id,academic_year_id,term_id,class_id,subject_id);
COMMIT;
