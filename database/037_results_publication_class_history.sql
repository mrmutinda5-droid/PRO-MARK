BEGIN;

ALTER TABLE result_publication_records
  ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE SET NULL;

UPDATE result_publication_records r
SET class_id=e.class_id
FROM learner_enrollments e
WHERE r.class_id IS NULL
  AND e.school_id=r.school_id
  AND e.learner_id=r.learner_id
  AND e.academic_year_id=r.academic_year_id;

CREATE INDEX IF NOT EXISTS idx_result_publication_records_class_period
  ON result_publication_records(school_id,class_id,academic_year_id,term_id,created_at DESC);

COMMIT;
