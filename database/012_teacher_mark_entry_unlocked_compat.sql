-- PRO-MARK 3.9.6 teacher mark-entry compatibility
-- Safe/idempotent: preserves existing data.
ALTER TABLE teacher_subject_assignments ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE teacher_subject_assignments ADD COLUMN IF NOT EXISTS is_class_teacher boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_teacher_assignment_lookup ON teacher_subject_assignments(school_id,teacher_id,academic_year_id,class_id,subject_id,term_id);
ALTER TABLE marks ADD COLUMN IF NOT EXISTS school_id uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS learner_id uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS subject_id uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS class_id uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS academic_year_id uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS term_id uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS assessment_id uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS mark numeric(8,2);
ALTER TABLE marks ADD COLUMN IF NOT EXISTS entered_by uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS remark text;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE marks ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS uq_marks_learner_subject_assessment ON marks(learner_id,subject_id,assessment_id);
