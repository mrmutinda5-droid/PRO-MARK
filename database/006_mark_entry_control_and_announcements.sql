-- PRO-MARK 3.3 — Mark-entry deadlines and controlled announcements
-- Safe additive migration. Do NOT recreate the database and do NOT rerun schema.sql.
-- Apply to the existing pro_mark database after migration 005.

CREATE TABLE IF NOT EXISTS mark_entry_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  opens_at timestamptz,
  deadline_at timestamptz,
  allow_teacher_corrections boolean NOT NULL DEFAULT true,
  allow_teacher_submit boolean NOT NULL DEFAULT true,
  lock_after_deadline boolean NOT NULL DEFAULT true,
  admin_override_allowed boolean NOT NULL DEFAULT true,
  owner_override_allowed boolean NOT NULL DEFAULT true,
  reopened_until timestamptz,
  reopened_by uuid REFERENCES users(id),
  notes text DEFAULT '',
  created_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id, academic_year_id, term_id),
  CHECK (deadline_at IS NULL OR opens_at IS NULL OR deadline_at >= opens_at),
  CHECK (reopened_until IS NULL OR deadline_at IS NULL OR reopened_until >= deadline_at)
);

CREATE INDEX IF NOT EXISTS idx_mark_entry_policy_school_term
  ON mark_entry_policies(school_id, academic_year_id, term_id);

CREATE TABLE IF NOT EXISTS portal_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid REFERENCES schools(id) ON DELETE CASCADE,
  audience text NOT NULL DEFAULT 'TEACHERS',
  title text NOT NULL,
  message text NOT NULL,
  voice_url text,
  show_on_login boolean NOT NULL DEFAULT false,
  require_acknowledgement boolean NOT NULL DEFAULT false,
  active_from timestamptz DEFAULT now(),
  active_until timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_announcements_audience
  ON portal_announcements(school_id, audience, active_from, active_until);

COMMENT ON TABLE mark_entry_policies IS
  'Admin-controlled mark-entry opening/deadline policy. Marks are not locked merely because they are submitted; lock occurs only when the configured deadline has passed unless an authorised override/reopen is active.';

COMMENT ON TABLE portal_announcements IS
  'Controlled school/teacher portal announcements. Voice files are referenced by voice_url so the existing document/file system can remain responsible for storage.';
