-- PRO-MARK 4.0.0 operational domains and Term 3 import repair
CREATE TABLE IF NOT EXISTS attendance_records(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,term_id uuid REFERENCES terms(id) ON DELETE SET NULL,
 attendance_date date NOT NULL,status text NOT NULL CHECK(status IN ('PRESENT','ABSENT','LATE','EXCUSED')),reason text,recorded_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(school_id,learner_id,attendance_date));
CREATE INDEX IF NOT EXISTS idx_attendance_school_period ON attendance_records(school_id,academic_year_id,term_id,class_id,attendance_date);
CREATE TABLE IF NOT EXISTS discipline_cases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,class_id uuid REFERENCES classes(id) ON DELETE SET NULL,
 case_date date NOT NULL DEFAULT CURRENT_DATE,title text NOT NULL,category text NOT NULL DEFAULT 'GENERAL',severity text NOT NULL DEFAULT 'LOW',description text DEFAULT '',action_taken text DEFAULT '',status text NOT NULL DEFAULT 'OPEN',reported_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_discipline_school_status ON discipline_cases(school_id,status,case_date DESC);
CREATE TABLE IF NOT EXISTS inventory_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,asset_code text,name text NOT NULL,category text NOT NULL DEFAULT 'GENERAL',unit text NOT NULL DEFAULT 'unit',quantity numeric(12,2) NOT NULL DEFAULT 0,unit_cost numeric(12,2) NOT NULL DEFAULT 0,location text DEFAULT '',condition_status text NOT NULL DEFAULT 'GOOD',notes text DEFAULT '',is_active boolean NOT NULL DEFAULT true,created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(school_id,asset_code));
CREATE INDEX IF NOT EXISTS idx_inventory_school_category ON inventory_items(school_id,category,is_active);
CREATE TABLE IF NOT EXISTS timetable_entries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,term_id uuid REFERENCES terms(id) ON DELETE SET NULL,class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,teacher_id uuid REFERENCES teachers(id) ON DELETE SET NULL,day_of_week int NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),start_time time NOT NULL,end_time time NOT NULL,room text DEFAULT '',notes text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_timetable_school_period ON timetable_entries(school_id,academic_year_id,term_id,class_id,day_of_week,start_time);
WITH candidates AS (
 SELECT m.id,op.id opener_id FROM marks m JOIN assessments ea ON ea.id=m.assessment_id JOIN terms et ON et.id=m.term_id
 JOIN LATERAL (SELECT oa.id FROM assessments oa WHERE oa.school_id=m.school_id AND oa.academic_year_id=m.academic_year_id AND oa.term_id=m.term_id AND oa.assessment_type='OPENER' AND (oa.class_id=m.class_id OR oa.class_id IS NULL) AND (oa.subject_id=m.subject_id OR oa.subject_id IS NULL) ORDER BY (oa.class_id IS NOT NULL) DESC,(oa.subject_id IS NOT NULL) DESC,oa.created_at LIMIT 1) op ON true
 WHERE et.term_no=3 AND ea.assessment_type='END_TERM' AND COALESCE(m.remark,'') ILIKE 'Imported from uploaded workbook%' AND NOT EXISTS(SELECT 1 FROM marks om WHERE om.learner_id=m.learner_id AND om.subject_id=m.subject_id AND om.assessment_id=op.id)
) UPDATE marks m SET assessment_id=c.opener_id,term_id=(SELECT term_id FROM assessments WHERE id=c.opener_id),updated_at=now(),remark='Imported from uploaded workbook · repaired as Term 3 Opener' FROM candidates c WHERE m.id=c.id;
