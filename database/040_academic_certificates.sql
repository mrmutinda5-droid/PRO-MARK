-- Auditable academic certificates. Existing school leaving certificates stay in school_module_records.
BEGIN;

CREATE TABLE IF NOT EXISTS school_academic_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id uuid NOT NULL REFERENCES learners(id),
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  term_id uuid REFERENCES terms(id) ON DELETE SET NULL,
  certificate_no text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  achievement_statement text NOT NULL CHECK (length(btrim(achievement_statement)) BETWEEN 4 AND 1000),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','REVOKED')),
  issued_on date,
  created_by uuid NOT NULL REFERENCES users(id),
  issued_by uuid REFERENCES users(id),
  issued_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (certificate_no),
  UNIQUE (school_id, id),
  CHECK (term_id IS NULL OR academic_year_id IS NOT NULL),
  CHECK (status <> 'ISSUED' OR (issued_by IS NOT NULL AND issued_at IS NOT NULL AND issued_on IS NOT NULL)),
  CHECK (status <> 'REVOKED' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND length(btrim(COALESCE(revocation_reason,''))) >= 4))
);

CREATE INDEX IF NOT EXISTS school_academic_certificates_learner_idx
  ON school_academic_certificates(school_id, learner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS school_academic_certificates_status_idx
  ON school_academic_certificates(school_id, status, created_at DESC);

COMMIT;
