BEGIN;

ALTER TABLE result_publications
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE result_publications
  DROP CONSTRAINT IF EXISTS result_publications_status_check;

ALTER TABLE result_publications
  ADD CONSTRAINT result_publications_status_check
  CHECK (status IN ('PUBLISHED','WITHDRAWN'));

CREATE INDEX IF NOT EXISTS idx_result_publications_active_class_period
  ON result_publications(school_id,academic_year_id,term_id,created_at DESC)
  WHERE archived_at IS NULL;

COMMIT;
