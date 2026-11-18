const db = require('./db');
const fs = require('fs');
const path = require('path');

/**
 * Keep an existing ZELIMU CBC database compatible with the current assessment workflow.
 * This is intentionally idempotent so restarting the server is safe.
 */

async function ensureBillingSchema(){
  const q=await db.query(`SELECT to_regclass('public.billing_plans') AS billing_plans,to_regclass('public.school_subscriptions') AS school_subscriptions,to_regclass('public.platform_payment_methods') AS payment_methods`);
  if(q.rows[0]?.billing_plans && q.rows[0]?.school_subscriptions && q.rows[0]?.payment_methods)return;
  const migration=fs.readFileSync(path.join(__dirname,'..','database','005_billing_and_subscriptions.sql'),'utf8');
  await db.query(migration);
}

async function ensurePlatformOwnerProtection(){
  // The platform owner is a permanent platform-level account. Never allow
  // ordinary school-user controls or a legacy migration to deactivate it.
  // This fallback is intentionally limited to the configured product-owner
  // address used by this installation.
  const ownerEmail=String(process.env.PLATFORM_OWNER_EMAIL||'admincyber408@gmail.com').trim().toLowerCase();
  if(!ownerEmail)return;
  const cols=await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users'`);
  const c=new Set(cols.rows.map(r=>r.column_name));
  if(!c.has('email')||!c.has('is_active'))return;
  const u=(await db.query(`SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1`,[ownerEmail])).rows[0];
  if(!u)return;
  await db.query(`UPDATE users SET is_active=true${c.has('updated_at')?', updated_at=now()':''} WHERE id=$1`,[u.id]);
  const rc=await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='user_school_roles'`);
  const rcols=new Set(rc.rows.map(r=>r.column_name));
  if(!rcols.has('user_id')||!rcols.has('role'))return;
  const hasSchool=rcols.has('school_id');
  const hasMark=rcols.has('mark_entry_enabled');
  if(hasSchool && hasMark){
    await db.query(`INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled) VALUES($1,NULL,'PLATFORM_OWNER',true) ON CONFLICT DO NOTHING`,[u.id]);
    await db.query(`UPDATE user_school_roles SET mark_entry_enabled=true WHERE user_id=$1 AND role='PLATFORM_OWNER'`,[u.id]);
  }else if(hasSchool){
    await db.query(`INSERT INTO user_school_roles(user_id,school_id,role) VALUES($1,NULL,'PLATFORM_OWNER') ON CONFLICT DO NOTHING`,[u.id]);
  }
}

async function ensureAssessmentWorkflowSchema(){
  await db.query(`
    ALTER TABLE assessments
      ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES subjects(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS cat_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS final_conversion_weight numeric(6,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
      ADD COLUMN IF NOT EXISTS published_at timestamptz,
      ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
      ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id)
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_assessments_class_subject_period ON assessments(school_id,academic_year_id,term_id,class_id,subject_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_assessment_deadline ON assessments(school_id,academic_year_id,term_id,deadline_at)`);
  // Teacher mark-entry compatibility: older databases may not have the optional
  // assignment activity flag. Teacher capture must never fail merely because that
  // legacy column is absent.
  await db.query(`
    ALTER TABLE teacher_subject_assignments
      ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
      ADD COLUMN IF NOT EXISTS is_class_teacher boolean DEFAULT false
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_teacher_assignment_lookup ON teacher_subject_assignments(school_id,teacher_id,academic_year_id,class_id,subject_id,term_id)`);

  // Unified user Mark Entry control: older databases may not yet have this
  // column because migration 013 was not applied. Add it automatically and
  // preserve existing accounts. New accounts are enabled by default until an
  // administrator explicitly deactivates Mark Entry.
  await db.query(`
    ALTER TABLE user_school_roles
      ADD COLUMN IF NOT EXISTS mark_entry_enabled boolean NOT NULL DEFAULT true
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_user_school_roles_mark_entry ON user_school_roles(school_id,mark_entry_enabled)`);
  // Duplicate-role cleanup used to delete rows automatically at every startup.
  // Keep it opt-in: role rows can encode real access and must be reviewed before removal.
  if (process.env.ZELIMU_ENABLE_ROLE_DEDUP_REPAIR === 'true') {
    await db.query(`WITH ranked AS (SELECT id,ROW_NUMBER() OVER (PARTITION BY user_id,school_id ORDER BY CASE role WHEN 'SCHOOL_ADMIN' THEN 1 WHEN 'ADMIN' THEN 2 WHEN 'HEADTEACHER' THEN 3 WHEN 'DEPUTY_HEADTEACHER' THEN 4 WHEN 'SENIOR_TEACHER' THEN 5 WHEN 'CLASS_TEACHER' THEN 6 WHEN 'TEACHER' THEN 7 ELSE 99 END,created_at,id) rn FROM user_school_roles WHERE school_id IS NOT NULL) DELETE FROM user_school_roles r USING ranked x WHERE r.id=x.id AND x.rn>1`);
    await db.query(`WITH ranked AS (SELECT r.id,ROW_NUMBER() OVER (PARTITION BY r.school_id,r.role ORDER BY u.is_active DESC,r.created_at,r.id) rn FROM user_school_roles r JOIN users u ON u.id=r.user_id WHERE r.role IN ('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER')) DELETE FROM user_school_roles r USING ranked x WHERE r.id=x.id AND x.rn>1`);
  }

  // Do not delete duplicates merely to make an index build succeed. If duplicates
  // remain, keep the app's data intact and emit a warning so an administrator can
  // review the affected accounts and run a deliberate repair if appropriate.
  const duplicateSchoolRoles = await db.query(`SELECT EXISTS (SELECT 1 FROM user_school_roles WHERE school_id IS NOT NULL GROUP BY user_id,school_id HAVING COUNT(*)>1) AS found`);
  if (!duplicateSchoolRoles.rows[0]?.found) {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_one_school_role_per_user ON user_school_roles(user_id,school_id)`);
  } else {
    console.warn('[ZELIMU safety] Duplicate user roles exist for one or more school users; skipped unique role index. Review before enabling role deduplication.');
  }
  const duplicateLeadershipRoles = await db.query(`SELECT EXISTS (SELECT 1 FROM user_school_roles WHERE role IN ('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER') GROUP BY school_id,role HAVING COUNT(*)>1) AS found`);
  if (!duplicateLeadershipRoles.rows[0]?.found) {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_one_leadership_role_per_school ON user_school_roles(school_id,role) WHERE role IN ('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER')`);
  } else {
    console.warn('[ZELIMU safety] Duplicate leadership roles exist in one or more schools; skipped unique leadership index. Review before enabling role deduplication.');
  }

  // Full workflow compatibility for older databases: optional learner identifiers,
  // parents/guardians, document assets and report communication dependencies.
  await db.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'DEPUTY_HEADTEACHER'`);
  await db.query(`ALTER TABLE learners ALTER COLUMN admission_no DROP NOT NULL`);
  await db.query(`ALTER TABLE learners ADD COLUMN IF NOT EXISTS assessment_no text`);
  await db.query(`ALTER TABLE learners ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE'`);
  await db.query(`ALTER TABLE learners ADD COLUMN IF NOT EXISTS passport_photo_url text`);
  await db.query(`ALTER TABLE learners ADD COLUMN IF NOT EXISTS cbc_pathway text`);
  // Legacy placeholder identifiers are preserved by default. Clearing them changes
  // learner records, so it is available only for a deliberately approved cleanup.
  if (process.env.ZELIMU_ENABLE_LEGACY_ADMISSION_CLEANUP === 'true') {
    await db.query(`UPDATE learners SET admission_no=NULL WHERE admission_no ILIKE 'IMPORT-%' OR admission_no ILIKE 'LEGACY-%'`);
  }
  const duplicateAdmissions = await db.query(`SELECT EXISTS (SELECT 1 FROM learners WHERE admission_no IS NOT NULL AND btrim(admission_no)<>'' GROUP BY school_id,admission_no HAVING COUNT(*)>1) AS found`);
  if (!duplicateAdmissions.rows[0]?.found) {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_learner_admission_when_present ON learners(school_id,admission_no) WHERE admission_no IS NOT NULL AND btrim(admission_no) <> ''`);
  } else {
    console.warn('[ZELIMU safety] Duplicate learner admission numbers exist; skipped unique admission index to avoid changing learner records automatically. Review duplicates before cleanup.');
  }
  await db.query(`CREATE TABLE IF NOT EXISTS parent_guardians(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    first_name text NOT NULL,last_name text NOT NULL,relationship text,phone text,email text,
    preferred_language text,communication_consent boolean NOT NULL DEFAULT true,sms_enabled boolean NOT NULL DEFAULT true,
    is_active boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS learner_guardians(
    learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,parent_guardian_id uuid NOT NULL REFERENCES parent_guardians(id) ON DELETE CASCADE,
    is_primary boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now(),PRIMARY KEY(learner_id,parent_guardian_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_parent_guardians_school ON parent_guardians(school_id,phone)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_learner_guardians_learner ON learner_guardians(learner_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS school_document_assets(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    asset_type text NOT NULL CHECK(asset_type IN ('STAMP','LOGO','WATERMARK')),file_url text NOT NULL,
    effective_from date NOT NULL DEFAULT CURRENT_DATE,effective_to date,is_active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_school_document_assets_effective ON school_document_assets(school_id,asset_type,effective_from DESC,is_active)`);
  await db.query(`ALTER TABLE assessment_configurations ADD COLUMN IF NOT EXISTS target_mark numeric(6,2)`);
  // Grading may be assigned to specific classes (not only whole levels), and
  // term records keep an explicit reopening date so the school calendar can be
  // restored exactly on reports.
  await db.query(`ALTER TABLE assessment_configurations ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE CASCADE`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_grading_configuration_scope ON assessment_configurations(school_id,class_id,level_id,assessment_id,subject_id,grading_system_id)`);
  await db.query(`ALTER TABLE terms ADD COLUMN IF NOT EXISTS opening_date date`);
  await db.query(`ALTER TABLE terms ADD COLUMN IF NOT EXISTS closing_date date`);
  await db.query(`ALTER TABLE terms ADD COLUMN IF NOT EXISTS reopening_date date`);
  await db.query(`UPDATE terms t SET reopening_date=COALESCE(t.reopening_date,nt.opening_date) FROM terms nt WHERE nt.academic_year_id=t.academic_year_id AND nt.term_no=t.term_no+1 AND t.reopening_date IS NULL`);
  await db.query(`CREATE TABLE IF NOT EXISTS school_announcements(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    message text NOT NULL,is_scrolling boolean NOT NULL DEFAULT true,is_active boolean NOT NULL DEFAULT true,
    starts_at timestamptz DEFAULT now(),ends_at timestamptz,created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS communication_messages(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    learner_id uuid REFERENCES learners(id) ON DELETE SET NULL,parent_guardian_id uuid REFERENCES parent_guardians(id) ON DELETE SET NULL,
    channel text NOT NULL DEFAULT 'SMS',message_type text NOT NULL,body text NOT NULL,status text NOT NULL DEFAULT 'QUEUED',
    provider text,provider_message_id text,failure_reason text,error_message text,sent_at timestamptz,delivered_at timestamptz,
    created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now())`);
  await db.query(`ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS failure_reason text`);
  await db.query(`ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS error_message text`);

  await ensureBillingSchema();
  await ensurePlatformOwnerProtection();

  // Ensure the mark destination exists on older databases and can be safely upserted.
  await db.query(`
    ALTER TABLE marks
      ADD COLUMN IF NOT EXISTS school_id uuid,
      ADD COLUMN IF NOT EXISTS learner_id uuid,
      ADD COLUMN IF NOT EXISTS subject_id uuid,
      ADD COLUMN IF NOT EXISTS class_id uuid,
      ADD COLUMN IF NOT EXISTS academic_year_id uuid,
      ADD COLUMN IF NOT EXISTS term_id uuid,
      ADD COLUMN IF NOT EXISTS assessment_id uuid,
      ADD COLUMN IF NOT EXISTS mark numeric(8,2),
      ADD COLUMN IF NOT EXISTS entered_by uuid,
      ADD COLUMN IF NOT EXISTS remark text,
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_marks_learner_subject_assessment ON marks(learner_id,subject_id,assessment_id)`);

  // Teacher Resource Library: school-scoped PDF resources available to authorised staff.
  await db.query(`CREATE TABLE IF NOT EXISTS school_resource_documents(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    title text NOT NULL,
    resource_type text NOT NULL CHECK(resource_type IN ('PDF','SCHEME_OF_WORK','REVISION_PAPER','TEACHER_GUIDE','OTHER')),
    file_url text NOT NULL, original_name text, description text DEFAULT '', file_data bytea, mime_type text DEFAULT 'application/pdf',
    uploaded_by uuid REFERENCES users(id), is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_school_resources_school_active ON school_resource_documents(school_id,is_active,resource_type,title)`);
  await db.query(`ALTER TABLE school_resource_documents ADD COLUMN IF NOT EXISTS file_data bytea, ADD COLUMN IF NOT EXISTS mime_type text DEFAULT 'application/pdf'`);
  await db.query(`ALTER TABLE school_resource_documents ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES subjects(id) ON DELETE SET NULL, ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE SET NULL, ADD COLUMN IF NOT EXISTS academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE school_resource_documents DROP CONSTRAINT IF EXISTS school_resource_documents_resource_type_check`);
  await db.query(`ALTER TABLE school_resource_documents ADD CONSTRAINT school_resource_documents_resource_type_check CHECK(resource_type IN ('SCHEME_OF_WORK','NOTES','REVISION_PAPER','TEACHER_GUIDE','OTHER','PDF'))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_school_resources_catalog ON school_resource_documents(school_id,is_active,resource_type,subject_id,class_id,academic_year_id,title)`);

  // Operational domains: persistent data stores for attendance, discipline, inventory and timetable.
  await db.query(`CREATE TABLE IF NOT EXISTS attendance_records(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,term_id uuid REFERENCES terms(id) ON DELETE SET NULL,
    attendance_date date NOT NULL,status text NOT NULL CHECK(status IN ('PRESENT','ABSENT','LATE','EXCUSED')),
    reason text,recorded_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
    UNIQUE(school_id,learner_id,attendance_date))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_attendance_school_period ON attendance_records(school_id,academic_year_id,term_id,class_id,attendance_date)`);
  await db.query(`CREATE TABLE IF NOT EXISTS discipline_cases(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,class_id uuid REFERENCES classes(id) ON DELETE SET NULL,
    case_date date NOT NULL DEFAULT CURRENT_DATE,title text NOT NULL,category text NOT NULL DEFAULT 'GENERAL',severity text NOT NULL DEFAULT 'LOW',
    description text DEFAULT '',action_taken text DEFAULT '',status text NOT NULL DEFAULT 'OPEN',reported_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_discipline_school_status ON discipline_cases(school_id,status,case_date DESC)`);
  await db.query(`CREATE TABLE IF NOT EXISTS inventory_items(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    asset_code text,name text NOT NULL,category text NOT NULL DEFAULT 'GENERAL',unit text NOT NULL DEFAULT 'unit',quantity numeric(12,2) NOT NULL DEFAULT 0,
    unit_cost numeric(12,2) NOT NULL DEFAULT 0,location text DEFAULT '',condition_status text NOT NULL DEFAULT 'GOOD',notes text DEFAULT '',is_active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(school_id,asset_code))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_inventory_school_category ON inventory_items(school_id,category,is_active)`);
  await db.query(`CREATE TABLE IF NOT EXISTS timetable_entries(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,term_id uuid REFERENCES terms(id) ON DELETE SET NULL,
    class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    teacher_id uuid REFERENCES teachers(id) ON DELETE SET NULL,day_of_week int NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),
    start_time time NOT NULL,end_time time NOT NULL,room text DEFAULT '',notes text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_timetable_school_period ON timetable_entries(school_id,academic_year_id,term_id,class_id,day_of_week,start_time)`);
  await db.query(`ALTER TABLE timetable_entries ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false`);
  await db.query(`CREATE TABLE IF NOT EXISTS timetable_configurations(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,term_id uuid REFERENCES terms(id) ON DELETE SET NULL,
    name text NOT NULL,description text NOT NULL DEFAULT '',effective_start_date date,effective_end_date date,
    teaching_days jsonb NOT NULL DEFAULT '[1,2,3,4,5]',periods_per_day integer NOT NULL DEFAULT 8,
    period_start_times jsonb NOT NULL DEFAULT '[]',period_end_times jsonb NOT NULL DEFAULT '[]',
    break_periods jsonb NOT NULL DEFAULT '[]',lunch_periods jsonb NOT NULL DEFAULT '[]',
    is_active boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_timetable_config_school ON timetable_configurations(school_id,is_active,academic_year_id,term_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS timetable_rooms(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    room_name text NOT NULL,room_code text,room_type text NOT NULL DEFAULT 'CLASSROOM',
    capacity integer,features jsonb NOT NULL DEFAULT '[]',availability jsonb NOT NULL DEFAULT '[]',
    is_active boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
    UNIQUE(school_id,room_name))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_timetable_rooms_school ON timetable_rooms(school_id,is_active,room_type,room_name)`);
  await db.query(`CREATE TABLE IF NOT EXISTS timetable_unavailability(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,term_id uuid REFERENCES terms(id) ON DELETE SET NULL,
    teacher_id uuid REFERENCES teachers(id) ON DELETE CASCADE,room_id uuid REFERENCES timetable_rooms(id) ON DELETE CASCADE,
    day_of_week integer NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),period integer NOT NULL CHECK(period BETWEEN 1 AND 12),
    reason text NOT NULL DEFAULT '',is_active boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT now(),
    CHECK((teacher_id IS NOT NULL) <> (room_id IS NOT NULL)))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_timetable_unavailability_scope ON timetable_unavailability(school_id,academic_year_id,term_id,is_active,day_of_week,period)`);
  await db.query(`CREATE TABLE IF NOT EXISTS timetable_requirements(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE CASCADE,term_id uuid REFERENCES terms(id) ON DELETE SET NULL,
    class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    teacher_id uuid REFERENCES teachers(id) ON DELETE SET NULL,lessons_per_week integer NOT NULL CHECK(lessons_per_week > 0),
    preferred_day integer,preferred_period integer,room_requirement text DEFAULT '',notes text DEFAULT '',
    created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
  await db.query(`ALTER TABLE timetable_requirements
    ADD COLUMN IF NOT EXISTS periods_per_lesson integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS max_per_day integer,
    ADD COLUMN IF NOT EXISTS preferred_period integer,
    ADD COLUMN IF NOT EXISTS hard_preference boolean NOT NULL DEFAULT false`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_timetable_requirements_school ON timetable_requirements(school_id,academic_year_id,term_id,class_id,subject_id,teacher_id)`);

  // Term 3 is strictly OPENER + END TERM. The Kauti workbook supplied for the
  // current launch is an OPENER import, so any imported workbook marks that were
  // accidentally attached to END TERM are repaired to OPENER. This is idempotent.
  await db.query(`WITH pairs AS (
    SELECT DISTINCT tsa.school_id,tsa.academic_year_id,tsa.term_id,tsa.class_id,tsa.subject_id
    FROM teacher_subject_assignments tsa
    JOIN terms t ON t.id=tsa.term_id AND t.term_no=3 AND t.academic_year_id=tsa.academic_year_id
    WHERE COALESCE(tsa.is_active,true)=true
  ), wanted AS (
    SELECT p.*,v.name,v.assessment_type,v.assessment_order FROM pairs p
    CROSS JOIN (VALUES ('Opener','OPENER',1),('End Term','END_TERM',2)) v(name,assessment_type,assessment_order)
  )
  INSERT INTO assessments(school_id,academic_year_id,term_id,name,assessment_type,max_mark,weight,include_in_final,assessment_order,status,class_id,subject_id)
  SELECT w.school_id,w.academic_year_id,w.term_id,w.name,w.assessment_type,100,0,true,w.assessment_order,'OPEN',w.class_id,w.subject_id
  FROM wanted w
  WHERE NOT EXISTS (SELECT 1 FROM assessments a WHERE a.school_id=w.school_id AND a.academic_year_id=w.academic_year_id AND a.term_id=w.term_id AND a.class_id=w.class_id AND a.subject_id=w.subject_id AND a.assessment_type=w.assessment_type)`);

  // SAFETY: these UPDATE/DELETE statements were originally written for a specific
  // Kauti workbook import. They must not run automatically against every school's
  // live marks whenever the web server restarts. Run them only during a deliberately
  // approved repair after a database backup, by setting
  // ZELIMU_ENABLE_TERM3_IMPORT_REPAIR=true for that one maintenance run.
  if (process.env.ZELIMU_ENABLE_TERM3_IMPORT_REPAIR === 'true') {
    await db.query(`WITH candidates AS (
      SELECT m.id,op.id opener_id
      FROM marks m JOIN assessments ea ON ea.id=m.assessment_id
      JOIN terms et ON et.id=m.term_id
      JOIN LATERAL (SELECT oa.id FROM assessments oa WHERE oa.school_id=m.school_id AND oa.academic_year_id=m.academic_year_id AND oa.term_id=m.term_id AND oa.assessment_type='OPENER' AND (oa.class_id=m.class_id OR oa.class_id IS NULL) AND (oa.subject_id=m.subject_id OR oa.subject_id IS NULL) ORDER BY (oa.class_id IS NOT NULL) DESC,(oa.subject_id IS NOT NULL) DESC,oa.created_at LIMIT 1) op ON true
      WHERE et.term_no=3 AND ea.assessment_type='END_TERM' AND COALESCE(m.remark,'') ILIKE 'Imported from%workbook%'
        AND NOT EXISTS(SELECT 1 FROM marks om WHERE om.learner_id=m.learner_id AND om.subject_id=m.subject_id AND om.assessment_id=op.id)
    ) UPDATE marks m SET assessment_id=c.opener_id,term_id=(SELECT term_id FROM assessments WHERE id=c.opener_id),updated_at=now(),remark='Imported from Kauti workbook · repaired as Term 3 Opener' FROM candidates c WHERE m.id=c.id`);

    // If an imported workbook mark already has a matching Opener mark, remove only
    // that matching imported duplicate. This repair is intentionally opt-in.
    await db.query(`DELETE FROM marks m USING assessments a,terms t
      WHERE a.id=m.assessment_id AND a.assessment_type='END_TERM' AND t.id=m.term_id AND t.term_no=3
        AND COALESCE(m.remark,'') ILIKE 'Imported from%workbook%'
        AND EXISTS (SELECT 1 FROM marks om JOIN assessments oa ON oa.id=om.assessment_id
                    WHERE om.learner_id=m.learner_id AND om.subject_id=m.subject_id AND oa.assessment_type='OPENER'
                      AND om.academic_year_id=m.academic_year_id AND om.school_id=m.school_id)`);
  }

}


// Create the teacher-account linking request table when required.
// This migration is additive and does not alter existing teacher accounts.
async function ensureTeacherAccountLinkingSchema(){
  const fs=require('fs');
  const path=require('path');
  const sql=fs.readFileSync(
    path.join(__dirname,'..','database','029_teacher_account_linking.sql'),
    'utf8'
  );
  await db.query(sql);
}

const originalEnsureAssessmentWorkflowSchema=ensureAssessmentWorkflowSchema;

async function ensureAssessmentWorkflowSchemaWithTeacherLinking(){
  await originalEnsureAssessmentWorkflowSchema();
  await ensureTeacherAccountLinkingSchema();
}

module.exports = { ensureAssessmentWorkflowSchema: ensureAssessmentWorkflowSchemaWithTeacherLinking, ensureBillingSchema, ensureTeacherAccountLinkingSchema };
