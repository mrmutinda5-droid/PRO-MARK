const express=require('express'),db=require('../db');
const {source:assetSource}=require('../services/assets');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {assertBelongs}=require('../services/tenant');
const router=express.Router();
const markSheetPdfCache=new Map();
function getMarkSheetPdf(key){const hit=markSheetPdfCache.get(key);if(hit&&hit.expires>Date.now())return hit.value;if(hit)markSheetPdfCache.delete(key);return null;}
function putMarkSheetPdf(key,value){markSheetPdfCache.set(key,{value,expires:Date.now()+10000});if(markSheetPdfCache.size>48){const oldest=[...markSheetPdfCache.entries()].sort((a,b)=>a[1].expires-b[1].expires)[0];if(oldest)markSheetPdfCache.delete(oldest[0]);}}
router.use(authenticate);
const {canonicalAssessmentName}=require('../services/assessment-utils');
const {invalidateReportCaches}=require('../services/report-engine');
const {invalidateResultsCaches}=require('../services/results-engine');
const {invalidateReportPdfCache}=require('../services/report-pdf');
const MARK_ROLES=['PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'];
async function requireMarkEntryAccess(req,sid){
  if(!MARK_ROLES.includes(req.user.role))throw Object.assign(new Error('Mark Entry is not available for this role.'),{status:403});
  if(['PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN'].includes(req.user.role))return;
  const q=await db.query(`SELECT role FROM user_school_roles WHERE user_id=$1 AND school_id=$2 AND mark_entry_enabled=true LIMIT 1`,[req.user.user_id,sid]);
  if(!q.rows[0])throw Object.assign(new Error('Mark Entry is not activated for your account. Ask the administrator to activate it.'),{status:403});
}

// A user with mark-entry rights may still not be the teacher for the selected
// class/subject. Admins and heads retain school-wide entry; classroom staff must
// hold either the subject assignment or the class-teacher assignment.
async function enforceMarkEntryScope(req,sid,{classId,subjectId,academicYearId,termId}){
  if(['PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'].includes(req.user.role))return;
  const teacher=(await db.query(`SELECT id FROM teachers WHERE school_id=$1 AND user_id=$2 AND COALESCE(is_active,true)=true LIMIT 1`,[sid,req.user.user_id])).rows[0];
  if(!teacher)throw Object.assign(new Error('No active teacher profile is linked to this account.'),{status:403});
  const subjectScope=(await db.query(`
    SELECT 1 FROM teacher_subject_assignments
    WHERE school_id=$1 AND teacher_id=$2 AND class_id=$3 AND subject_id=$4
      AND academic_year_id=$5 AND (term_id=$6 OR term_id IS NULL OR $6::uuid IS NULL)
      AND COALESCE(is_active,true)=true LIMIT 1`,
    [sid,teacher.id,classId,subjectId,academicYearId,termId||null])).rows[0];
  if(subjectScope)return;
  const classScope=(await db.query(`
    SELECT 1 FROM class_teacher_assignments
    WHERE school_id=$1 AND teacher_id=$2 AND class_id=$3 AND academic_year_id=$4 LIMIT 1`,
    [sid,teacher.id,classId,academicYearId])).rows[0];
  if(!classScope)throw Object.assign(new Error('You can only enter marks for classes and subjects assigned to you.'),{status:403});
}

const validTypes=new Set(['OPENER','CAT','TEST','MID_TERM','END_TERM','MOCK','FINAL','CUSTOM']);

// Resolve the assessment selected by the UI to the one assessment belonging to
// the exact teacher assignment. Existing schools can contain legacy/global
// assessment rows as well as newer class+subject rows; every consumer of a
// selected assessment must therefore use the same resolution rule.
async function resolveAssessmentForAssignment(client,sid,assignment,assessmentId){
  let a=(await client.query(`
    SELECT id,name,assessment_type,max_mark,academic_year_id,term_id,deadline_at,status,class_id,subject_id,created_at
    FROM assessments WHERE id=$1 AND school_id=$2`,[assessmentId,sid])).rows[0];
  if(!a)return null;
  if(String(a.academic_year_id)!==String(assignment.academic_year_id))
    throw Object.assign(new Error('Assessment does not belong to this academic year'),{status:400});
  const needsExact=!a.class_id||!a.subject_id||String(a.class_id)!==String(assignment.class_id)||String(a.subject_id)!==String(assignment.subject_id);
  if(needsExact){
    const exact=(await client.query(`
      SELECT id,name,assessment_type,max_mark,academic_year_id,term_id,deadline_at,status,class_id,subject_id,created_at
      FROM assessments
      WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3
        AND class_id=$4 AND subject_id=$5
        AND (assessment_type=$6 OR lower(name)=lower($7))
      ORDER BY (assessment_type=$6) DESC,created_at DESC,id
      LIMIT 1`,[sid,assignment.academic_year_id,a.term_id,assignment.class_id,assignment.subject_id,a.assessment_type,String(a.name||'')])).rows[0];
    if(exact)a=exact;
  }
  if(a.class_id&&String(a.class_id)!==String(assignment.class_id))
    throw Object.assign(new Error('Assessment does not belong to this class'),{status:400});
  if(a.subject_id&&String(a.subject_id)!==String(assignment.subject_id))
    throw Object.assign(new Error('Assessment does not belong to this subject'),{status:400});
  return a;
}

// GET ASSESSMENTS LIST.
// Teacher Mark Entry uses this as the first step in the established flow:
// Assessment -> Class -> Subject -> learner roster.
// Keep this query deliberately simple: return every configured assessment for
// the selected school/year/term. The frontend/roster resolves duplicate legacy
// records to the exact class+subject assessment without changing stored data.
// Existing assessment/mark records are read only here.
router.get('/:schoolId/:yearId/:termId',schoolBoundary,async(req,res)=>{
  try{
    const sid=req.params.schoolId,yearId=req.params.yearId,termId=req.params.termId;
    await assertBelongs('academic_years',yearId,sid);
    await assertBelongs('terms',termId,sid);

    const q=await db.query(`
      SELECT a.id,a.name,a.assessment_type,a.max_mark,a.weight,
             a.academic_year_id,a.term_id,a.deadline_at,a.status,
             a.class_id,a.subject_id,a.created_at,a.assessment_order,
             a.include_in_final,
             c.name AS class_name,c.stream,
             s.code AS subject_code,s.name AS subject_name,
             t.term_no
      FROM assessments a
      LEFT JOIN classes c ON c.id=a.class_id
      LEFT JOIN subjects s ON s.id=a.subject_id
      JOIN terms t ON t.id=a.term_id
      WHERE a.school_id=$1::uuid
        AND a.academic_year_id=$2::uuid
        AND a.term_id=$3::uuid
        AND (
          a.assessment_type NOT IN ('OPENER','MID_TERM','END_TERM')
          OR a.include_in_final=true
        )
      ORDER BY
        CASE a.assessment_type
          WHEN 'OPENER' THEN 1
          WHEN 'MID_TERM' THEN 2
          WHEN 'END_TERM' THEN 3
          ELSE 4
        END,
        a.assessment_order NULLS LAST,
        a.created_at ASC,
        a.id`,
      [sid,yearId,termId]
    );

    const rows=q.rows||[];

    // Mark Entry must receive every valid assessment record. Do not collapse
    // OPENER/MID_TERM/END_TERM by type here because separate classes/subjects
    // can legitimately have separate assessment UUIDs. The Mark Entry roster
    // resolves the selected assessment against the exact teacher assignment.
    // Generic imported/configured assessments remain available as fallbacks.
    // This is read-only presentation logic; no stored marks are changed.
    const chosen=[...rows];

    const order={OPENER:1,CAT:2,CAT1:2,CAT2:2,MID_TERM:3,END_TERM:4};
    chosen.sort((a,b)=>{
      const ta=String(a.assessment_type||'').toUpperCase();
      const tb=String(b.assessment_type||'').toUpperCase();
      return (order[ta]||5)-(order[tb]||5)
        ||Number(a.assessment_order||0)-Number(b.assessment_order||0)
        ||String(a.name||'').localeCompare(String(b.name||''))
        ||String(a.id).localeCompare(String(b.id));
    });

    res.json(chosen.map(a=>({...a,canonical_name:a.name})));
  }catch(e){
    console.error('Assessment list load failed:',e);
    res.status(e.status||400).json({error:e.message||'Unable to load assessments'});
  }
});

// Return the subjects actually assigned to a class for the selected academic period.
router.get('/:schoolId/:yearId/:termId/class/:classId/subjects',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','TEACHER','SENIOR_TEACHER','CLASS_TEACHER'),async(req,res)=>{
  try{
    await assertBelongs('academic_years',req.params.yearId,req.params.schoolId);
    await assertBelongs('terms',req.params.termId,req.params.schoolId);
    await assertBelongs('classes',req.params.classId,req.params.schoolId);
    const q=await db.query(`
      SELECT DISTINCT s.id,s.code,s.name
      FROM teacher_subject_assignments tsa
      JOIN subjects s ON s.id=tsa.subject_id
      WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3
        AND (tsa.term_id=$4 OR tsa.term_id IS NULL)
        AND COALESCE(s.is_active,true)=true
      ORDER BY s.name,s.code
    `,[req.params.schoolId,req.params.classId,req.params.yearId,req.params.termId]);
    res.json(q.rows);
  }catch(e){res.status(e.status||400).json({error:e.message});}
});

// Create the administrator-selected assessment set for every subject assigned to a class.
router.post('/:schoolId/:yearId/:termId/class-bulk',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  const b=req.body||{},sid=req.params.schoolId,classId=b.class_id;
  const definitions=Array.isArray(b.assessments)?b.assessments:[];
  const subjectIds=Array.isArray(b.subject_ids)?b.subject_ids.filter(Boolean):[];
  if(!classId)return res.status(400).json({error:'Select a class first.'});
  if(!definitions.length||definitions.length>30)return res.status(400).json({error:'Add between 1 and 30 exams or CATs.'});
  try{
    await assertBelongs('academic_years',req.params.yearId,sid);
    await assertBelongs('terms',req.params.termId,sid);
    await assertBelongs('classes',classId,sid);
    const seenNames=new Set();
    const normalized=definitions.map((item,index)=>{
      const name=String(item?.name||'').trim();
      const kind=String(item?.kind||'MAIN').trim().toUpperCase();
      const max=Number(item?.max_mark);
      const key=name.toLocaleLowerCase();
      if(!name||name.length>60)throw Object.assign(new Error(`Exam ${index+1} must have a name of 1–60 characters.`),{status:400});
      if(!['MAIN','CAT'].includes(kind))throw Object.assign(new Error(`Invalid kind for ${name}.`),{status:400});
      if(!Number.isFinite(max)||max<=0||max>10000)throw Object.assign(new Error(`Maximum mark for ${name} must be greater than 0 and no more than 10000.`),{status:400});
      if(seenNames.has(key))throw Object.assign(new Error(`Exam/CAT names must be unique in this setup: ${name}.`),{status:400});
      seenNames.add(key);
      const canonical=key.replace(/[-_]+/g,' ').replace(/\s+/g,' ');
      const type=kind==='CAT'?'CAT':({
        opener:'OPENER',
        'mid term':'MID_TERM',
        'end term':'END_TERM'
      }[canonical]||'CUSTOM');
      return {name,kind,type,max,order:(index+1)*10};
    });
    let subjects=(await db.query(`
      SELECT DISTINCT s.id,s.code,s.name
      FROM teacher_subject_assignments tsa JOIN subjects s ON s.id=tsa.subject_id
      WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3
        AND COALESCE(s.is_active,true)=true
      ORDER BY s.name,s.code
    `,[sid,classId,req.params.yearId])).rows;
    if(subjectIds.length)subjects=subjects.filter(s=>subjectIds.includes(s.id));
    if(!subjects.length)return res.status(400).json({error:'No subjects are assigned to this class for the selected academic year/term.'});
    const client=await db.pool.connect(),created=[],skipped=[];
    try{
      await client.query('BEGIN');
      for(const definition of normalized){
        for(const subject of subjects){
          const exists=await client.query(`
            SELECT id FROM assessments
            WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3
              AND class_id=$4 AND subject_id=$5 AND assessment_type=$6
              AND lower(name)=lower($7) LIMIT 1`,
          [sid,req.params.yearId,req.params.termId,classId,subject.id,definition.type,definition.name]);
          if(exists.rowCount){skipped.push({subject_id:subject.id,assessment_type:definition.type,name:definition.name});continue;}
          const q=await client.query(`
            INSERT INTO assessments(
              school_id,academic_year_id,term_id,name,assessment_type,max_mark,weight,
              include_in_final,combine_group,assessment_order,status,class_id,subject_id,
              cat_enabled,final_conversion_weight
            ) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9,'OPEN',$10,$11,$12,0)
            RETURNING *`,
          [sid,req.params.yearId,req.params.termId,definition.name,definition.type,definition.max,
           definition.kind!=='CAT',definition.kind==='CAT'?'CATS':null,definition.order,
           classId,subject.id,definition.kind==='CAT']);
          created.push(q.rows[0]);
        }
      }
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
    invalidateReportCaches(); invalidateReportPdfCache(); invalidateResultsCaches();
    res.status(201).json({created:created.length,skipped:skipped.length,assessments:created,subjects:subjects.length,message:`Created ${created.length} assessment(s) for ${subjects.length} subject(s).`});
  }catch(e){res.status(e.status||400).json({error:e.message});}
});

// SAVE MARKS ENDPOINT
// Compatible with the current teacher_subject_assignments schema.
// The assignment table is term-independent; the selected assessment supplies
// the authoritative term_id.

// Validate mark input without converting invalid values into zero.
function parseZelimuMark(value,maxMark){
  if(value===null||value===undefined||value==='')return null;

  if(typeof value!=='number'&&typeof value!=='string')
    throw Object.assign(new Error('Invalid mark value.'),{status:400});

  if(typeof value==='string'&&!value.trim())
    throw Object.assign(new Error('Mark cannot contain only spaces.'),{status:400});

  const mark=Number(value);
  if(!Number.isFinite(mark)||mark<0||mark>Number(maxMark))
    throw Object.assign(
      new Error('Mark must be between 0 and '+maxMark),
      {status:400}
    );

  return mark;
}

router.post('/:schoolId/marks',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
  const b=req.body||{},sid=req.params.schoolId;
  try{
    await requireMarkEntryAccess(req,sid);
    for(const [table,key] of [['learners','learner_id'],['subjects','subject_id'],['classes','class_id'],['academic_years','academic_year_id'],['assessments','assessment_id']]){
      await assertBelongs(table,b[key],sid);
    }

    const learner=(await db.query(`SELECT class_id FROM learners WHERE id=$1 AND school_id=$2`,[b.learner_id,sid])).rows[0];
    if(!learner)return res.status(404).json({error:'Learner not found'});
    if(String(learner.class_id)!==String(b.class_id))return res.status(400).json({error:'Learner does not belong to the selected class'});

    const a=(await db.query(`SELECT id,max_mark,academic_year_id,term_id,deadline_at,status,class_id,subject_id FROM assessments WHERE id=$1 AND school_id=$2`,[b.assessment_id,sid])).rows[0];
    if(!a)return res.status(404).json({error:'Assessment not found'});
    if(String(a.academic_year_id)!==String(b.academic_year_id))return res.status(400).json({error:'Assessment does not belong to the selected academic year'});
    if(a.class_id && String(a.class_id)!==String(b.class_id))return res.status(400).json({error:'Assessment does not belong to the selected class'});
    if(a.subject_id && String(a.subject_id)!==String(b.subject_id))return res.status(400).json({error:'Assessment does not belong to the selected subject'});
    if(String(a.status||'OPEN').toUpperCase()!=='OPEN')return res.status(403).json({error:'Assessment is closed'});
    if(a.deadline_at && new Date(a.deadline_at)<=new Date())return res.status(403).json({error:'The assessment deadline has passed'});
    await enforceMarkEntryScope(req,sid,{classId:b.class_id,subjectId:b.subject_id,academicYearId:b.academic_year_id,termId:a.term_id});

    const mark=parseZelimuMark(b.mark,a.max_mark);
    if(mark!==null&&(!Number.isFinite(mark)||mark<0||mark>Number(a.max_mark))){
      return res.status(400).json({error:`Mark must be between 0 and ${a.max_mark}`});
    }

    const q=await db.query(`
      INSERT INTO marks(school_id,learner_id,subject_id,class_id,academic_year_id,term_id,assessment_id,mark,entered_by,remark)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(learner_id,subject_id,assessment_id)
      DO UPDATE SET mark=EXCLUDED.mark,remark=EXCLUDED.remark,entered_by=EXCLUDED.entered_by,updated_at=now()
      RETURNING *`,
      [sid,b.learner_id,b.subject_id,b.class_id,b.academic_year_id,a.term_id,b.assessment_id,mark,req.user.user_id,String(b.remark||'').trim()||null]
    );
    invalidateReportCaches(); invalidateReportPdfCache(); invalidateResultsCaches();
    res.json(q.rows);
  }catch(e){res.status(e.status||400).json({error:e.message});}
});

// BULK SAVE used by the teacher Mark Entry screen.
router.post('/:schoolId/marks/save',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
  const b=req.body||{},sid=req.params.schoolId;
  try{ await requireMarkEntryAccess(req,sid); }catch(e){ return res.status(e.status||403).json({error:e.message}); }
  const rows=Array.isArray(b.rows)?b.rows:[];
  if(!b.assignment_id)return res.status(400).json({error:'Teacher assignment is required.'});
  const assignment=(await db.query(`SELECT id,teacher_id,school_id,subject_id,class_id,academic_year_id FROM teacher_subject_assignments WHERE id=$1 AND school_id=$2 AND COALESCE(is_active,true)=true`,[b.assignment_id,sid])).rows[0];
  if(!assignment)return res.status(404).json({error:'Teacher assignment not found.'});
  if(['TEACHER','SENIOR_TEACHER','CLASS_TEACHER'].includes(req.user.role)){
    const own=(await db.query(`SELECT 1 FROM teachers WHERE id=$1 AND school_id=$2 AND user_id=$3 AND COALESCE(is_active,true)=true`,[assignment.teacher_id,sid,req.user.user_id])).rows[0];
    if(!own)return res.status(403).json({error:'You can only save marks for your own assigned subject and class.'});
  }
  if(!b.assessment_id)return res.status(400).json({error:'Assessment is required.'});
  if(!rows.length)return res.status(400).json({error:'No marks supplied.'});

  const learnerIds=rows.map(row=>String(row?.learner_id||''));
  if(learnerIds.some(id=>!id))
    return res.status(400).json({error:'Every mark must identify a learner.'});
  if(new Set(learnerIds).size!==learnerIds.length)
    return res.status(400).json({
      error:'Duplicate learner entries are not allowed in one mark submission.'
    });


  const client=await db.pool.connect();
  try{
    const assignment=(await client.query(`
      SELECT tsa.id assignment_id,tsa.teacher_id,tsa.subject_id,tsa.class_id,tsa.academic_year_id
      FROM teacher_subject_assignments tsa
      JOIN teachers th ON th.id=tsa.teacher_id
      WHERE tsa.id=$1 AND tsa.school_id=$2 AND COALESCE(tsa.is_active,true)=true AND COALESCE(th.is_active,true)=true`,
      [b.assignment_id,sid])).rows[0];

    if(!assignment)return res.status(404).json({error:'Teacher assignment not found.'});
    if(['TEACHER','SENIOR_TEACHER','CLASS_TEACHER'].includes(req.user.role)){
      const own=(await client.query(`SELECT 1 FROM teachers WHERE id=$1 AND school_id=$2 AND user_id=$3 AND COALESCE(is_active,true)=true`,[assignment.teacher_id,sid,req.user.user_id])).rows[0];
      if(!own)return res.status(403).json({error:'You are not assigned to this subject and class.'});
    }

    let assessment=await resolveAssessmentForAssignment(client,sid,assignment,b.assessment_id);
    if(!assessment)return res.status(404).json({error:'Assessment not found'});
    if(String(assessment.status||'OPEN').toUpperCase()!=='OPEN')
      return res.status(403).json({error:'Assessment is closed'});
    if(assessment.deadline_at && new Date(assessment.deadline_at)<=new Date())
      return res.status(403).json({error:'The assessment deadline has passed'});

    await client.query('BEGIN');
    let saved=0;

    for(const row of rows){
      const learner=(await client.query(
        `SELECT l.id
         FROM learners l
         WHERE l.id=$1
           AND l.school_id=$2
           AND (
             l.class_id=$3
             OR EXISTS (
               SELECT 1
               FROM learner_enrollments le
               WHERE le.school_id=l.school_id
                 AND le.learner_id=l.id
                 AND le.class_id=$3
                 AND le.academic_year_id=$4
                 AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
             )
           )`,
        [row.learner_id,sid,assignment.class_id,assignment.academic_year_id]
      )).rows[0];
      if(!learner)throw Object.assign(new Error('One or more learners do not belong to the selected class.'),{status:400});

      const mark=parseZelimuMark(row.mark,assessment.max_mark);
      if(mark!==null&&(!Number.isFinite(mark)||mark<0||mark>Number(assessment.max_mark))){
        throw Object.assign(new Error(`Mark must be between 0 and ${assessment.max_mark}`),{status:400});
      }

      await client.query(`
        INSERT INTO marks(school_id,learner_id,subject_id,class_id,academic_year_id,term_id,assessment_id,mark,entered_by,remark)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(learner_id,subject_id,assessment_id)
        DO UPDATE SET mark=EXCLUDED.mark,remark=EXCLUDED.remark,entered_by=EXCLUDED.entered_by,updated_at=now()`,
        [sid,row.learner_id,assignment.subject_id,assignment.class_id,assignment.academic_year_id,
         assessment.term_id,assessment.id,mark,req.user.user_id,null]
      );
      saved++;
    }

    await client.query('COMMIT');

    // Report two different facts to the teacher: how many non-blank marks
    // were committed by this save action, and how many non-blank marks now
    // exist in the database for the selected assessment. This prevents blank
    // rows from being reported as successfully saved marks.
    const totalSavedResult=await client.query(`
      SELECT COUNT(*)::int AS total_saved
      FROM marks
      WHERE school_id=$1
        AND class_id=$2
        AND subject_id=$3
        AND academic_year_id=$4
        AND term_id=$5
        AND assessment_id=$6
        AND mark IS NOT NULL`,
      [sid,assignment.class_id,assignment.subject_id,assignment.academic_year_id,assessment.term_id,assessment.id]);
    const totalSaved=Number(totalSavedResult.rows[0]?.total_saved||0);
    // A successful mark save must immediately invalidate report caches so the next
    // preview/PDF reflects the just-saved marks instead of a stale cached report.
    invalidateReportCaches(); invalidateReportPdfCache(); invalidateResultsCaches();
    const savedNonBlank=rows.reduce((n,row)=>n+(row.mark!==null && row.mark!=='' && Number.isFinite(Number(row.mark)) ? 1 : 0),0);
    const learnerIds=rows.map(r=>r.learner_id).filter(Boolean);
    const learnerRows=learnerIds.length?(await client.query(`SELECT id,first_name,middle_name,last_name,admission_no FROM learners WHERE school_id=$1 AND id=ANY($2::uuid[]) ORDER BY last_name NULLS LAST,first_name NULLS LAST,middle_name NULLS LAST`,[sid,learnerIds])).rows:[];
    const markByLearner=new Map(rows.map(r=>[String(r.learner_id),r.mark]));
    const savedLearners=learnerRows.map(l=>({learner_id:l.id,name:[l.first_name,l.middle_name,l.last_name].filter(Boolean).join(' '),admission_no:l.admission_no||'',mark:(markByLearner.get(String(l.id))===''||markByLearner.get(String(l.id))==null)?null:Number(markByLearner.get(String(l.id)))}));

    for(const key of markSheetPdfCache.keys()){
      if(key.startsWith(`${sid}|${assignment.id}|${assessment.id}|`))markSheetPdfCache.delete(key);
    }
    res.json({ok:true,saved:savedNonBlank,total_saved:totalSaved,saved_learners:savedLearners});
  }catch(e){
    try{await client.query('ROLLBACK')}catch{}
    res.status(e.status||400).json({error:e.message||'Unable to save marks'});
  }finally{
    client.release();
  }
});


// CREATE SINGLE ASSESSMENT
// CREATE SINGLE ASSESSMENT
router.post('/:schoolId/:yearId/:termId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  const b=req.body||{};
  try{
    const sid=req.params.schoolId,yearId=req.params.yearId,termId=req.params.termId;
    await assertBelongs('academic_years',yearId,sid);
    await assertBelongs('terms',termId,sid);
    const term=(await db.query(`SELECT term_no FROM terms WHERE id=$1 AND school_id=$2 AND academic_year_id=$3`,[termId,sid,yearId])).rows[0];
    if(!term)return res.status(404).json({error:'Term not found for this academic year.'});

    let type=String(b.assessment_type||'CUSTOM').trim().toUpperCase();
    const aliases={'MID TERM':'MID_TERM','MID-TERM':'MID_TERM','END TERM':'END_TERM','END-TERM':'END_TERM'};
    type=aliases[type]||type;
    const standardTypes=new Set(['OPENER','MID_TERM','END_TERM']);
    const nameMap={OPENER:'OPENER',MID_TERM:'MID TERM',END_TERM:'END TERM'};
    const standardForTerm=new Set(['OPENER','MID_TERM','END_TERM']);

    if(!validTypes.has(type))return res.status(400).json({error:'Invalid assessment type'});
    if(standardTypes.has(type)&&!standardForTerm.has(type))
      return res.status(400).json({error:`${nameMap[type]} is not used in Term ${term.term_no}.`});

    const name=standardTypes.has(type)?nameMap[type]:String(b.name||'').trim();
    const max=Number(b.max_mark),weight=Number(b.weight||0);
    if(!name)return res.status(400).json({error:'Assessment name is required'});
    if(!Number.isFinite(max)||max<=0)return res.status(400).json({error:'Maximum mark must be greater than 0'});
    if(!Number.isFinite(weight)||weight<0)return res.status(400).json({error:'Weight cannot be negative'});
    if(b.class_id)await assertBelongs('classes',b.class_id,sid);
    if(b.subject_id)await assertBelongs('subjects',b.subject_id,sid);

    // Standard assessment types are unique per school/year/term/class/subject.
    if(standardTypes.has(type)){
      const duplicate=(await db.query(`
        SELECT id FROM assessments
        WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3
          AND assessment_type=$4
          AND COALESCE(class_id,'00000000-0000-0000-0000-000000000000'::uuid)=COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
          AND COALESCE(subject_id,'00000000-0000-0000-0000-000000000000'::uuid)=COALESCE($6::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
        LIMIT 1`,
        [sid,yearId,termId,type,b.class_id||null,b.subject_id||null])).rows[0];
      if(duplicate){
        const existing=(await db.query(`SELECT * FROM assessments WHERE id=$1`,[duplicate.id])).rows[0];
        return res.status(200).json(existing);
      }
    }

    const q=await db.query(`
      INSERT INTO assessments(
        school_id,academic_year_id,term_id,name,assessment_type,max_mark,weight,
        include_in_final,combine_group,assessment_order,status,deadline_at,class_id,
        subject_id,cat_enabled,final_conversion_weight
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [sid,yearId,termId,name,type,max,weight,
       b.include_in_final!==false&&String(b.include_in_final)!=='false',
       String(b.combine_group||'').trim()||null,
       Number(b.assessment_order||0),
       String(b.status||'OPEN').toUpperCase(),
       b.deadline_at||null,b.class_id||null,b.subject_id||null,
       !!(b.cat_enabled===true||String(b.cat_enabled)==='true'),
       Number(b.final_conversion_weight||weight||0)]);
    invalidateReportCaches(); invalidateReportPdfCache(); invalidateResultsCaches();
    res.status(201).json(q.rows[0]);
  }catch(e){res.status(e.status||400).json({error:e.message||'Unable to create assessment'});}
});

// ADMIN ASSESSMENT CONTROL: save/clear deadline or close/reopen mark entry.
router.patch('/:schoolId/:yearId/:termId/:assessmentId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  try{
    const sid=req.params.schoolId,yearId=req.params.yearId,termId=req.params.termId,assessmentId=req.params.assessmentId;
    await assertBelongs('academic_years',yearId,sid);
    await assertBelongs('terms',termId,sid);
    const current=(await db.query(`
      SELECT * FROM assessments
      WHERE id=$1 AND school_id=$2 AND academic_year_id=$3 AND term_id=$4
    `,[assessmentId,sid,yearId,termId])).rows[0];
    if(!current)return res.status(404).json({error:'Assessment not found.'});

    const b=req.body||{};
    const status=b.status===undefined?String(current.status||'OPEN').toUpperCase():String(b.status).toUpperCase();
    const requestedClassId=String(b.class_id||'').trim();
    if(requestedClassId) await assertBelongs('classes',requestedClassId,sid);
    // The administrator may correct an assessment that was created with the wrong
    // maximum mark, name, weight or inclusion setting without recreating it.
    let nextName=current.name;
    if(b.name!==undefined){ nextName=String(b.name||'').trim(); if(!nextName||nextName.length>60)return res.status(400).json({error:'Assessment name must be between 1 and 60 characters.'}); }
    let nextMax=Number(current.max_mark);
    if(b.max_mark!==undefined){ nextMax=Number(b.max_mark); if(!Number.isFinite(nextMax)||nextMax<=0)return res.status(400).json({error:'Maximum mark must be greater than 0.'}); }
    let nextWeight=Number(current.weight||0);
    if(b.weight!==undefined){ nextWeight=Number(b.weight); if(!Number.isFinite(nextWeight)||nextWeight<0)return res.status(400).json({error:'Weight cannot be negative.'}); }
    const nextInclude=b.include_in_final===undefined?current.include_in_final!==false:!(b.include_in_final===false||String(b.include_in_final)==='false');
    const nextOrder=b.assessment_order===undefined?Number(current.assessment_order||0):Number(b.assessment_order||0);
    if(!Number.isFinite(nextOrder))return res.status(400).json({error:'Assessment order must be a number.'});
    if(!['OPEN','CLOSED'].includes(status))return res.status(400).json({error:'Assessment status must be OPEN or CLOSED.'});

    let deadline=null;
    if(b.deadline_at!==undefined && b.deadline_at!==null && String(b.deadline_at).trim()!==''){
      const d=new Date(b.deadline_at);
      if(Number.isNaN(d.getTime()))return res.status(400).json({error:'Invalid deadline.'});
      deadline=d.toISOString();
    }else if(b.deadline_at===undefined){
      deadline=current.deadline_at||null;
    }

    if(requestedClassId&&current.class_id&&String(current.class_id)!==requestedClassId)
      return res.status(400).json({error:'Selected assessment does not belong to the requested class.'});
    const classWide=Boolean(requestedClassId&&current.class_id&&String(current.class_id)===requestedClassId);
    if(b.max_mark!==undefined){
      const excessive=classWide
        ?(await db.query(`
          SELECT COUNT(*)::int count FROM marks m
          JOIN assessments a ON a.id=m.assessment_id
          WHERE a.school_id=$1 AND a.academic_year_id=$2 AND a.term_id=$3
            AND a.class_id=$4 AND a.assessment_type=$5
            AND lower(a.name)=lower($6) AND m.mark>$7
        `,[sid,yearId,termId,requestedClassId,current.assessment_type,current.name,nextMax])).rows[0]
        :(await db.query('SELECT COUNT(*)::int count FROM marks WHERE assessment_id=$1 AND mark>$2',[assessmentId,nextMax])).rows[0];
      if(Number(excessive?.count)>0)return res.status(409).json({error:`The new maximum mark is below ${excessive.count} existing mark(s). Correct those marks before lowering the maximum.`});
    }
    if(b.name!==undefined&&nextName.toLocaleLowerCase()!==String(current.name||'').toLocaleLowerCase()&&!classWide){
      const duplicate=(await db.query(`
        SELECT 1 FROM assessments
        WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3
          AND class_id IS NOT DISTINCT FROM $4::uuid
          AND subject_id IS NOT DISTINCT FROM $5::uuid
          AND lower(name)=lower($6) AND id<>$7 LIMIT 1
      `,[sid,yearId,termId,current.class_id,current.subject_id,nextName,assessmentId])).rowCount;
      if(duplicate)return res.status(409).json({error:'Another assessment with that name already exists for this class and subject.'});
    }
    if(b.name!==undefined&&nextName.toLocaleLowerCase()!==String(current.name||'').toLocaleLowerCase()&&classWide){
      const duplicate=(await db.query(`
        SELECT 1 FROM assessments target
        WHERE target.school_id=$1 AND target.academic_year_id=$2 AND target.term_id=$3
          AND target.class_id=$4 AND target.assessment_type=$5
          AND lower(target.name)=lower($6)
          AND EXISTS(
            SELECT 1 FROM assessments other
            WHERE other.school_id=target.school_id
              AND other.academic_year_id=target.academic_year_id
              AND other.term_id=target.term_id
              AND other.class_id=target.class_id
              AND other.subject_id IS NOT DISTINCT FROM target.subject_id
              AND lower(other.name)=lower($7) AND other.id<>target.id
          )
        LIMIT 1
      `,[sid,yearId,termId,requestedClassId,current.assessment_type,current.name,nextName])).rowCount;
      if(duplicate)return res.status(409).json({error:'Another assessment with the new name already exists in one or more subjects.'});
    }

    const client=await db.pool.connect();
    try{
      await client.query('BEGIN');
      const updateSql=classWide?`
        UPDATE assessments
        SET name=$1,max_mark=$2,weight=$3,include_in_final=$4,
            assessment_order=$5,deadline_at=$6,status=$7
        WHERE school_id=$8 AND academic_year_id=$9 AND term_id=$10
          AND class_id=$11 AND assessment_type=$12
          AND lower(name)=lower($13)
        RETURNING *
      `:`
        UPDATE assessments
        SET name=$1,max_mark=$2,weight=$3,include_in_final=$4,
            assessment_order=$5,deadline_at=$6,status=$7
        WHERE id=$8 AND school_id=$9 AND academic_year_id=$10 AND term_id=$11
        RETURNING *
      `;
      const params=classWide
        ?[nextName,nextMax,nextWeight,nextInclude,nextOrder,deadline,status,sid,yearId,termId,requestedClassId,current.assessment_type,current.name]
        :[nextName,nextMax,nextWeight,nextInclude,nextOrder,deadline,status,assessmentId,sid,yearId,termId];
      const q=await client.query(updateSql,params);
      let updatedCount=q.rowCount;
      if(requestedClassId&&(b.deadline_at!==undefined||b.status!==undefined)){
        const type=String(current.assessment_type||'').toUpperCase();
        const standard=['OPENER','MID_TERM','END_TERM'].includes(type);
        const peers=await client.query(`
          UPDATE assessments
          SET deadline_at=$1,status=$2
          WHERE school_id=$3 AND academic_year_id=$4 AND term_id=$5
            AND assessment_type=$6
            AND (class_id=$7 OR class_id IS NULL)
            AND ($8::boolean OR lower(name)=lower($9))
        `,[deadline,status,sid,yearId,termId,type,requestedClassId,standard,String(current.name||'')]);
        updatedCount=Math.max(1,peers.rowCount);
      }
      await client.query('COMMIT');
      invalidateReportCaches(); invalidateReportPdfCache(); invalidateResultsCaches();
      res.json({...(q.rows[0]||current),updated_count:updatedCount,deadline_at:deadline,status});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release();}
  }catch(e){
    console.error('Assessment control update failed:',e);
    res.status(e.status||400).json({error:e.message||'Unable to update assessment.'});
  }
});

// ADMIN ASSESSMENT REMOVAL: remove an incorrectly assigned assessment when no marks
// have been entered. Existing marks are never silently destroyed.
router.delete('/:schoolId/:yearId/:termId/:assessmentId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  const sid=req.params.schoolId,yearId=req.params.yearId,termId=req.params.termId,assessmentId=req.params.assessmentId;
  const c=await db.pool.connect();
  try{
    await assertBelongs('academic_years',yearId,sid); await assertBelongs('terms',termId,sid);
    const a=(await c.query(`SELECT id,name,(SELECT COUNT(*)::int FROM marks m WHERE m.assessment_id=assessments.id) mark_count FROM assessments WHERE id=$1 AND school_id=$2 AND academic_year_id=$3 AND term_id=$4`,[assessmentId,sid,yearId,termId])).rows[0];
    if(!a)return res.status(404).json({error:'Assessment not found.'});
    if(Number(a.mark_count)>0)return res.status(409).json({error:`Cannot remove ${a.name} because ${a.mark_count} mark(s) are already recorded. Close it instead so existing results are preserved.`});
    await c.query('BEGIN');
    await c.query('DELETE FROM assessment_configurations WHERE school_id=$1 AND assessment_id=$2',[sid,assessmentId]);
    const q=await c.query('DELETE FROM assessments WHERE id=$1 AND school_id=$2 AND academic_year_id=$3 AND term_id=$4 RETURNING id,name',[assessmentId,sid,yearId,termId]);
    await c.query('COMMIT');
    invalidateReportCaches(); invalidateReportPdfCache(); invalidateResultsCaches();
    res.json({ok:true,removed:q.rows[0]});
  }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message||'Unable to remove assessment.'});}finally{c.release();}
});


// STORED MARKS / RESULTS VIEW
router.get('/:schoolId/marks',schoolBoundary,roles('PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
  const sid=req.params.schoolId,y=String(req.query.academic_year_id||'').trim(),t=String(req.query.term_id||'').trim(),cls=String(req.query.class_id||'').trim(),sub=String(req.query.subject_id||'').trim(),aid=String(req.query.assessment_id||'').trim();
  try{
    if(!y||!t)return res.status(400).json({error:'Academic year and term are required.'});
    await assertBelongs('academic_years',y,sid); await assertBelongs('terms',t,sid);
    const params=[sid,y,t]; let n=4; let where=`m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3`;
    if(cls){where+=` AND m.class_id=$${n++}`;params.push(cls);} if(sub){where+=` AND m.subject_id=$${n++}`;params.push(sub);} if(aid){where+=` AND m.assessment_id=$${n++}`;params.push(aid);}
    // Saved-mark visibility is deliberately narrow:
    // administrators/owners choose a class and then only subjects configured for that class;
    // teacher-level users can only trace marks for their own assigned subject/class.
    const teacherRoles=['TEACHER','CLASS_TEACHER','SENIOR_TEACHER'];
    if(teacherRoles.includes(req.user.role)){
      if(!cls || !sub) return res.status(400).json({error:'Select your class and subject to view saved marks.'});
      const teacherPart=`EXISTS (SELECT 1 FROM teacher_subject_assignments tsa JOIN teachers tt ON tt.id=tsa.teacher_id WHERE tsa.school_id=m.school_id AND tt.user_id=$${n} AND tt.school_id=m.school_id AND tsa.academic_year_id=m.academic_year_id AND tsa.class_id=m.class_id AND tsa.subject_id=m.subject_id AND COALESCE(tsa.is_active,true)=true AND (tsa.term_id=m.term_id OR tsa.term_id IS NULL))`;
      params.push(req.user.user_id); n++;
      where+=` AND ${teacherPart}`;
    }else if(req.user.role==='HEADTEACHER' || req.user.role==='DEPUTY_HEADTEACHER'){
      if(!cls) return res.status(400).json({error:'Select a class to view saved marks.'});
    }else if(req.user.role==='PLATFORM_OWNER' || req.user.role==='SCHOOL_ADMIN' || req.user.role==='ADMIN'){
      if(!cls) return res.status(400).json({error:'Select a class first. Subjects are filtered to that class.'});
      if(sub){
        const allowed=(await db.query(`SELECT 1 FROM teacher_subject_assignments tsa WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.subject_id=$3 AND tsa.academic_year_id=$4 AND COALESCE(tsa.is_active,true)=true LIMIT 1`,[sid,cls,sub,y])).rows[0];
        if(!allowed)return res.status(403).json({error:'That subject is not assigned to the selected class.'});
      }
    }
    const q=await db.query(`SELECT m.id,m.learner_id,m.class_id,m.subject_id,m.academic_year_id,m.term_id,m.assessment_id,m.mark,m.remark,m.updated_at,l.admission_no,l.first_name,l.middle_name,l.last_name,c.name class_name,c.stream,lv.name level_name,s.code subject_code,s.name subject_name,a.name assessment_name,a.assessment_type,a.max_mark,a.assessment_order FROM marks m JOIN learners l ON l.id=m.learner_id LEFT JOIN classes c ON c.id=m.class_id LEFT JOIN school_levels lv ON lv.id=c.school_level_id JOIN subjects s ON s.id=m.subject_id JOIN assessments a ON a.id=m.assessment_id WHERE ${where} ORDER BY c.name,c.stream,l.last_name,l.first_name,s.name,a.assessment_order,a.created_at`,params);
    res.json(q.rows);
  }catch(e){console.error('Marks results load failed:',e);res.status(e.status||400).json({error:e.message||'Unable to load saved marks.'});}
});

// TEACHER ROSTER / MARK SHEET CONTEXT
// This endpoint is the bridge used by the existing Mark Entry screen. It does
// not create a new marks engine: it resolves the existing teacher assignment,
// assessment and learner roster, then returns the marks already stored in marks.
router.get('/:schoolId/assignment/:assignmentId/roster',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
  const sid=req.params.schoolId, aid=req.params.assignmentId, requestedTerm=String(req.query.term_id||'').trim();
  try{
    const assignment=(await db.query(`
      SELECT a.id AS assignment_id,a.school_id,a.teacher_id,a.subject_id,a.class_id,a.academic_year_id,a.term_id,
             s.code subject_code,s.name subject_name,c.name class_name,c.stream,
             lv.name level_name,ay.year_label,tm.name term_name
      FROM teacher_subject_assignments a
      JOIN subjects s ON s.id=a.subject_id
      JOIN classes c ON c.id=a.class_id
      JOIN school_levels lv ON lv.id=c.school_level_id
      JOIN academic_years ay ON ay.id=a.academic_year_id
      LEFT JOIN terms tm ON tm.id=a.term_id
      WHERE a.id=$1 AND a.school_id=$2 AND COALESCE(a.is_active,true)=true`,[aid,sid])).rows[0];
    if(!assignment)return res.status(404).json({error:'Teacher assignment not found'});

    if(['TEACHER','SENIOR_TEACHER','CLASS_TEACHER'].includes(req.user.role)){
      const own=(await db.query(`SELECT 1 FROM teachers WHERE id=$1 AND school_id=$2 AND user_id=$3 AND COALESCE(is_active,true)=true`,[assignment.teacher_id,sid,req.user.user_id])).rows[0];
      if(!own)return res.status(403).json({error:'You are not assigned to this subject and class.'});
    }

    const termId=requestedTerm || assignment.term_id || null;
    if(termId) await assertBelongs('terms',termId,sid);

    const assessmentParams=[sid,assignment.academic_year_id,assignment.class_id,assignment.subject_id];
    let termSql='';
    if(termId){assessmentParams.push(termId);termSql=` AND a.term_id=$${assessmentParams.length}`;}
    const assessments=(await db.query(`
      SELECT a.id,a.name,a.assessment_type,a.max_mark,a.weight,a.status,a.deadline_at,
             a.class_id,a.subject_id,a.academic_year_id,a.term_id,a.assessment_order,a.created_at,
             COUNT(m.id)::int AS mark_count,
             a.name AS canonical_name
      FROM assessments a
      LEFT JOIN marks m
        ON m.assessment_id=a.id
       AND m.school_id=a.school_id
       AND m.academic_year_id=a.academic_year_id
       AND m.term_id=a.term_id
      WHERE a.school_id=$1
        AND a.academic_year_id=$2
        AND (a.assessment_type NOT IN ('OPENER','MID_TERM','END_TERM') OR a.include_in_final=true)
        AND (a.class_id IS NULL OR a.class_id=$3)
        AND (a.subject_id IS NULL OR a.subject_id=$4)
        ${termSql}
      GROUP BY a.id
      ORDER BY
        CASE a.assessment_type
          WHEN 'OPENER' THEN 1
          WHEN 'CAT' THEN 2
          WHEN 'CAT1' THEN 2
          WHEN 'CAT2' THEN 2
          WHEN 'MID_TERM' THEN 3
          WHEN 'END_TERM' THEN 4
          ELSE 5
        END,
        a.assessment_order NULLS LAST,
        a.created_at ASC,
        a.id
    `,assessmentParams)).rows;

    // Do not collapse standard assessments by type. Every assessment UUID
    // remains available so existing marks stay attached to the exact record.
    // Class/subject scope has already been restricted above; generic records
    // remain available for imported/configured assessment data.

    const learners=(await db.query(`
      SELECT DISTINCT l.id learner_id,l.admission_no,l.first_name,l.middle_name,l.last_name,l.gender,l.passport_photo_url
      FROM learners l
      LEFT JOIN learner_enrollments le ON le.learner_id=l.id AND le.school_id=$1 AND le.academic_year_id=$2
      WHERE l.school_id=$1 AND l.is_active=true
        AND (
          l.class_id=$3
          OR EXISTS (
            SELECT 1 FROM learner_enrollments le2
            WHERE le2.school_id=l.school_id
              AND le2.learner_id=l.id
              AND le2.academic_year_id=$2
              AND le2.class_id=$3
              AND COALESCE(le2.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
          )
        )
      ORDER BY l.last_name,l.first_name,l.middle_name`,[sid,assignment.academic_year_id,assignment.class_id])).rows;

    const assessmentIds=assessments.map(x=>x.id);
    let marks=[];
    if(assessmentIds.length && learners.length){
      marks=(await db.query(`
        SELECT learner_id,assessment_id,mark,remark,updated_at
        FROM marks
        WHERE school_id=$1 AND subject_id=$2 AND class_id=$3 AND academic_year_id=$4
          AND learner_id = ANY($5::uuid[]) AND assessment_id = ANY($6::uuid[])`,
        [sid,assignment.subject_id,assignment.class_id,assignment.academic_year_id,learners.map(x=>x.learner_id),assessmentIds])).rows;
    }
    const byLearner=new Map();
    for(const m of marks){if(!byLearner.has(m.learner_id))byLearner.set(m.learner_id,[]);byLearner.get(m.learner_id).push(m);}
    res.json({ok:true,assignment,assessments,learners:learners.map(l=>({...l,marks:byLearner.get(l.learner_id)||[]}))});
  }catch(e){console.error('Teacher roster load failed:',e);res.status(e.status||400).json({error:e.message||'Unable to load mark sheet'});}
});

// Existing teacher download: the same stored marks are rendered as an A4 mark sheet.
router.get('/:schoolId/assignment/:assignmentId/marks-pdf',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
  try{
    const sid=req.params.schoolId,aid=req.params.assignmentId,assessmentId=String(req.query.assessment_id||'').trim();
    if(!assessmentId)return res.status(400).json({error:'Assessment is required'});
    const assignment=(await db.query(`
      SELECT a.id assignment_id,a.teacher_id,a.subject_id,a.class_id,a.academic_year_id,s.code subject_code,s.name subject_name,c.name class_name,c.stream,lv.name level_name,ay.year_label,sc.name school_name,si.motto,si.contact_email,si.primary_color,si.logo_url
      FROM teacher_subject_assignments a JOIN subjects s ON s.id=a.subject_id JOIN classes c ON c.id=a.class_id JOIN school_levels lv ON lv.id=c.school_level_id JOIN academic_years ay ON ay.id=a.academic_year_id JOIN schools sc ON sc.id=a.school_id LEFT JOIN school_identity si ON si.school_id=a.school_id
      WHERE a.id=$1 AND a.school_id=$2 AND COALESCE(a.is_active,true)=true`,[aid,sid])).rows[0];
    if(!assignment)return res.status(404).json({error:'Teacher assignment not found'});
    if(['TEACHER','SENIOR_TEACHER','CLASS_TEACHER'].includes(req.user.role)){
      const own=(await db.query(`SELECT 1 FROM teachers WHERE id=$1 AND school_id=$2 AND user_id=$3 AND COALESCE(is_active,true)=true`,[assignment.teacher_id,sid,req.user.user_id])).rows[0];
      if(!own)return res.status(403).json({error:'You are not assigned to this subject and class.'});
    }
    let a=await resolveAssessmentForAssignment(db,sid,assignment,assessmentId);
    if(!a)return res.status(404).json({error:'Assessment not found'});
    const rows=(await db.query(`
      SELECT l.admission_no,l.first_name,l.middle_name,l.last_name,m.mark,m.updated_at
      FROM learners l
      LEFT JOIN marks m ON m.learner_id=l.id AND m.school_id=$1 AND m.subject_id=$2 AND m.class_id=$3 AND m.assessment_id=$4
      WHERE l.school_id=$1 AND l.is_active=true AND (
        l.class_id=$3 OR EXISTS (
          SELECT 1 FROM learner_enrollments le
          WHERE le.school_id=l.school_id AND le.learner_id=l.id
            AND le.academic_year_id=$5 AND le.class_id=$3
            AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
        )
      )
      ORDER BY l.last_name,l.first_name,l.middle_name`,[sid,assignment.subject_id,assignment.class_id,a.id,assignment.academic_year_id])).rows;
    const cacheKey=`${sid}|${aid}|${a.id}|${rows.map(r=>r.updated_at||'').join(',')}`;
    const cachedPdf=getMarkSheetPdf(cacheKey);
    if(cachedPdf){
      res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Length',String(cachedPdf.length));
      res.setHeader('Content-Disposition',`attachment; filename="mark-sheet-${String(assignment.class_name||'class').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-${String(assignment.subject_code||'subject').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-${String(a.name||a.assessment_type||'assessment').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.pdf"`);
      return res.end(cachedPdf);
    }
    const PDFDocument=require('pdfkit');
    const doc=new PDFDocument({size:'A4',margin:36});
    const pdfChunks=[];const pdfDone=new Promise((resolve,reject)=>{doc.on('data',c=>pdfChunks.push(c));doc.on('end',()=>resolve(Buffer.concat(pdfChunks)));doc.on('error',reject);});
    const W=doc.page.width-doc.page.margins.left-doc.page.margins.right,x=doc.page.margins.left,navy=assignment.primary_color||'#17365D';
    const logoPath=assetSource(assignment.logo_url);
    if(logoPath)try{doc.save().opacity(.045);doc.image(logoPath,x+W/2-130,doc.page.height/2-130,{fit:[260,260]});doc.restore();}catch{}
    if(logoPath)try{doc.image(logoPath,x+W/2-34,30,{fit:[68,68],align:'center',valign:'center'});}catch{}
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(18).text(assignment.school_name||'SCHOOL',x,104,{width:W,align:'center'});
    doc.fillColor('#555').font('Helvetica').fontSize(9).text(assignment.motto||'',x,128,{width:W,align:'center'});
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(14).text('TEACHER MARK ENTRY SHEET',x,148,{width:W,align:'center'});
    doc.fillColor('#333').font('Helvetica').fontSize(9).text(`${assignment.level_name||''} · ${assignment.class_name||''}${assignment.stream?' · '+assignment.stream:''} · ${assignment.subject_name||''} · ${a.name||a.assessment_type}`,x,170,{width:W,align:'center'});
    let y=200;const widths=[32,105,250,80];
    const header=()=>{doc.fillColor(navy).rect(x,y,W,22).fill();let xx=x;doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);['#','ADMISSION','LEARNER','MARK'].forEach((h,i)=>{doc.text(h,xx+4,y+7,{width:widths[i]-8,align:i===0||i===3?'center':'left'});xx+=widths[i]});y+=22;};
    header();rows.forEach((r,i)=>{if(y>doc.page.height-55){doc.addPage();y=40;header();}doc.fillColor('#222').font('Helvetica').fontSize(8);let xx=x;[String(i+1),r.admission_no||'—',[r.first_name,r.middle_name,r.last_name].filter(Boolean).join(' '),r.mark==null?'':Number(r.mark).toString()].forEach((v,j)=>{doc.text(String(v),xx+4,y+7,{width:widths[j]-8,align:j===0||j===3?'center':'left'});xx+=widths[j]});doc.strokeColor('#71808F').lineWidth(.7).rect(x,y,W,22).stroke();y+=22;});
    doc.fillColor('#536170').fontSize(7).text(`ZELIMU CBC • ${assignment.contact_email||'School contact email'} • Maximum mark: ${a.max_mark} • Total entered: ${rows.filter(r=>r.mark!=null).length} / ${rows.length}`,x,doc.page.height-48,{width:W,align:'right'});doc.end();
    const pdf=await pdfDone;if(!pdf||!pdf.length)throw new Error('The mark sheet PDF was generated empty.');
    putMarkSheetPdf(cacheKey,pdf);
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Length',String(pdf.length));res.setHeader('Content-Disposition',`attachment; filename="mark-sheet-${String(assignment.class_name||'class').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-${String(assignment.subject_code||'subject').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-${String(a.name||'assessment').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.pdf"`);res.end(pdf);
  }catch(e){console.error('Mark sheet PDF failed:',e);if(!res.headersSent)res.status(e.status||400).json({error:e.message||'Unable to create mark sheet'});}
});


module.exports=router;
