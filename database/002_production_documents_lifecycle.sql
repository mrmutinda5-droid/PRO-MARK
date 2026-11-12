BEGIN;

ALTER TABLE learners ALTER COLUMN admission_no DROP NOT NULL;
ALTER TABLE learners ADD COLUMN IF NOT EXISTS passport_photo_url text;
ALTER TABLE learners ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE learners ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE learners ADD COLUMN IF NOT EXISTS status_changed_at timestamptz DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS uq_learner_admission_when_present ON learners(school_id,admission_no) WHERE admission_no IS NOT NULL AND btrim(admission_no) <> '';
UPDATE learners SET admission_no=NULL WHERE admission_no ILIKE 'LEGACY-%';

ALTER TABLE teachers ADD COLUMN IF NOT EXISTS signature_url text;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS signature_updated_at timestamptz;

ALTER TABLE school_identity ADD COLUMN IF NOT EXISTS watermark_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE terms ADD COLUMN IF NOT EXISTS opening_date date;
ALTER TABLE terms ADD COLUMN IF NOT EXISTS closing_date date;
UPDATE terms SET opening_date=COALESCE(opening_date,start_date), closing_date=COALESCE(closing_date,end_date);

CREATE TABLE IF NOT EXISTS school_document_assets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 asset_type text NOT NULL CHECK(asset_type IN ('STAMP','LOGO','WATERMARK')),
 file_url text NOT NULL, effective_from date NOT NULL DEFAULT CURRENT_DATE, effective_to date,
 is_active boolean NOT NULL DEFAULT true, created_by uuid REFERENCES users(id), created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_school_document_assets_effective ON school_document_assets(school_id,asset_type,effective_from DESC,is_active);

CREATE TABLE IF NOT EXISTS learner_movement_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE, academic_year_id uuid REFERENCES academic_years(id),
 from_class_id uuid REFERENCES classes(id), to_class_id uuid REFERENCES classes(id), event_type text NOT NULL,
 reason text, status text NOT NULL DEFAULT 'PENDING', requested_by uuid REFERENCES users(id), approved_by uuid REFERENCES users(id),
 effective_date date NOT NULL DEFAULT CURRENT_DATE, created_at timestamptz DEFAULT now(), approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_learner_movement ON learner_movement_events(school_id,learner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS parent_guardians(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 first_name text NOT NULL,last_name text NOT NULL,relationship text,phone text,email text,
 preferred_language text,communication_consent boolean NOT NULL DEFAULT true,sms_enabled boolean NOT NULL DEFAULT true,
 is_active boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learner_guardians(
 learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,parent_guardian_id uuid NOT NULL REFERENCES parent_guardians(id) ON DELETE CASCADE,
 is_primary boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now(),PRIMARY KEY(learner_id,parent_guardian_id)
);
CREATE INDEX IF NOT EXISTS idx_parent_guardians_school ON parent_guardians(school_id,phone);

CREATE TABLE IF NOT EXISTS school_announcements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 message text NOT NULL,is_scrolling boolean NOT NULL DEFAULT true,is_active boolean NOT NULL DEFAULT true,
 starts_at timestamptz DEFAULT now(),ends_at timestamptz,created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communication_messages(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 learner_id uuid REFERENCES learners(id) ON DELETE SET NULL,parent_guardian_id uuid REFERENCES parent_guardians(id) ON DELETE SET NULL,
 channel text NOT NULL DEFAULT 'SMS',message_type text NOT NULL,body text NOT NULL,status text NOT NULL DEFAULT 'QUEUED',
 provider text,provider_message_id text,failure_reason text,sent_at timestamptz,delivered_at timestamptz,created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_communication_school ON communication_messages(school_id,created_at DESC);

CREATE TABLE IF NOT EXISTS report_document_snapshots(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,academic_year_id uuid NOT NULL REFERENCES academic_years(id),term_id uuid REFERENCES terms(id),
 identity_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,asset_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz DEFAULT now(),
 UNIQUE(learner_id,academic_year_id,term_id)
);

COMMIT;
