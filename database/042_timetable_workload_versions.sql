-- Persist teacher workload limits and retain immutable published timetable versions.
BEGIN;

CREATE TABLE IF NOT EXISTS timetable_teacher_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  max_daily_periods integer,
  max_weekly_periods integer,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, academic_year_id, term_id, teacher_id),
  CHECK (max_daily_periods IS NULL OR max_daily_periods BETWEEN 1 AND 12),
  CHECK (max_weekly_periods IS NULL OR max_weekly_periods BETWEEN 1 AND 84),
  CHECK (max_daily_periods IS NOT NULL OR max_weekly_periods IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS timetable_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','ARCHIVED')),
  snapshot jsonb NOT NULL,
  published_by uuid REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, academic_year_id, term_id, version_number)
);

CREATE INDEX IF NOT EXISTS timetable_teacher_limits_scope_idx
  ON timetable_teacher_limits(school_id, academic_year_id, term_id);
CREATE INDEX IF NOT EXISTS timetable_versions_scope_idx
  ON timetable_versions(school_id, academic_year_id, term_id, version_number DESC);

COMMIT;
