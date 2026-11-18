-- Issue, verify, replace and audit school-scoped learner ID cards.
BEGIN;

CREATE TABLE IF NOT EXISTS school_learner_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  card_reference text NOT NULL,
  verification_token_hash text NOT NULL UNIQUE,
  verification_token_ciphertext text NOT NULL,
  template_id text NOT NULL CHECK (template_id IN ('classic','modern','academic')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REPLACED','REVOKED')),
  snapshot jsonb NOT NULL,
  replaced_by uuid REFERENCES school_learner_cards(id) ON DELETE SET NULL,
  issued_by uuid REFERENCES users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id,id),
  UNIQUE (school_id,card_reference)
);

CREATE UNIQUE INDEX IF NOT EXISTS school_learner_cards_one_active_idx
  ON school_learner_cards(school_id,learner_id) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS school_learner_cards_scope_idx
  ON school_learner_cards(school_id,learner_id,issued_at DESC);

COMMIT;
