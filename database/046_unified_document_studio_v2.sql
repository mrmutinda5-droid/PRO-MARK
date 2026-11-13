-- 046_unified_document_studio_v2.sql
-- Safe, idempotent, self-contained migration: works whether 040–045 were previously applied or not.

CREATE TABLE IF NOT EXISTS school_academic_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  term_id uuid REFERENCES terms(id) ON DELETE SET NULL,
  certificate_no text NOT NULL UNIQUE,
  title text NOT NULL,
  achievement_statement text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'REVOKED')),
  verification_token_hash text UNIQUE,
  verification_token_ciphertext text,
  issued_by uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revocation_reason text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE school_academic_certificates
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'ACADEMIC_ACHIEVEMENT',
  ADD COLUMN IF NOT EXISTS subject_or_activity text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS achievement_date date,
  ADD COLUMN IF NOT EXISTS signer_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS signer_title text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS second_signer_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS second_signer_title text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS replaces_certificate_id uuid REFERENCES school_academic_certificates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_id text NOT NULL DEFAULT 'classic';

CREATE INDEX IF NOT EXISTS school_academic_certificates_school_idx
  ON school_academic_certificates(school_id, status, issued_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS school_academic_certificates_learner_idx
  ON school_academic_certificates(learner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS school_academic_certificates_category_idx
  ON school_academic_certificates(school_id, category, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS school_academic_certificates_replacement_idx
  ON school_academic_certificates(school_id, replaces_certificate_id)
  WHERE replaces_certificate_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS school_document_template_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('ID_CARD', 'CERTIFICATE')),
  category text NOT NULL DEFAULT 'DEFAULT',
  template_id text NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, document_type, category)
);

CREATE INDEX IF NOT EXISTS school_doc_template_prefs_school_idx
  ON school_document_template_preferences(school_id, document_type);

CREATE TABLE IF NOT EXISTS school_learner_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id uuid REFERENCES learners(id) ON DELETE CASCADE,
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  card_reference text NOT NULL UNIQUE,
  verification_token_hash text NOT NULL UNIQUE,
  verification_token_ciphertext text NOT NULL,
  template_id text NOT NULL DEFAULT 'classic',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REPLACED', 'REVOKED')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  replaced_by uuid REFERENCES school_learner_cards(id) ON DELETE SET NULL,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revocation_reason text,
  issued_by uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS school_learner_cards_one_active_idx
  ON school_learner_cards(school_id, learner_id)
  WHERE status = 'ACTIVE' AND learner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS school_learner_cards_school_idx
  ON school_learner_cards(school_id, status, issued_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS school_snapshot_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  sha256_hash text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  asset_bytes bytea NOT NULL,
  byte_size integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, sha256_hash)
);

CREATE INDEX IF NOT EXISTS school_snapshot_assets_school_idx
  ON school_snapshot_assets(school_id, created_at DESC);

CREATE TABLE IF NOT EXISTS school_document_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid REFERENCES schools(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  default_title text NOT NULL,
  default_statement text NOT NULL DEFAULT '',
  is_leaving boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS school_doc_categories_scope_uq
  ON school_document_categories (
    COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid),
    upper(code)
  );

INSERT INTO school_document_categories (school_id, code, label, default_title, default_statement, is_leaving, sort_order)
VALUES
  (NULL, 'ACADEMIC_ACHIEVEMENT', 'Academic Achievement', 'Certificate of Academic Achievement', 'For outstanding academic performance and dedication to excellence.', false, 10),
  (NULL, 'SUBJECT_PERFORMANCE',  'Subject Performance',  'Subject Champion Certificate',       'For distinguished achievement in the named learning area.', false, 20),
  (NULL, 'MOST_IMPROVED',        'Most Improved',        'Certificate of Academic Progress',   'For remarkable improvement, diligence, and steady progress.', false, 30),
  (NULL, 'COMPLETION',           'Completion',           'Certificate of Completion',          'For successfully completing the prescribed learning programme.', false, 40),
  (NULL, 'CO_CURRICULAR',        'Co-Curricular',        'Co-Curricular Excellence Award',     'For commendable leadership and contribution in school activities.', false, 50),
  (NULL, 'SPORTS',               'Sports',               'Sports Achievement Certificate',     'For sportsmanship, teamwork, and excellence in athletics and games.', false, 60),
  (NULL, 'SCHOOL_RECOGNITION',   'School Recognition',   'Certificate of Recognition',         'In appreciation of exemplary character, service, and conduct.', false, 70),
  (NULL, 'SCHOOL_LEAVING',       'School Leaving',       'School Leaving Certificate',         'This is to certify that the named learner attended this institution as recorded below.', true, 80),
  (NULL, 'LEADERSHIP',           'Leadership',           'Certificate of Leadership',          'For exemplary service and responsibility in student leadership.', false, 90),
  (NULL, 'CONDUCT',              'Good Conduct',         'Certificate of Good Conduct',        'For upholding high standards of discipline, respect, and integrity.', false, 100)
ON CONFLICT DO NOTHING;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname, conrelid::regclass AS tbl
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN (
        to_regclass('public.school_academic_certificates'),
        to_regclass('public.school_learner_cards'),
        to_regclass('public.school_document_template_preferences')
      )
      AND (
        pg_get_constraintdef(oid) ILIKE '%category%'
        OR pg_get_constraintdef(oid) ILIKE '%template_id%'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE school_learner_cards
  ALTER COLUMN learner_id DROP NOT NULL;

ALTER TABLE school_learner_cards
  ADD COLUMN IF NOT EXISTS card_type text NOT NULL DEFAULT 'LEARNER',
  ADD COLUMN IF NOT EXISTS teacher_id uuid REFERENCES teachers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS valid_from date,
  ADD COLUMN IF NOT EXISTS valid_until date,
  ADD COLUMN IF NOT EXISTS key_version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'school_cards_holder_type_chk') THEN
    ALTER TABLE school_learner_cards
      ADD CONSTRAINT school_cards_holder_type_chk
      CHECK (
        (card_type = 'LEARNER' AND learner_id IS NOT NULL AND teacher_id IS NULL)
        OR (card_type = 'STAFF' AND teacher_id IS NOT NULL AND learner_id IS NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS school_staff_cards_one_active_idx
  ON school_learner_cards(school_id, teacher_id)
  WHERE status = 'ACTIVE' AND teacher_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS school_cards_expiry_idx
  ON school_learner_cards(school_id, valid_until)
  WHERE status = 'ACTIVE';

ALTER TABLE school_academic_certificates
  ADD COLUMN IF NOT EXISTS signer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS second_signer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assessment_id uuid REFERENCES assessments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES subjects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS key_version integer NOT NULL DEFAULT 1;

ALTER TABLE school_document_template_preferences
  ADD COLUMN IF NOT EXISTS layout_options jsonb NOT NULL DEFAULT '{}'::jsonb;
