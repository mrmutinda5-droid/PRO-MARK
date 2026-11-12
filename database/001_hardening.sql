BEGIN;

-- Context-aware grading/assessment configuration.
ALTER TABLE assessment_configurations
  ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES subjects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_assessment_config_context
  ON assessment_configurations(school_id,section_id,level_id,assessment_id,subject_id);

-- Historical identity snapshot support. Existing reports remain tied to their academic year/term.
ALTER TABLE academic_years
  ADD COLUMN IF NOT EXISTS identity_snapshot jsonb DEFAULT '{}'::jsonb;

-- Safer audit metadata.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS ip_address inet;
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS user_agent text;

-- Prevent duplicate active assignment rows for the same teaching context.
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_assignment_context
ON teacher_subject_assignments(teacher_id,subject_id,class_id,academic_year_id,COALESCE(term_id,'00000000-0000-0000-0000-000000000000'::uuid));

-- Seed report-template defaults for every newly created school through application code.
COMMIT;

BEGIN;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_teachers_user ON teachers(user_id);

CREATE TABLE IF NOT EXISTS class_teacher_assignments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
 class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
 term_id uuid REFERENCES terms(id) ON DELETE CASCADE,
 created_at timestamptz DEFAULT now(),
 UNIQUE(school_id,teacher_id,class_id,academic_year_id,term_id)
);
CREATE INDEX IF NOT EXISTS idx_class_teacher_context ON class_teacher_assignments(school_id,academic_year_id,term_id,class_id);

CREATE TABLE IF NOT EXISTS learner_enrollments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
 class_id uuid NOT NULL REFERENCES classes(id),
 previous_class_id uuid REFERENCES classes(id),
 status text DEFAULT 'ACTIVE',
 enrolled_at timestamptz DEFAULT now(),
 ended_at timestamptz,
 UNIQUE(learner_id,academic_year_id)
);
CREATE INDEX IF NOT EXISTS idx_enrollment_context ON learner_enrollments(school_id,academic_year_id,class_id);

CREATE TABLE IF NOT EXISTS migration_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 school_id uuid REFERENCES schools(id) ON DELETE SET NULL,
 source_name text NOT NULL,
 mode text NOT NULL,
 status text NOT NULL,
 started_at timestamptz DEFAULT now(),
 completed_at timestamptz,
 counts jsonb DEFAULT '{}'::jsonb,
 errors jsonb DEFAULT '[]'::jsonb
);

COMMIT;
