-- Preserve the exact certificate design and content at issue time.
BEGIN;

ALTER TABLE school_academic_certificates
  ADD COLUMN IF NOT EXISTS subject_or_activity text,
  ADD COLUMN IF NOT EXISTS achievement_date date,
  ADD COLUMN IF NOT EXISTS signer_name text,
  ADD COLUMN IF NOT EXISTS signer_title text,
  ADD COLUMN IF NOT EXISTS second_signer_name text,
  ADD COLUMN IF NOT EXISTS second_signer_title text,
  ADD COLUMN IF NOT EXISTS replaces_certificate_id uuid REFERENCES school_academic_certificates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_id text,
  ADD COLUMN IF NOT EXISTS snapshot jsonb,
  ADD COLUMN IF NOT EXISTS verification_token_hash text,
  ADD COLUMN IF NOT EXISTS verification_token_ciphertext text;

CREATE UNIQUE INDEX IF NOT EXISTS school_academic_certificates_verification_token_idx
  ON school_academic_certificates(verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS school_academic_certificates_replacement_idx
  ON school_academic_certificates(school_id,replaces_certificate_id)
  WHERE replaces_certificate_id IS NOT NULL;

COMMIT;
