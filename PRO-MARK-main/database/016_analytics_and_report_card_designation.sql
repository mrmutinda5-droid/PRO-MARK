-- PRO-MARK 3.9.14: configurable report-card designation / promotion decision.
-- This migration is additive and safe to run after the existing compatibility migrations.

CREATE TABLE IF NOT EXISTS report_card_designations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  designation varchar(40) NOT NULL DEFAULT 'AUTO',
  decision varchar(40) NOT NULL DEFAULT 'AUTO',
  attendance_days integer,
  school_open_days integer,
  conduct varchar(40),
  effort varchar(40),
  next_term_target numeric(5,2),
  intervention_plan text,
  teacher_comment text,
  headteacher_comment text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_card_designations_unique UNIQUE (learner_id, academic_year_id, term_id),
  CONSTRAINT report_card_designations_designation_check CHECK (designation IN ('AUTO','DISTINCTION','MERIT','CREDIT','PASS','DEVELOPING','AT_RISK','INCOMPLETE')),
  CONSTRAINT report_card_designations_decision_check CHECK (decision IN ('AUTO','PROMOTED','PROCEED','REPEAT','REVIEW','GRADUATED')),
  CONSTRAINT report_card_designations_attendance_check CHECK (attendance_days IS NULL OR attendance_days >= 0),
  CONSTRAINT report_card_designations_open_days_check CHECK (school_open_days IS NULL OR school_open_days >= 0),
  CONSTRAINT report_card_designations_target_check CHECK (next_term_target IS NULL OR (next_term_target >= 0 AND next_term_target <= 100))
);

CREATE INDEX IF NOT EXISTS report_card_designations_school_context_idx
  ON report_card_designations(school_id, academic_year_id, term_id);

