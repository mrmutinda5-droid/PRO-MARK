BEGIN;
ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL;
ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS term_id uuid REFERENCES terms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_comm_results_context ON communication_messages(school_id,learner_id,parent_guardian_id,message_type,academic_year_id,term_id);
-- Clean only duplicate published-result records before adding the protection index.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY school_id,learner_id,parent_guardian_id,academic_year_id,term_id,message_type ORDER BY created_at DESC NULLS LAST,id DESC) rn
  FROM communication_messages
  WHERE message_type='PUBLISHED_RESULTS'
    AND academic_year_id IS NOT NULL
    AND term_id IS NOT NULL
)
DELETE FROM communication_messages cm USING ranked r WHERE cm.id=r.id AND r.rn>1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_published_results_once ON communication_messages(school_id,learner_id,parent_guardian_id,academic_year_id,term_id,message_type) WHERE message_type='PUBLISHED_RESULTS' AND academic_year_id IS NOT NULL AND term_id IS NOT NULL;
COMMIT;
