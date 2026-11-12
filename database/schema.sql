CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN CREATE TYPE school_status AS ENUM ('ACTIVE','SUSPENDED','ARCHIVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE year_status AS ENUM ('PLANNED','ACTIVE','CLOSED','ARCHIVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS school_templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text UNIQUE NOT NULL,name text NOT NULL,description text NOT NULL,is_system boolean DEFAULT true,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS template_sections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),template_id uuid REFERENCES school_templates(id) ON DELETE CASCADE,code text NOT NULL,name text NOT NULL,sort_order int NOT NULL,UNIQUE(template_id,code));
CREATE TABLE IF NOT EXISTS template_levels(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),template_section_id uuid REFERENCES template_sections(id) ON DELETE CASCADE,code text NOT NULL,name text NOT NULL,sort_order int NOT NULL,UNIQUE(template_section_id,code));

CREATE TABLE IF NOT EXISTS schools(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text UNIQUE NOT NULL,name text NOT NULL,template_id uuid REFERENCES school_templates(id),status school_status DEFAULT 'ACTIVE',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS school_identity(school_id uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,logo_url text,motto text DEFAULT '',primary_color text DEFAULT '#17365D',secondary_color text DEFAULT '#D9A441',address text,contact_phone text,contact_email text,updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS school_sections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,template_section_id uuid REFERENCES template_sections(id),code text,name text,sort_order int,is_active boolean DEFAULT true,UNIQUE(school_id,code));
CREATE TABLE IF NOT EXISTS school_levels(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_section_id uuid REFERENCES school_sections(id) ON DELETE CASCADE,template_level_id uuid REFERENCES template_levels(id),code text,name text,sort_order int,is_active boolean DEFAULT true,UNIQUE(school_section_id,code));

CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text UNIQUE NOT NULL,password_hash text NOT NULL,first_name text DEFAULT '',last_name text DEFAULT '',is_active boolean DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS user_school_roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES users(id) ON DELETE CASCADE,school_id uuid REFERENCES schools(id) ON DELETE CASCADE,role user_role NOT NULL,mark_entry_enabled boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT now(),CHECK((role='PLATFORM_OWNER' AND school_id IS NULL) OR (role<>'PLATFORM_OWNER' AND school_id IS NOT NULL)),UNIQUE(user_id,school_id,role));

CREATE TABLE IF NOT EXISTS academic_years(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,year_label text NOT NULL,start_date date,end_date date,status year_status DEFAULT 'PLANNED',created_at timestamptz DEFAULT now(),UNIQUE(school_id,year_label));
CREATE TABLE IF NOT EXISTS terms(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,term_no int CHECK(term_no between 1 and 3),name text NOT NULL,start_date date,end_date date,status text DEFAULT 'PLANNED',reopening_date date,UNIQUE(academic_year_id,term_no));

CREATE TABLE IF NOT EXISTS teachers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,staff_no text NOT NULL,first_name text NOT NULL,last_name text NOT NULL,email text,is_active boolean DEFAULT true,created_at timestamptz DEFAULT now(),UNIQUE(school_id,staff_no));
CREATE TABLE IF NOT EXISTS classes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,school_level_id uuid REFERENCES school_levels(id),name text NOT NULL,stream text DEFAULT '',is_active boolean DEFAULT true,UNIQUE(school_id,name,stream));
CREATE TABLE IF NOT EXISTS learners(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,admission_no text NOT NULL,first_name text NOT NULL,middle_name text DEFAULT '',last_name text NOT NULL,date_of_birth date,gender text,class_id uuid REFERENCES classes(id),is_active boolean DEFAULT true,created_at timestamptz DEFAULT now(),UNIQUE(school_id,admission_no));
CREATE TABLE IF NOT EXISTS subjects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,code text NOT NULL,name text NOT NULL,subject_type text DEFAULT 'LEARNING_AREA',is_active boolean DEFAULT true,UNIQUE(school_id,code));

CREATE TABLE IF NOT EXISTS teacher_subject_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,teacher_id uuid REFERENCES teachers(id),subject_id uuid REFERENCES subjects(id),class_id uuid REFERENCES classes(id),academic_year_id uuid REFERENCES academic_years(id),term_id uuid REFERENCES terms(id),is_class_teacher boolean DEFAULT false,created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS assessments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,academic_year_id uuid REFERENCES academic_years(id),term_id uuid REFERENCES terms(id),name text NOT NULL,assessment_type text NOT NULL,max_mark numeric(6,2) DEFAULT 100,weight numeric(6,2) DEFAULT 0,include_in_final boolean DEFAULT true,combine_group text,assessment_order int DEFAULT 0,status text DEFAULT 'OPEN',class_id uuid REFERENCES classes(id) ON DELETE CASCADE,subject_id uuid REFERENCES subjects(id) ON DELETE CASCADE,cat_enabled boolean NOT NULL DEFAULT false,final_conversion_weight numeric(6,2) DEFAULT 0,deadline_at timestamptz,published_at timestamptz,published_by uuid REFERENCES users(id),submitted_at timestamptz,submitted_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS marks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,learner_id uuid REFERENCES learners(id) ON DELETE CASCADE,subject_id uuid REFERENCES subjects(id),class_id uuid REFERENCES classes(id),academic_year_id uuid REFERENCES academic_years(id),term_id uuid REFERENCES terms(id),assessment_id uuid REFERENCES assessments(id),mark numeric(8,2),entered_by uuid REFERENCES users(id),remark text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(learner_id,subject_id,assessment_id));

CREATE TABLE IF NOT EXISTS grading_systems(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,name text NOT NULL,code text NOT NULL,description text DEFAULT '',is_active boolean DEFAULT true,UNIQUE(school_id,code));
CREATE TABLE IF NOT EXISTS grading_bands(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),grading_system_id uuid REFERENCES grading_systems(id) ON DELETE CASCADE,label text NOT NULL,min_mark numeric(6,2) NOT NULL,max_mark numeric(6,2) NOT NULL,points numeric(6,2) DEFAULT 0,descriptor text DEFAULT '',remark text DEFAULT '',CHECK(min_mark<=max_mark));

CREATE TABLE IF NOT EXISTS assessment_configurations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,section_id uuid REFERENCES school_sections(id),level_id uuid REFERENCES school_levels(id),class_id uuid REFERENCES classes(id) ON DELETE CASCADE,assessment_id uuid REFERENCES assessments(id),grading_system_id uuid REFERENCES grading_systems(id),include_in_term_average boolean DEFAULT true,include_in_merit boolean DEFAULT true,created_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS report_templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,section_code text NOT NULL,name text NOT NULL,template_type text NOT NULL,primary_color text,secondary_color text,config jsonb DEFAULT '{}'::jsonb,is_active boolean DEFAULT true,UNIQUE(school_id,section_code));
CREATE TABLE IF NOT EXISTS report_comments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,learner_id uuid REFERENCES learners(id) ON DELETE CASCADE,academic_year_id uuid REFERENCES academic_years(id),term_id uuid REFERENCES terms(id),comment_type text NOT NULL,comment_text text NOT NULL,created_by uuid REFERENCES users(id),updated_at timestamptz DEFAULT now(),UNIQUE(learner_id,academic_year_id,term_id,comment_type));

CREATE TABLE IF NOT EXISTS merit_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,academic_year_id uuid REFERENCES academic_years(id),term_id uuid REFERENCES terms(id),basis text NOT NULL,filters jsonb DEFAULT '{}'::jsonb,created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid REFERENCES schools(id) ON DELETE CASCADE,user_id uuid REFERENCES users(id),action text NOT NULL,entity_type text,entity_id uuid,details jsonb DEFAULT '{}'::jsonb,created_at timestamptz DEFAULT now());

CREATE INDEX IF NOT EXISTS idx_learners_school ON learners(school_id);
CREATE INDEX IF NOT EXISTS idx_teachers_school ON teachers(school_id);
CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);
CREATE INDEX IF NOT EXISTS idx_marks_school_term ON marks(school_id,academic_year_id,term_id);
CREATE INDEX IF NOT EXISTS idx_assessments_school_term ON assessments(school_id,academic_year_id,term_id);

-- Exactly three master templates.
INSERT INTO school_templates(code,name,description) VALUES
('JUNIOR','Junior School','PP1, PP2 and Grade 1 through Grade 9.'),
('SENIOR','Senior School','Grade 10 through Grade 12.'),
('COMPLEX','Complex School','Grade 10 through Grade 12 plus Transitional Secondary Form 3 and Form 4. No Junior School.')
ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description;

INSERT INTO template_sections(template_id,code,name,sort_order)
SELECT id,'JUNIOR','Junior School',1 FROM school_templates WHERE code='JUNIOR' ON CONFLICT DO NOTHING;
INSERT INTO template_levels(template_section_id,code,name,sort_order)
SELECT s.id,v.code,v.name,v.n FROM template_sections s JOIN school_templates t ON t.id=s.template_id
CROSS JOIN (VALUES('PP1','PP1',1),('PP2','PP2',2),('GRADE_1','Grade 1',3),('GRADE_2','Grade 2',4),('GRADE_3','Grade 3',5),('GRADE_4','Grade 4',6),('GRADE_5','Grade 5',7),('GRADE_6','Grade 6',8),('GRADE_7','Grade 7',9),('GRADE_8','Grade 8',10),('GRADE_9','Grade 9',11))v(code,name,n)
WHERE t.code='JUNIOR' ON CONFLICT DO NOTHING;

INSERT INTO template_sections(template_id,code,name,sort_order)
SELECT id,'SENIOR','Senior School',1 FROM school_templates WHERE code='SENIOR' ON CONFLICT DO NOTHING;
INSERT INTO template_levels(template_section_id,code,name,sort_order)
SELECT s.id,v.code,v.name,v.n FROM template_sections s JOIN school_templates t ON t.id=s.template_id
CROSS JOIN (VALUES('GRADE_10','Grade 10',1),('GRADE_11','Grade 11',2),('GRADE_12','Grade 12',3))v(code,name,n)
WHERE t.code='SENIOR' ON CONFLICT DO NOTHING;

INSERT INTO template_sections(template_id,code,name,sort_order)
SELECT id,v.code,v.name,v.n FROM school_templates t CROSS JOIN
(VALUES('SENIOR','Senior School',1),('TRANSITIONAL_SECONDARY','Transitional Secondary',2))v(code,name,n)
WHERE t.code='COMPLEX' ON CONFLICT DO NOTHING;
INSERT INTO template_levels(template_section_id,code,name,sort_order)
SELECT s.id,v.code,v.name,v.n FROM template_sections s JOIN school_templates t ON t.id=s.template_id
CROSS JOIN (VALUES('GRADE_10','Grade 10',1),('GRADE_11','Grade 11',2),('GRADE_12','Grade 12',3))v(code,name,n)
WHERE t.code='COMPLEX' AND s.code='SENIOR' ON CONFLICT DO NOTHING;
INSERT INTO template_levels(template_section_id,code,name,sort_order)
SELECT s.id,v.code,v.name,v.n FROM template_sections s JOIN school_templates t ON t.id=s.template_id
CROSS JOIN (VALUES('FORM_3','Form 3',1),('FORM_4','Form 4',2))v(code,name,n)
WHERE t.code='COMPLEX' AND s.code='TRANSITIONAL_SECONDARY' ON CONFLICT DO NOTHING;
