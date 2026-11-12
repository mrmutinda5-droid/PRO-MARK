-- Allow publishing the SAME learner's results once per assessment (e.g. Opener,
-- Midterm, Endterm) instead of once per term. Term-level publishing keeps working;
-- its assessment_id stays NULL.
BEGIN;

ALTER TABLE result_publications
  ADD COLUMN IF NOT EXISTS assessment_id uuid REFERENCES assessments(id) ON DELETE RESTRICT;
ALTER TABLE result_publication_records
  ADD COLUMN IF NOT EXISTS assessment_id uuid REFERENCES assessments(id) ON DELETE RESTRICT;
ALTER TABLE communication_messages
  ADD COLUMN IF NOT EXISTS assessment_id uuid REFERENCES assessments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_result_publications_assessment
  ON result_publications(school_id,assessment_id) WHERE assessment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_result_publication_records_assessment
  ON result_publication_records(school_id,assessment_id) WHERE assessment_id IS NOT NULL;

-- Replace the once-per-term safeguard with once-per-assessment (NULL = whole term).
DROP INDEX IF EXISTS uq_comm_published_results_once;
CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_published_results_once
  ON communication_messages(
    school_id,learner_id,parent_guardian_id,academic_year_id,term_id,message_type,
    COALESCE(assessment_id,'00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE message_type='PUBLISHED_RESULTS'
    AND academic_year_id IS NOT NULL
    AND term_id IS NOT NULL;

-- Drop the old unique(learner, year, term) constraint whatever its generated name is.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='result_publication_records'::regclass AND contype='u'
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(conkey) WITH ORDINALITY AS k(attnum,ord)
           JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.attnum)
          = ARRAY['school_id','learner_id','academic_year_id','term_id']
  LOOP
    EXECUTE format('ALTER TABLE result_publication_records DROP CONSTRAINT %I',c.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_result_publication_records_period
  ON result_publication_records(
    school_id,learner_id,academic_year_id,term_id,
    COALESCE(assessment_id,'00000000-0000-0000-0000-000000000000'::uuid)
  );

COMMIT;
