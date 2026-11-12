BEGIN;

CREATE TABLE IF NOT EXISTS result_publications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE RESTRICT,
  audience_scope text NOT NULL CHECK (audience_scope IN ('WHOLE_SCHOOL','SELECTED')),
  level_ids uuid[] NOT NULL DEFAULT '{}',
  class_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED')),
  learner_count integer NOT NULL DEFAULT 0 CHECK (learner_count >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_result_publications_school_period
  ON result_publications(school_id,academic_year_id,term_id,created_at DESC);

CREATE TABLE IF NOT EXISTS result_publication_records(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES result_publications(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE RESTRICT,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE RESTRICT,
  result_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(publication_id,learner_id),
  UNIQUE(school_id,learner_id,academic_year_id,term_id)
);

CREATE INDEX IF NOT EXISTS idx_result_publication_records_school_learner
  ON result_publication_records(school_id,learner_id,created_at DESC);

ALTER TABLE communication_messages
  ADD COLUMN IF NOT EXISTS result_publication_id uuid
    REFERENCES result_publications(id) ON DELETE SET NULL;
ALTER TABLE communication_messages
  ADD COLUMN IF NOT EXISTS result_publication_record_id uuid
    REFERENCES result_publication_records(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_published_result_notification_recipient
  ON communication_messages(result_publication_record_id,parent_guardian_id)
  WHERE result_publication_record_id IS NOT NULL
    AND parent_guardian_id IS NOT NULL
    AND message_type='PUBLISHED_RESULTS';

CREATE INDEX IF NOT EXISTS idx_published_result_notification_status
  ON communication_messages(result_publication_id,status,created_at DESC)
  WHERE result_publication_id IS NOT NULL;

COMMIT;
