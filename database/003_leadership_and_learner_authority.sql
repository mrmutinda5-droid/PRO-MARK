-- PRO-MARK 2.3: leadership roles and controlled learner removal
BEGIN;
DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'DEPUTY_HEADTEACHER';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE learner_movement_events
  ADD COLUMN IF NOT EXISTS action_note text;

CREATE INDEX IF NOT EXISTS idx_user_school_roles_school_role
  ON user_school_roles(school_id, role);
CREATE INDEX IF NOT EXISTS idx_learner_movement_school_status
  ON learner_movement_events(school_id, status, created_at DESC);
COMMIT;
