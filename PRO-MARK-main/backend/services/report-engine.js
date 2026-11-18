const db = require("../db");
const {
  buildExamColumns,
  subjectEntries,
  scoreSubject,
  computeRanks
} = require("./term-score");

function finite(n) { const x = Number(n); return Number.isFinite(x) ? x : null; }
function avg(values) {
  const a = values.map(finite).filter(v => v !== null);
  return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
}
function weighted(items) {
  const usable = items.filter(x => finite(x.value) !== null && Number(x.weight) > 0);
  const w = usable.reduce((s,x)=>s+Number(x.weight),0);
  return w ? usable.reduce((s,x)=>s+Number(x.value)*Number(x.weight),0)/w : null;
}
function gradeFor(mark,bands) {
  const n = finite(mark);
  if (n === null) return null;
  // Bands are stored as whole-number ranges. Looking a fractional average up
  // directly (e.g. 59.5 against 50–59 and 60–69) matched no band and printed a
  // blank grade, so grades are resolved from the rounded whole-number average
  // exactly like the merit list does.
  const rounded = Math.round(n + Number.EPSILON);
  return (bands||[]).find(b => rounded >= Number(b.min_mark) && rounded <= Number(b.max_mark)) || null;
}
function autoDesignation(mark) {
  const n=finite(mark);
  if(n===null)return 'INCOMPLETE';
  if(n>=80)return 'DISTINCTION';
  if(n>=70)return 'MERIT';
  if(n>=60)return 'CREDIT';
  if(n>=50)return 'PASS';
  if(n>=40)return 'DEVELOPING';
  return 'AT_RISK';
}
function autoDecision(mark) {
  const n=finite(mark);
  if(n===null)return 'REVIEW';
  return n>=50?'PROMOTED':'REVIEW';
}
function teacherInitials(first,last,staffNo) {
  const staff=String(staffNo||"").trim();
  const m=staff.match(/^(MD|MR|MRS|MS)\.\s*([A-Z]+)/i);
  if(m) return (m[1][0]+m[2][0]).toUpperCase();
  return [first,last].filter(Boolean).map(x=>String(x).trim()[0]).join("").toUpperCase();
}
function teacherDisplay(first,last,staffNo) {
  const full=[first,last].filter(Boolean).map(v=>String(v).trim()).filter(Boolean).join(' ').toUpperCase();
  if(full)return full;
  return String(staffNo||'').trim().toUpperCase();
}
function isPlaceholderTeacher(t) {
  const first=String(t?.teacher_first_name||t?.first_name||'').trim().toUpperCase();
  const last=String(t?.teacher_last_name||t?.last_name||'').trim().toUpperCase();
  const staff=String(t?.staff_no||'').trim().toUpperCase();
  return !first && !last || last==='TEACHER' || first==='TEACHER' || staff==='TEACHER' || staff==='MR.TEACHER' || staff==='MR. TEACHER';
}

// Short-lived caches remove repeated configuration/assignment queries when a whole
// class of report cards is generated. They are intentionally small and expire quickly
// so an administrator's assignment change is reflected without a server restart.
const reportCache=new Map();
function invalidateReportCaches(){ reportCache.clear(); }
function cached(key,ttl,loader){
  const now=Date.now(),hit=reportCache.get(key);
  if(hit && hit.expires>now)return hit.value;
  const value=Promise.resolve().then(loader);
  const entry={value,expires:Infinity};
  reportCache.set(key,entry);
  value.then(()=>{
    if(reportCache.get(key)===entry)entry.expires=Date.now()+ttl;
  },()=>{
    if(reportCache.get(key)===entry)reportCache.delete(key);
  });
  return value;
}
async function loadMeritProfile(schoolId,yearId,termId,classId){
  return cached(`merit-profile|${schoolId}|${yearId}|${termId}|${classId}`,15000,async()=>{
    try{
      return (await db.query(`SELECT selected_assessment_ids,cat_group_mode,custom_weights
        FROM merit_flex_profiles
        WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND class_id=$4`,
        [schoolId,yearId,termId,classId])).rows[0]||null;
    }catch(e){
      if(e.code==='42P01'||e.code==='42703')return null;
      throw e;
    }
  });
}


async function getContext(schoolId, learnerId, yearId, termId) {
  const meta = (await db.query(`
    SELECT l.id learner_id,l.admission_no,l.assessment_no,l.passport_photo_url,l.first_name,l.middle_name,l.last_name,COALESCE(le.class_id,l.class_id) class_id,
           c.name class_name,c.stream,sl.id level_id,sl.code level_code,sl.name level_name,
           ss.id section_id,ss.code section_code,ss.name section_name,
           st.code school_template_code,rt.name report_template_name,
           COALESCE(rt.template_type,CASE
             WHEN st.code='JUNIOR' AND ss.code='JUNIOR' THEN 'JUNIOR_A4'
             WHEN st.code='SENIOR' AND ss.code='SENIOR' THEN 'SENIOR_A4'
             WHEN st.code='COMPLEX' AND ss.code='SENIOR' THEN 'SENIOR_A4'
             WHEN st.code='COMPLEX' AND ss.code='TRANSITIONAL_SECONDARY' THEN 'TRANSITIONAL_A4'
           END) report_template_type,COALESCE(rt.config,'{}'::jsonb) report_template_config,
           s.name school_name,s.code school_code,si.logo_url,si.motto,si.primary_color,si.secondary_color,
           si.address,si.contact_phone,si.contact_email,si.watermark_enabled,ay.year_label,ay.identity_snapshot,
           t.id term_id,t.term_no,t.name term_name,t.opening_date,t.closing_date,t.reopening_date,
           nt.id next_term_id,nt.term_no next_term_no,nt.name next_term_name,nt.opening_date next_term_opening_date,nt.closing_date next_term_closing_date,nt.reopening_date next_term_reopening_date
    FROM learners l
    JOIN schools s ON s.id=l.school_id
    LEFT JOIN school_templates st ON st.id=s.template_id
    LEFT JOIN school_identity si ON si.school_id=s.id
    JOIN academic_years ay ON ay.id=$3 AND ay.school_id=l.school_id
    JOIN terms t ON t.id=$4 AND t.school_id=l.school_id AND t.academic_year_id=ay.id
    LEFT JOIN terms nt ON nt.school_id=l.school_id AND nt.academic_year_id=ay.id AND nt.term_no=t.term_no+1
    LEFT JOIN LATERAL (
      SELECT le.class_id
      FROM learner_enrollments le
      WHERE le.school_id=l.school_id AND le.learner_id=l.id AND le.academic_year_id=ay.id
        AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
      ORDER BY (COALESCE(le.status,'ACTIVE')='ACTIVE') DESC,le.enrolled_at DESC
      LIMIT 1
    ) le ON true
    LEFT JOIN classes c ON c.id=COALESCE(le.class_id,l.class_id)
    LEFT JOIN school_levels sl ON sl.id=c.school_level_id
    LEFT JOIN school_sections ss ON ss.id=sl.school_section_id
    LEFT JOIN report_templates rt ON rt.school_id=s.id AND rt.section_code=ss.code AND rt.is_active=true
    WHERE l.school_id=$1 AND l.id=$2`, [schoolId,learnerId,yearId,termId])).rows[0];
  if(!meta)return null;
  // For Term 3, the reopening date belongs to Term 1 of the next academic year.
  if(!meta.next_term_opening_date){
    const nxt=await cached(`next-term|${schoolId}|${meta.closing_date||''}`,30000,async()=>
      (await db.query(`SELECT t.id term_id,t.term_no next_term_no,t.name next_term_name,t.opening_date next_term_opening_date,t.closing_date next_term_closing_date
        FROM academic_years ay JOIN terms t ON t.academic_year_id=ay.id AND t.term_no=1
        WHERE ay.school_id=$1 AND ay.start_date>COALESCE($2::date,CURRENT_DATE)
        ORDER BY ay.start_date ASC NULLS LAST,ay.year_label ASC LIMIT 1`,[schoolId,meta.closing_date||null])).rows[0]||null
    );
    if(nxt){meta.next_term_id=nxt.term_id;meta.next_term_no=nxt.next_term_no;meta.next_term_name=nxt.next_term_name;meta.next_term_opening_date=nxt.next_term_opening_date;meta.next_term_closing_date=nxt.next_term_closing_date;}
  }
  const snap=meta.identity_snapshot && typeof meta.identity_snapshot==='object' ? meta.identity_snapshot : {};
  if(Object.keys(snap).length){
    // Current school_identity data is authoritative for branding. An academic-year
    // identity snapshot is used only as a fallback when the current school record is
    // genuinely blank, so manually entered school name/logo/motto/contact data can
    // never be replaced by stale historical branding.
    if(!meta.motto && snap.motto)meta.motto=snap.motto;
    if(!meta.logo_url && snap.logo_url)meta.logo_url=snap.logo_url;
    if(!meta.primary_color && snap.primary_color)meta.primary_color=snap.primary_color;
    if(!meta.secondary_color && snap.secondary_color)meta.secondary_color=snap.secondary_color;
    if(!meta.address && snap.address)meta.address=snap.address;
    if(!meta.contact_phone && snap.contact_phone)meta.contact_phone=snap.contact_phone;
    meta.watermark_enabled=meta.watermark_enabled ?? snap.watermark_enabled ?? true;
  }
  return meta;
}

async function resolveGrading(schoolId, meta, assessmentId=null, subjectId=null) {
  const key=`grading|${schoolId}|${meta.section_id||''}|${meta.level_id||''}|${meta.class_id||''}|${assessmentId||''}|${subjectId||''}`;
  return cached(key,30000,async()=>{
  const q = await db.query(`
    SELECT gs.id,gs.name,gs.code,gb.label,gb.min_mark,gb.max_mark,gb.points,gb.descriptor,gb.remark
    FROM grading_systems gs
    JOIN grading_bands gb ON gb.grading_system_id=gs.id
    LEFT JOIN assessment_configurations ac
      ON ac.grading_system_id=gs.id AND ac.school_id=$1
     AND (ac.section_id=$2 OR ac.section_id IS NULL)
     AND (ac.class_id=$6 OR ac.class_id IS NULL)
     AND (ac.level_id=$3 OR ac.level_id IS NULL)
     AND (ac.assessment_id=$4 OR ac.assessment_id IS NULL)
     AND (ac.subject_id=$5 OR ac.subject_id IS NULL)
    WHERE gs.school_id=$1 AND gs.is_active=true AND ac.grading_system_id IS NOT NULL
    ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.assessment_id IS NOT NULL) DESC,(ac.class_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,
             (ac.section_id IS NOT NULL) DESC,
             gs.id,gb.min_mark DESC`, [schoolId,meta.section_id,meta.level_id,assessmentId,subjectId,meta.class_id]);
  if (!q.rows.length) {
    // Schools that have created a grading system but have not yet mapped it to
    // an assessment/class configuration still expect grades to print. Fall back
    // to their default active system instead of leaving every grade blank.
    const fallbackSystem = (await db.query(
      `SELECT id,name,code FROM grading_systems
       WHERE school_id=$1 AND COALESCE(is_active,true)=true
       ORDER BY (upper(code)='CBC') DESC,code,id LIMIT 1`,
      [schoolId]
    )).rows[0];
    if (!fallbackSystem) return {system:null,bands:[]};
    const fallbackBands = (await db.query(
      `SELECT label,min_mark,max_mark,points,descriptor,remark
       FROM grading_bands WHERE grading_system_id=$1 ORDER BY min_mark DESC`,
      [fallbackSystem.id]
    )).rows;
    return {system:fallbackSystem,bands:fallbackBands};
  }
  const system = q.rows[0];
  return {system:{id:system.id,name:system.name,code:system.code},bands:q.rows.filter(x=>x.id===system.id)};
  });
}

async function buildTermReportCore(schoolId, learnerId, yearId, termId) {
  const meta = await getContext(schoolId,learnerId,yearId,termId);
  if (!meta) return null;
  const assessmentsPromise = cached(`assessments|${schoolId}|${yearId}|${termId}|${meta.section_id||''}|${meta.level_id||''}`,30000,async()=> (await db.query(`
    SELECT a.*,
      (SELECT COUNT(*)::int FROM marks mx WHERE mx.assessment_id=a.id AND mx.school_id=a.school_id AND mx.academic_year_id=a.academic_year_id AND mx.term_id=a.term_id) AS mark_count,
      COALESCE((SELECT ac.include_in_term_average FROM assessment_configurations ac
        WHERE ac.school_id=a.school_id AND ac.assessment_id=a.id AND ac.subject_id IS NULL
          AND (ac.section_id=$4 OR ac.section_id IS NULL) AND (ac.level_id=$5 OR ac.level_id IS NULL)
        ORDER BY (ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_term_average,
      COALESCE((SELECT ac.include_in_merit FROM assessment_configurations ac
        WHERE ac.school_id=a.school_id AND ac.assessment_id=a.id AND ac.subject_id IS NULL
          AND (ac.section_id=$4 OR ac.section_id IS NULL) AND (ac.level_id=$5 OR ac.level_id IS NULL)
        ORDER BY (ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_merit
    FROM assessments a
    WHERE a.school_id=$1 AND a.academic_year_id=$2 AND a.term_id=$3
    ORDER BY a.assessment_order,a.created_at,a.name`,[schoolId,yearId,termId,meta.section_id,meta.level_id])).rows);

  const marksPromise = db.query(`
    SELECT m.subject_id,s.code subject_code,s.name subject_name,a.id assessment_id,a.name assessment_name,
           a.assessment_type,a.max_mark,a.weight,m.mark,m.remark,
           th.staff_no,th.first_name teacher_first_name,th.last_name teacher_last_name,
           th2.staff_no entered_teacher_staff_no,th2.first_name entered_teacher_first_name,th2.last_name entered_teacher_last_name,
           u2.first_name entered_user_first_name,u2.last_name entered_user_last_name,
           COALESCE((SELECT ac.include_in_term_average FROM assessment_configurations ac
             WHERE ac.school_id=m.school_id AND ac.assessment_id=m.assessment_id
               AND (ac.subject_id=m.subject_id OR ac.subject_id IS NULL)
               AND (ac.section_id=$5 OR ac.section_id IS NULL) AND (ac.level_id=$6 OR ac.level_id IS NULL)
             ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_term_average
    FROM marks m JOIN subjects s ON s.id=m.subject_id
    JOIN assessments a ON a.id=m.assessment_id
    LEFT JOIN LATERAL (
      SELECT tsa.teacher_id
      FROM teacher_subject_assignments tsa
      JOIN teachers tassign ON tassign.id=tsa.teacher_id
      WHERE tsa.school_id=m.school_id AND tsa.subject_id=m.subject_id AND tsa.class_id=m.class_id
        AND tsa.academic_year_id=m.academic_year_id
        AND COALESCE(tsa.is_active,true)=true
        AND NOT (upper(trim(coalesce(tassign.first_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(tassign.last_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(tassign.staff_no,''))) IN ('TEACHER','ADMIN','MR.TEACHER','MR. TEACHER'))
      ORDER BY (tsa.term_id IS NOT NULL) DESC,tsa.created_at DESC,tsa.id DESC
      LIMIT 1
    ) tsa ON true
    LEFT JOIN teachers th ON th.id=tsa.teacher_id
    LEFT JOIN teachers th2 ON th2.user_id=m.entered_by AND th2.school_id=m.school_id AND th2.is_active=true
    LEFT JOIN users u2 ON u2.id=m.entered_by AND u2.is_active=true
    WHERE m.school_id=$1 AND m.learner_id=$2 AND m.academic_year_id=$3 AND m.term_id=$4
    ORDER BY s.name,a.assessment_order,a.name`,[schoolId,learnerId,yearId,termId,meta.section_id,meta.level_id]).then(q=>q.rows);

  // Subject-teacher assignments are read live for every report build.  This is
  // intentional: an administrator can assign/reassign a teacher and the very next
  // report card must immediately reflect that assignment instead of waiting for a
  // short-lived report cache to expire.
  //
  // Resolution order per subject:
  //   1) assignment for the selected term
  //   2) all-terms assignment
  //   3) another assignment in the same year (latest one)
  // Active assignments are preferred, but an inactive historical row is allowed as a
  // fallback so a valid teacher name is never lost from an existing report.
  const assignedSubjectsPromise = cached(`assignments|${schoolId}|${meta.class_id}|${yearId}|${termId}`,15000,async()=> (await db.query(`
    SELECT DISTINCT ON (tsa.subject_id) tsa.subject_id,s.code subject_code,s.name subject_name,
           th.staff_no,th.first_name teacher_first_name,th.last_name teacher_last_name,
           COALESCE(tsa.is_active,true) assignment_active,tsa.term_id assignment_term_id,
           tsa.created_at assignment_created_at
    FROM teacher_subject_assignments tsa
    JOIN subjects s ON s.id=tsa.subject_id
    JOIN teachers th ON th.id=tsa.teacher_id
    WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3
      AND NOT (upper(trim(coalesce(th.first_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.last_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.staff_no,''))) IN ('TEACHER','ADMIN','MR.TEACHER','MR. TEACHER'))
    ORDER BY tsa.subject_id,
      CASE WHEN tsa.term_id=$4 THEN 0 WHEN tsa.term_id IS NULL THEN 1 ELSE 2 END,
      CASE WHEN COALESCE(tsa.is_active,true)=true THEN 0 ELSE 1 END,
        tsa.created_at DESC,tsa.id DESC`,[schoolId,meta.class_id,yearId,termId])).rows);
      const [assessments,marks,assignedSubjects,meritProfile]=await Promise.all([assessmentsPromise,marksPromise,assignedSubjectsPromise,loadMeritProfile(schoolId,yearId,termId,meta.class_id)]);
  const examColumns=buildExamColumns(assessments,meta.class_id);

  // Report-card subjects come from the current class assignments PLUS any marks
  // actually recorded for this learner in the selected year/term.  This prevents a
  // valid OPENER mark from disappearing merely because an assignment record was
  // later deactivated or changed.  The assignment remains the authoritative source
  // for the subject teacher name when one exists.
  const subjectIds = [...new Set([
    ...assignedSubjects.map(x=>x.subject_id),
    ...marks.map(x=>x.subject_id)
  ])];
  const marksBySubject=new Map();
  for(const m of marks){if(!marksBySubject.has(m.subject_id))marksBySubject.set(m.subject_id,[]);marksBySubject.get(m.subject_id).push(m);}
  const subjects = await Promise.all(subjectIds.map(async subjectId => {
    const sm = marksBySubject.get(subjectId)||[];
    const assigned = assignedSubjects.find(x=>x.subject_id===subjectId);
    // Every exam configured for this class and term becomes a report column,
    // including CATs. A saved merit profile decides how the columns combine;
    // without one the historical equal main-exam average is preserved.
    const entries=subjectEntries(sm,assessments,meta.class_id,subjectId,examColumns);
    const scoring=scoreSubject({subjectId,entries,profile:meritProfile,assessments,classId:meta.class_id});
    const countedColumns=new Set(scoring.counted_keys);
    const subjectAverage=scoring.average;
    const gradingAssessment=entries.find(e=>e.percent!==null&&e.assessment_id!=null);
    const grading=await resolveGrading(schoolId,meta,gradingAssessment?.assessment_id,subjectId);
    const grade=gradeFor(subjectAverage,grading.bands);
    const assignedReal=assigned && !isPlaceholderTeacher(assigned) ? assigned : null;
    const markTeacher=sm.find(x=>(x.teacher_first_name||x.teacher_last_name) && !isPlaceholderTeacher({teacher_first_name:x.teacher_first_name,teacher_last_name:x.teacher_last_name,staff_no:x.staff_no}))
      || sm.find(x=>(x.entered_teacher_first_name||x.entered_teacher_last_name) && !isPlaceholderTeacher({teacher_first_name:x.entered_teacher_first_name,teacher_last_name:x.entered_teacher_last_name,staff_no:x.entered_teacher_staff_no}))
      || sm.find(x=>(x.entered_user_first_name||x.entered_user_last_name) && !isPlaceholderTeacher({first_name:x.entered_user_first_name,last_name:x.entered_user_last_name}));
    const teacher=assignedReal || markTeacher;
    const tf=teacher===markTeacher ? (teacher?.teacher_first_name || teacher?.entered_teacher_first_name || teacher?.entered_user_first_name) : teacher?.teacher_first_name;
    const tl=teacher===markTeacher ? (teacher?.teacher_last_name || teacher?.entered_teacher_last_name || teacher?.entered_user_last_name) : teacher?.teacher_last_name;
    const ts=teacher===markTeacher ? (teacher?.staff_no || teacher?.entered_teacher_staff_no) : teacher?.staff_no;
    return {
      subject_id:subjectId,subject_code:sm[0]?.subject_code||assigned?.subject_code||'',subject_name:sm[0]?.subject_name||assigned?.subject_name||'Subject',
      average:subjectAverage,average_basis:scoring.basis,grade:grade?.label||"",points:grade?.points??"",descriptor:grade?.descriptor||"",remark:grade?.remark||"",
      teacher_initials:teacher?teacherInitials(tf,tl,ts):"",
      teacher_name:teacher?teacherDisplay(tf,tl,ts):'',
      comment:sm.map(x=>String(x.remark||'').trim()).find(Boolean)||'',
      assessments:entries.map(e=>({
        id:e.assessment_id,name:e.name,type:e.type,mark:e.mark,max_mark:e.max_mark,
        percent:e.percent,weight:e.weight,include_in_term_average:e.include_in_term_average,
        column_key:e.column_key,cat:e.cat,counts_toward_average:countedColumns.has(e.column_key)
      }))
    };
  }));
  subjects.sort((a,b)=>a.subject_name.localeCompare(b.subject_name));
  // Build the report-local subject ranking before any consumer uses it.
  // It is based on the same final subject averages used by this report.
  const subjectRanking=[...subjects]
    .filter(s=>s.average!==null)
    .sort((a,b)=>b.average-a.average||a.subject_name.localeCompare(b.subject_name))
    .map((s,i)=>({...s,subject_rank:i+1}));
  // Keep the subject rank on each subject row as well as in the separate ranking list.
  const subjectRankMap=new Map(subjectRanking.map(x=>[String(x.subject_id),x.subject_rank]));
  subjects.forEach(s=>{s.subject_rank=subjectRankMap.get(String(s.subject_id))??null;});
  // Ranks are computed from the same subject scores shown on the report. The
  // former SQL ranking only counted three hard-coded assessment types, so a
  // learner's position could disagree with the average printed beside it.
  const peerClasses=await cached(`rank-classes|${schoolId}|${meta.class_name||meta.class_id}`,30000,async()=>{
    if(!meta.class_name)return (await db.query(`SELECT id,name FROM classes WHERE school_id=$1 AND id=$2`,[schoolId,meta.class_id])).rows;
    return (await db.query(`SELECT id,name FROM classes WHERE school_id=$1 AND name=$2`,[schoolId,meta.class_name])).rows;
  });
  const rankTable=await cached(`report-ranks|${schoolId}|${meta.class_id}|${yearId}|${termId}`,15000,async()=>{
    const classIds=peerClasses.map(c=>String(c.id));
    if(!classIds.length)return new Map();
    const learners=(await db.query(`
      SELECT DISTINCT m.learner_id,m.class_id
      FROM marks m
      WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
        AND m.class_id=ANY($4::uuid[]) AND m.mark IS NOT NULL`,
      [schoolId,yearId,termId,classIds])).rows;
    const peerMarks=(await db.query(`
      SELECT m.learner_id,m.class_id,m.subject_id,m.assessment_id,m.mark,
        COALESCE((SELECT ac.include_in_term_average FROM assessment_configurations ac
          WHERE ac.school_id=m.school_id AND ac.assessment_id=m.assessment_id
            AND (ac.subject_id=m.subject_id OR ac.subject_id IS NULL)
            AND (ac.section_id=$5 OR ac.section_id IS NULL) AND (ac.level_id=$6 OR ac.level_id IS NULL)
          ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_term_average
      FROM marks m
      WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
        AND m.class_id=ANY($4::uuid[]) AND m.mark IS NOT NULL`,
      [schoolId,yearId,termId,classIds,meta.section_id,meta.level_id])).rows;
    let profilesByClass=new Map();
    try{
      profilesByClass=new Map((await db.query(`
        SELECT class_id,selected_assessment_ids,cat_group_mode,custom_weights
        FROM merit_flex_profiles
        WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND class_id=ANY($4::uuid[])`,
        [schoolId,yearId,termId,classIds])).rows.map(row=>[String(row.class_id),row]));
    }catch(e){
      if(e.code!=='42P01'&&e.code!=='42703')throw e;
    }
    return computeRanks({learners,marks:peerMarks,assessments,profilesByClass,classes:peerClasses});
  });
  const rankRow=rankTable.get(String(learnerId))||null;
  const currentRanks=new Map(Object.entries(rankRow?.subject_ranks||{}).map(([subjectId,value])=>[subjectId,{subject_rank:value.rank,subject_learner_count:value.total}]));
  const reportAssessmentSql = "'OPENER','MID_TERM','END_TERM'";
  const priorRows=(await db.query(`
    WITH latest_terms AS (
      SELECT DISTINCT ON (ay.id) ay.id ay_id,t.id term_id,ay.year_label,t.term_no,ay.start_date
      FROM academic_years ay JOIN terms t ON t.academic_year_id=ay.id AND t.school_id=ay.school_id
      WHERE ay.school_id=$1 AND ay.id<>$2 AND t.term_no=$3
      ORDER BY ay.id DESC,t.term_no DESC
    )
    SELECT ay.year_label,m.subject_id,AVG((m.mark/NULLIF(a.max_mark,0))*100.0) average
    FROM latest_terms ay JOIN marks m ON m.academic_year_id=ay.ay_id AND m.term_id=ay.term_id
      JOIN assessments a ON a.id=m.assessment_id
    WHERE m.school_id=$1 AND m.learner_id=$4 AND m.mark IS NOT NULL
      AND a.assessment_type IN (${reportAssessmentSql})
    GROUP BY ay.year_label,ay.start_date,m.subject_id
    ORDER BY ay.start_date DESC NULLS LAST,ay.year_label DESC,m.subject_id`,[schoolId,yearId,meta.term_no,learnerId])).rows;
  const priorBySubject=new Map();for(const r of priorRows){if(!priorBySubject.has(r.subject_id))priorBySubject.set(r.subject_id,[]);priorBySubject.get(r.subject_id).push(r);}
  subjects.forEach(s=>{const rr=currentRanks.get(s.subject_id);const priors=priorBySubject.get(s.subject_id)||[];s.subject_rank=rr?Number(rr.subject_rank):null;s.subject_rank_total=rr?Number(rr.subject_learner_count):null;s.previous_years=priors.map(r=>({year_label:r.year_label,average:Number(r.average)}));const immediate=priors[0];s.previous_year_average=immediate?Number(immediate.average):null;s.previous_year_deviation=(immediate&&s.average!=null)?Number(s.average)-Number(immediate.average):null;});
  const overall=avg(subjects.map(s=>s.average));
  // Stream and whole-class positions come from computeRanks, the same scorer used
  // for the subject averages above. A learner in Grade 7A therefore sees both the
  // 7A position and the combined Grade 7 position across streams.
  const staffContext=await cached(`report-staff|${schoolId}|${meta.class_id}|${yearId}|${termId}`,15000,async()=>{
    let classTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM class_teacher_assignments cta JOIN teachers tr ON tr.id=cta.teacher_id WHERE cta.school_id=$1 AND cta.class_id=$2 AND cta.academic_year_id=$3 AND (cta.term_id=$4 OR cta.term_id IS NULL) AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY (cta.term_id IS NOT NULL) DESC,cta.created_at DESC LIMIT 1`,[schoolId,meta.class_id,yearId,termId])).rows[0];
    if(!classTeacher) classTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM teacher_subject_assignments tsa JOIN teachers tr ON tr.id=tsa.teacher_id WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3 AND (tsa.term_id=$4 OR tsa.term_id IS NULL) AND COALESCE(tsa.is_class_teacher,false)=true AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY (tsa.term_id IS NOT NULL) DESC,tsa.created_at DESC,tsa.id DESC LIMIT 1`,[schoolId,meta.class_id,yearId,termId])).rows[0];
    if(!classTeacher) classTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM teachers tr JOIN user_school_roles usr ON usr.user_id=tr.user_id AND usr.school_id=tr.school_id WHERE tr.school_id=$1 AND usr.role='CLASS_TEACHER' AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY tr.last_name,tr.first_name LIMIT 1`,[schoolId])).rows[0];
    let headTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM teachers tr LEFT JOIN user_school_roles usr ON usr.user_id=tr.user_id AND usr.school_id=tr.school_id WHERE tr.school_id=$1 AND (usr.role='HEADTEACHER' OR tr.imported_role='HEADTEACHER') AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY tr.last_name,tr.first_name LIMIT 1`,[schoolId])).rows[0];
    if(!headTeacher) headTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM teachers tr LEFT JOIN user_school_roles usr ON usr.user_id=tr.user_id AND usr.school_id=tr.school_id WHERE tr.school_id=$1 AND (usr.role IN ('SCHOOL_ADMIN','HEADTEACHER') OR tr.imported_role IN ('SCHOOL_ADMIN','HEADTEACHER')) AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY CASE WHEN usr.role='HEADTEACHER' THEN 0 ELSE 1 END,tr.last_name,tr.first_name LIMIT 1`,[schoolId])).rows[0];
    return {classTeacher,headTeacher};
  });
  const {classTeacher,headTeacher}=staffContext;
  // The currently active school stamp is authoritative for report cards. Do not
  // hide a newly uploaded stamp merely because its effective date is later than
  // the term's opening date; administrators expect an uploaded active stamp to
  // appear immediately on generated reports.
  const stamp=await cached(`report-stamp|${schoolId}`,30000,async()=>
    (await db.query(`SELECT file_url FROM school_document_assets WHERE school_id=$1 AND asset_type='STAMP' AND is_active=true AND (effective_to IS NULL OR effective_to>=CURRENT_DATE) ORDER BY effective_from DESC NULLS LAST,created_at DESC LIMIT 1`,[schoolId])).rows[0]||null
  );
  const overallGrading=await resolveGrading(schoolId,meta,null,null);
  const overallGrade=gradeFor(overall,overallGrading.bands);
  const averageBases=[...new Set(subjects.map(s=>s.average_basis).filter(Boolean))];
  const termAverageBasis=averageBases.length===1?averageBases[0]:(averageBases.length?'MIXED':null);
  const sorted=[...subjects].filter(s=>s.average!==null).sort((a,b)=>b.average-a.average);
  const strongest=sorted[0], weakest=sorted[sorted.length-1];
  const trend=subjects.flatMap(s=>s.assessments.filter(a=>a.percent!==null).map(a=>a.percent));
  const trendAvg=avg(trend);
  const trendText=trendAvg===null?"": overall!==null && trendAvg<overall-5?"The learner shows stronger performance in the current subject averages than in the assessment history.":"Assessment performance is generally consistent with the current subject averages.";
  let designationRecord=null;
  try {
    designationRecord=(await db.query(`SELECT designation,decision,attendance_days,school_open_days,conduct,effort,next_term_target,intervention_plan,teacher_comment,headteacher_comment
      FROM report_card_designations
      WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4`,[schoolId,learnerId,yearId,termId])).rows[0]||null;
  } catch (_) { /* Migration may not have been applied yet; reports remain operational. */ }
  let pathwayGuidance=null;
  try {
    pathwayGuidance=(await db.query(`SELECT selected_pathway,track_specialisation,pathway_evidence,strengths,competency_development,development_area,career_exploration,teacher_guidance
      FROM report_pathway_guidance
      WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4`,[schoolId,learnerId,yearId,termId])).rows[0]||null;
  } catch (_) { /* The additive pathway migration may not yet be installed. */ }
  let reportComments=[];
  try {
    reportComments=(await db.query(`SELECT comment_type,comment_text FROM report_comments
      WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4`,[schoolId,learnerId,yearId,termId])).rows;
  } catch (_) { /* Reports remain available if optional report-comment storage is absent. */ }
  const commentFor=types=>reportComments.find(c=>types.includes(String(c.comment_type||'').trim().toUpperCase()))?.comment_text||'';
  const designation=(designationRecord?.designation&&designationRecord.designation!=='AUTO')?designationRecord.designation:autoDesignation(overall);
  const progressionDecision=(designationRecord?.decision&&designationRecord.decision!=='AUTO')?designationRecord.decision:autoDecision(overall);

  return {
    ...meta,
    class_teacher:classTeacher?teacherDisplay(classTeacher.first_name,classTeacher.last_name,classTeacher.staff_no):"",
    class_teacher_initials:classTeacher?teacherInitials(classTeacher.first_name,classTeacher.last_name,classTeacher.staff_no):"",
    class_teacher_staff_no:classTeacher?.staff_no||"",
    class_teacher_signature_url:classTeacher?.signature_url||null,
    head_teacher:headTeacher?teacherDisplay(headTeacher.first_name,headTeacher.last_name,headTeacher.staff_no):"",
    head_teacher_staff_no:headTeacher?.staff_no||"",
    head_teacher_signature_url:headTeacher?.signature_url||null,
    stamp_url:stamp?.file_url||null,
    learner_name:[meta.first_name,meta.middle_name,meta.last_name].filter(Boolean).join(" "),
    subjects,
    subject_ranking:subjectRanking,
    // Class rank is calculated from the same subject-level averages used on this report.
    // Only learners with reportable marks participate, so a two-learner class can only
    // produce ranks 1 and 2.
    overall_class_rank: rankRow?Number(rankRow.class_rank):null,
    stream_rank: rankRow?Number(rankRow.stream_rank):null,
    stream_rank_total: rankRow?Number(rankRow.stream_rank_total):null,
    class_rank_total: rankRow?Number(rankRow.class_rank_total):null,
    previous_year_deviations: [...new Set(priorRows.map(p=>p.year_label))].map(year_label=>{const vals=subjects.flatMap(s=>(s.previous_years||[]).filter(p=>p.year_label===year_label).map(p=>({current:s.average,previous:p.average}))).filter(x=>x.current!=null);return {year_label,deviation:vals.length?vals.reduce((a,x)=>a+(x.current-x.previous),0)/vals.length:null};}).filter(x=>x.deviation!=null).sort((a,b)=>String(b.year_label).localeCompare(String(a.year_label))),
    assessments,
    // Every exam configured for the class/term is exposed to the renderer, including
    // CATs. The PDF prints one column per distinct exam name.
    exam_columns: examColumns.map(column=>({id:column.ids[0],key:column.key,type:column.type,name:column.name,max_mark:column.max_mark,weight:column.weight,cat:column.cat})),
    merit_profile_applied:Boolean(meritProfile),
    term_average_basis:termAverageBasis,
    overall_total_marks:subjects.reduce((sum,s)=>sum+(s.average==null?0:Number(s.average)),0),
    overall_total_marks_possible:subjects.filter(s=>s.average!=null).length*100,
    overall_average:overall,
    overall_grade:overallGrade?.label||"",
    overall_points:overallGrade?.points??"",
    grading_system:overallGrading.system,
    grading_bands:overallGrading.bands,
    class_teacher_remark:commentFor(['CLASS_TEACHER','CLASS_TEACHER_REMARK'])||designationRecord?.teacher_comment||'',
    head_teacher_remark:commentFor(['HEAD_TEACHER','HEAD_TEACHER_REMARK','HEADTEACHER'])||designationRecord?.headteacher_comment||'',
    assessment_trend_remark:trendText,
    strongest_subject:strongest?.subject_name||"",
    weakest_subject:weakest?.subject_name||"",
    designation,
    progression_decision:progressionDecision,
    attendance_days:designationRecord?.attendance_days??null,
    school_open_days:designationRecord?.school_open_days??null,
    conduct:designationRecord?.conduct||'',
    effort:designationRecord?.effort||'',
    next_term_target:designationRecord?.next_term_target??null,
    intervention_plan:designationRecord?.intervention_plan||'',
    recorded_teacher_comment:designationRecord?.teacher_comment||'',
    recorded_headteacher_comment:designationRecord?.headteacher_comment||'',
    identity_snapshot:meta.identity_snapshot||{},
    school_template_code:meta.school_template_code||'',
    report_template_name:meta.report_template_name||'',
    report_template_type:meta.report_template_type||'',
    report_template_config:meta.report_template_config||{},
    pathway_guidance:pathwayGuidance||{},
    next_term_id:meta.next_term_id||null,
    next_term_no:meta.next_term_no||null,
    next_term_name:meta.next_term_name||'',
    next_term_opening_date:meta.next_term_opening_date||null,
    next_term_closing_date:meta.next_term_closing_date||null,
    school_closing_date:meta.closing_date||null,
    school_reopening_date:meta.reopening_date||meta.next_term_opening_date||null
  };
}

// Short-lived whole-report cache speeds repeated report opens/previews while allowing
// new marks and assignments to appear automatically after a brief expiry.
function reportCacheKey(schoolId,learnerId,yearId,termId){return `report|${schoolId}|${learnerId}|${yearId}|${termId}`;}
async function buildTermReport(schoolId,learnerId,yearId,termId){
  return cached(reportCacheKey(schoolId,learnerId,yearId,termId),30000,async()=>{
    const report=await buildTermReportCore(schoolId,learnerId,yearId,termId);
    if(report)report.report_kind='TERM';
    return report;
  });
}

async function buildYearReport(schoolId,learnerId,yearId) {
  const terms=(await db.query(`SELECT id,term_no,name FROM terms WHERE school_id=$1 AND academic_year_id=$2 ORDER BY term_no`,[schoolId,yearId])).rows;
  const reports=(await Promise.all(terms.map(t=>buildTermReport(schoolId,learnerId,yearId,t.id)))).filter(Boolean);
  if(!reports.length) return null;
  const subjectMap=new Map();
  reports.forEach(r=>r.subjects.forEach(s=>{
    if(!subjectMap.has(s.subject_id)) subjectMap.set(s.subject_id,{...s,terms:{}});
    subjectMap.get(s.subject_id).terms[r.term_no]=s.average;
  }));
  const annualGrading=await resolveGrading(schoolId,reports[0],null,null);
  let subjects=[...subjectMap.values()].map(s=>{
    const annual_average=avg(Object.values(s.terms));
    const g=gradeFor(annual_average,annualGrading.bands);
    return {
      ...s,
      annual_average,
      grade:g?.label||'',
      points:g?.points??'',
      descriptor:g?.descriptor||'',
      remark:g?.remark||'',
      subject_rank:null
    };
  });
  subjects.sort((a,b)=>String(a.subject_name||'').localeCompare(String(b.subject_name||'')));
  const annualRanked=subjects.filter(s=>s.annual_average!=null)
    .slice().sort((a,b)=>Number(b.annual_average)-Number(a.annual_average)||String(a.subject_name||'').localeCompare(String(b.subject_name||'')));
  annualRanked.forEach((s,i)=>{s.subject_rank=i+1;});
  const annualOverall=avg(subjects.map(s=>s.annual_average));
  const g=gradeFor(annualOverall,annualGrading.bands);
  const annualTotal=subjects.reduce((sum,s)=>sum+(s.annual_average==null?0:Number(s.annual_average)),0);
  const annualPossible=subjects.filter(s=>s.annual_average!=null).length*100;
  const guidanceReport=reports[reports.length-1];
  return {
    ...reports[0],
    section_code:guidanceReport.section_code,
    section_name:guidanceReport.section_name,
    level_code:guidanceReport.level_code,
    level_name:guidanceReport.level_name,
    school_template_code:guidanceReport.school_template_code,
    report_template_name:guidanceReport.report_template_name,
    report_template_type:guidanceReport.report_template_type,
    report_template_config:guidanceReport.report_template_config,
    pathway_guidance:guidanceReport.pathway_guidance,
    subjects,
    subject_ranking:annualRanked,
    term_reports:reports,
    overall_total_marks:annualTotal,
    overall_total_marks_possible:annualPossible,
    overall_average:annualOverall,
    overall_grade:g?.label||"",
    overall_points:g?.points??"",
    grading_system:annualGrading.system,
    grading_bands:annualGrading.bands,
    report_kind:'ANNUAL'
  };
}

module.exports={buildTermReport,buildYearReport,avg,gradeFor,autoDesignation,autoDecision,invalidateReportCaches};
