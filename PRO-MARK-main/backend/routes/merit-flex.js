'use strict';
// Optional dynamic assessment selection. Existing official merit routes remain untouched.
const express=require('express'),db=require('../db');
const {authenticate,schoolBoundary,roles}=require('../middleware/auth');
const {calculate}=require('../services/merit-flex-engine');
const {invalidateReportCaches}=require('../services/report-engine');
const {invalidateReportPdfCache}=require('../services/report-pdf');
const router=express.Router();router.use(authenticate);
const view=roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER');
const edit=roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validContext(sid,q){return [sid,q.academic_year_id,q.term_id,q.class_id].every(v=>uuid.test(String(v||'')));}
async function scope(sid,q){const r=await db.query('SELECT 1 FROM classes c JOIN academic_years y ON y.school_id=c.school_id AND y.id=$2 JOIN terms t ON t.school_id=c.school_id AND t.academic_year_id=y.id AND t.id=$3 WHERE c.school_id=$1 AND c.id=$4',[sid,q.academic_year_id,q.term_id,q.class_id]);return !!r.rowCount;}
async function teacherAccess(req,sid,q){if(req.user.role!=='CLASS_TEACHER'&&req.user.role!=='TEACHER')return true;const r=await db.query('SELECT 1 FROM class_teacher_assignments a JOIN teachers th ON th.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND th.user_id=$4 LIMIT 1',[sid,q.class_id,q.academic_year_id,req.user.user_id]);return !!r.rowCount;}
function fail(res,e){
  console.error('[MERIT-FLEX ERROR]', e);
  if(e.code==='42P01'||e.code==='42703')
    return res.status(503).json({error:'Apply database migrations 030_merit_flex_profiles.sql and 031_merit_flex_custom_weights.sql before configuring overall merit.'});
  res.status(e.status||500).json({
    error:e.status?e.message:'Unable to process flexible merit.',
    detail:process.env.NODE_ENV==='production'?undefined:e.message
  });
}
router.get('/:schoolId/setup',schoolBoundary,view,async(req,res)=>{try{const sid=req.params.schoolId,q=req.query;if(!validContext(sid,q))return res.status(400).json({error:'Select school, year, term and class.'});if(!await scope(sid,q))return res.status(404).json({error:'Invalid class or academic context.'});if(!await teacherAccess(req,sid,q))return res.status(403).json({error:'Class not assigned.'});const a=await db.query('SELECT id,name,assessment_type,max_mark,class_id,subject_id,include_in_final FROM assessments WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND (class_id IS NULL OR class_id=$4) ORDER BY assessment_order NULLS LAST,name,id',[sid,q.academic_year_id,q.term_id,q.class_id]);const p=await db.query('SELECT selected_assessment_ids,cat_group_mode,custom_weights FROM merit_flex_profiles WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND class_id=$4',[sid,q.academic_year_id,q.term_id,q.class_id]);res.json({assessments:a.rows,profile:p.rows[0]||null});}catch(e){fail(res,e)}});
router.put('/:schoolId/profile',schoolBoundary,edit,async(req,res)=>{try{const sid=req.params.schoolId,q=req.body;if(!validContext(sid,q))return res.status(400).json({error:'Select school, year, term and class.'});if(!await scope(sid,q))return res.status(404).json({error:'Invalid class or academic context.'});const ids=q.selected_assessment_ids,mode=q.cat_group_mode;if(!Array.isArray(ids)||!ids.length||ids.length>1000||!ids.every(id=>uuid.test(String(id)))||new Set(ids).size!==ids.length||!['INDIVIDUAL','CAT_GROUP','CUSTOM'].includes(mode))return res.status(400).json({error:'Select valid assessments and averaging method.'});const weights=q.custom_weights||{};if(mode==='CUSTOM'&&(!weights||typeof weights!=='object'||Array.isArray(weights)||Object.keys(weights).length!==ids.length||ids.some(id=>!Object.prototype.hasOwnProperty.call(weights,id)||!Number.isFinite(Number(weights[id]))||Number(weights[id])<0||Number(weights[id])>100)))return res.status(400).json({error:'Invalid custom assessment weights.'});const a=await db.query('SELECT id FROM assessments WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND (class_id IS NULL OR class_id=$4) AND id=ANY($5::uuid[])',[sid,q.academic_year_id,q.term_id,q.class_id,ids]);if(a.rowCount!==ids.length)return res.status(400).json({error:'One or more assessments are outside this school, class or term.'});

if(mode==='CUSTOM'){
  const subjectRows=await db.query(
    `SELECT DISTINCT subject_id
     FROM teacher_subject_assignments
     WHERE school_id=$1 AND academic_year_id=$2 AND class_id=$3`,
    [sid,q.academic_year_id,q.class_id]
  );

  const assessmentRows=await db.query(
    `SELECT id,subject_id
     FROM assessments
     WHERE school_id=$1 AND academic_year_id=$2
       AND term_id=$3 AND id=ANY($4::uuid[])`,
    [sid,q.academic_year_id,q.term_id,ids]
  );

  for(const subject of subjectRows.rows){
    const applicable=assessmentRows.rows.filter(
      a=>!a.subject_id||String(a.subject_id)===String(subject.subject_id)
    );

    if(!applicable.length)
      return res.status(400).json({
        error:'Some assigned subjects have no selected assessments.'
      });

    const total=applicable.reduce(
      (sum,a)=>sum+Number(weights[a.id]||0),0
    );

    if(Math.abs(total-100)>0.02)
      return res.status(400).json({
        error:'Assessment percentages must total 100% for every subject.'
      });
  }
}
const saved=await db.query(`INSERT INTO merit_flex_profiles(school_id,academic_year_id,term_id,class_id,selected_assessment_ids,cat_group_mode,custom_weights) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb) ON CONFLICT(school_id,academic_year_id,term_id,class_id) DO UPDATE SET selected_assessment_ids=excluded.selected_assessment_ids,cat_group_mode=excluded.cat_group_mode,custom_weights=excluded.custom_weights,updated_at=now() RETURNING *`,[sid,q.academic_year_id,q.term_id,q.class_id,JSON.stringify(ids),mode,JSON.stringify(mode==='CUSTOM'?weights:{})]);invalidateReportCaches();invalidateReportPdfCache();res.json({profile:saved.rows[0]});}catch(e){fail(res,e)}});

router.get('/:schoolId/preview',schoolBoundary,view,async(req,res)=>{
 try{
  const sid=req.params.schoolId,q=req.query;
  if(!validContext(sid,q))
   return res.status(400).json({error:'Select year, term and class.'});
  if(!await scope(sid,q))
   return res.status(404).json({error:'Invalid academic context.'});
  if(!await teacherAccess(req,sid,q))
   return res.status(403).json({error:'Class not assigned.'});

  const all=(await db.query(`
   SELECT id,name,assessment_type,assessment_order,class_id,subject_id
   FROM assessments
   WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3
     AND (class_id IS NULL OR class_id=$4)
   ORDER BY assessment_order NULLS LAST,name,id
  `,[sid,q.academic_year_id,q.term_id,q.class_id])).rows;

  const key=a=>
   String(a.name||'').trim().toUpperCase().replace(/\s+/g,' ');

  const requested=String(q.assessment_name||'').trim()
   .toUpperCase().replace(/\s+/g,' ');

  let chosen,mode,weights={},basis;

  if(requested){
   chosen=all.filter(a=>key(a)===requested);
   if(!chosen.length)
    return res.status(404).json({error:'Examination not found.'});
   mode='INDIVIDUAL';
   basis='INDIVIDUAL_EXAM';
  }else{
   const profile=(await db.query(`
    SELECT selected_assessment_ids,cat_group_mode,custom_weights
    FROM merit_flex_profiles
    WHERE school_id=$1 AND academic_year_id=$2
      AND term_id=$3 AND class_id=$4
   `,[sid,q.academic_year_id,q.term_id,q.class_id])).rows[0];

   if(!profile)
    return res.status(409).json({
     error:'Save the merit configuration in Examination Setup first.'
    });

   const ids=profile.selected_assessment_ids||[];
   chosen=all.filter(a=>ids.includes(String(a.id)));
   if(!chosen.length||chosen.length!==ids.length)
    return res.status(409).json({
     error:'Saved assessments have changed. Update merit configuration.'
    });

   mode=profile.cat_group_mode;
   weights=profile.custom_weights||{};
   basis='FLEXIBLE_TERM_PREVIEW';
  }

  const ids=chosen.map(a=>String(a.id));
  const cats=chosen.filter(a=>
   /CAT|CONTINUOUS/i.test(
    String(a.assessment_type)+' '+a.name
   )
  ).map(a=>String(a.id));

  const subjectDetails=(await db.query(`
   SELECT DISTINCT s.id,s.name,s.code
   FROM teacher_subject_assignments tsa
   JOIN subjects s ON s.id=tsa.subject_id AND s.school_id=tsa.school_id
   WHERE tsa.school_id=$1 AND tsa.academic_year_id=$2
     AND tsa.class_id=$3
   ORDER BY s.name
  `,[sid,q.academic_year_id,q.class_id])).rows;

  if(!subjectDetails.length)
   return res.status(409).json({
    error:'Assign subjects to the class first.'
   });

  const subjects=subjectDetails.map(s=>String(s.id));

  const learners=(await db.query(`
   SELECT DISTINCT l.id learner_id,l.admission_no,
     l.first_name,l.last_name
   FROM learners l
   JOIN learner_enrollments le
     ON le.learner_id=l.id AND le.school_id=l.school_id
   WHERE l.school_id=$1 AND le.academic_year_id=$2
     AND le.class_id=$3
     AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
  `,[sid,q.academic_year_id,q.class_id])).rows;

  const marks=learners.length?(await db.query(`
   SELECT m.learner_id,m.subject_id,m.assessment_id,
     m.mark,a.max_mark
   FROM marks m
   JOIN assessments a
     ON a.id=m.assessment_id AND a.school_id=m.school_id
   WHERE m.school_id=$1 AND m.academic_year_id=$2
     AND m.term_id=$3
     AND m.learner_id=ANY($4::uuid[])
     AND m.subject_id=ANY($5::uuid[])
     AND m.assessment_id=ANY($6::uuid[])
  `,[
   sid,q.academic_year_id,q.term_id,
   learners.map(l=>l.learner_id),subjects,ids
  ])).rows:[];

  const grouped=new Map();

  for(const m of marks){
   const id=String(m.learner_id);
   if(!grouped.has(id))grouped.set(id,[]);
   const max=Number(m.max_mark);
   grouped.get(id).push({
    subject_id:m.subject_id,
    assessment_id:m.assessment_id,
    percent:m.mark==null||!Number.isFinite(max)||max<=0
      ?null:Number(m.mark)/max*100
   });
  }

  const rows=calculate(
   learners.map(l=>({
    ...l,
    marks:grouped.get(String(l.learner_id))||[]
   })),
   subjects,ids,mode,cats,weights,
   Object.fromEntries(chosen.map(a=>[
    String(a.id),a.subject_id
   ]))
  );


  const gradingRows=(await db.query(`
   SELECT
     gs.id AS system_id,
     gb.label,
     gb.min_mark,
     gb.max_mark,
     ac.subject_id,
     ac.assessment_id,
     ac.class_id,
     ac.level_id
   FROM classes c
   JOIN grading_systems gs
     ON gs.school_id=c.school_id
     AND gs.is_active=true
   JOIN assessment_configurations ac
     ON ac.grading_system_id=gs.id
     AND ac.school_id=c.school_id
   JOIN grading_bands gb
     ON gb.grading_system_id=gs.id
   WHERE c.school_id=$1
     AND c.id=$2
     AND (ac.class_id=c.id OR ac.class_id IS NULL)
     AND (
       ac.level_id=c.school_level_id
       OR ac.level_id IS NULL
     )
     AND ac.section_id IS NULL
     AND ac.subject_id IS NULL
     AND ac.assessment_id IS NULL
   ORDER BY
     (ac.class_id IS NOT NULL) DESC,
     (ac.level_id IS NOT NULL) DESC,
     gs.id,
     gb.min_mark DESC
  `,[sid,q.class_id])).rows;

  const gradingSystemId=gradingRows[0]?.system_id;

  const grading=gradingRows.filter(x=>
   x.system_id===gradingSystemId
  );

  const gradeFor=value=>{
   if(value==null || !Number.isFinite(Number(value)))
    return null;

   const rounded=Math.round((Number(value)+Number.EPSILON)*10)/10;
   const band=grading.find(b=>
    rounded>=Number(b.min_mark) &&
    rounded<=Number(b.max_mark)
   );

   return band?.label||null;
  };

  for(const row of rows){
   for(const subject of row.subjects||[]){
    subject.grade=gradeFor(subject.score);
   }
   row.overall_grade=gradeFor(row.average);
  }

  const school=(await db.query(`
   SELECT s.name,si.logo_url,si.motto,
     si.watermark_enabled
   FROM schools s
   LEFT JOIN school_identity si ON si.school_id=s.id
   WHERE s.id=$1
  `,[sid])).rows[0]||{};

  res.json({
   basis,official:false,
   examination:requested||'OVERALL TERM',
   school,
   grading_configured:grading.length>0,
   subjects:subjectDetails,
   selected_assessments:chosen,
   rows,
   summary:{
    learners:rows.length,
    complete:rows.filter(r=>r.complete).length,
    incomplete:rows.filter(r=>!r.complete).length
   }
  });
 }catch(e){fail(res,e)}
});

// Create a numbered CAT for every subject assigned to the class.
// Existing CATs and marks are never modified.
router.post('/:schoolId/cats',schoolBoundary,edit,async(req,res)=>{
  let client;
  try{
    const sid=req.params.schoolId,q=req.body||{};
    if(!validContext(sid,q))
      return res.status(400).json({error:'Select school, year, term and class.'});
    if(!await scope(sid,q))
      return res.status(404).json({error:'Invalid academic context.'});

    const name=String(q.name||'').trim().toUpperCase().replace(/\s+/g,' ');
    const match=/^CAT ([1-9][0-9]?)$/.exec(name);
    if(!match)
      return res.status(400).json({error:'Use CAT 1, CAT 2, CAT 3, etc.'});

    const max=Number(q.max_mark);
    if(!Number.isFinite(max)||max<=0||max>1000)
      return res.status(400).json({error:'Maximum marks must be between 1 and 1000.'});

    client=await db.pool.connect();
    await client.query('BEGIN');

    const subjects=(await client.query(`
      SELECT DISTINCT tsa.subject_id
      FROM teacher_subject_assignments tsa
      JOIN subjects s ON s.id=tsa.subject_id
      WHERE tsa.school_id=$1
        AND tsa.academic_year_id=$2
        AND tsa.class_id=$3
        AND COALESCE(s.is_active,true)=true
      ORDER BY tsa.subject_id
    `,[sid,q.academic_year_id,q.class_id])).rows;

    if(!subjects.length){
      await client.query('ROLLBACK');
      return res.status(409).json({error:'Assign subjects to this class first.'});
    }

    // Serialize CAT creation for this class and academic period.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [[sid,q.academic_year_id,q.term_id,q.class_id,name].join(':')]
    );

    let created=0,skipped=0;
    for(const subject of subjects){
      const existing=await client.query(`
        SELECT id FROM assessments
        WHERE school_id=$1 AND academic_year_id=$2
          AND term_id=$3 AND class_id=$4 AND subject_id=$5
          AND assessment_type='CAT' AND lower(name)=lower($6)
        LIMIT 1
      `,[sid,q.academic_year_id,q.term_id,q.class_id,subject.subject_id,name]);

      if(existing.rowCount){
        skipped++;
        continue;
      }

      await client.query(`
        INSERT INTO assessments(
          school_id,academic_year_id,term_id,name,assessment_type,
          max_mark,weight,include_in_final,combine_group,
          assessment_order,status,class_id,subject_id,
          cat_enabled,final_conversion_weight
        )
        VALUES($1,$2,$3,$4,'CAT',$5,0,true,'CATS',$6,
               'OPEN',$7,$8,true,0)
      `,[sid,q.academic_year_id,q.term_id,name,max,
         10+Number(match[1]),q.class_id,subject.subject_id]);

      created++;
    }

    await client.query('COMMIT');
    invalidateReportCaches();
    invalidateReportPdfCache();
    res.status(201).json({
      name,created,skipped,subjects:subjects.length,
      message:`${name}: ${created} created, ${skipped} already existed.`
    });
  }catch(e){
    if(client)await client.query('ROLLBACK').catch(()=>{});
    console.error('Merit CAT creation failed:',e);
    fail(res,e);
  }finally{
    if(client)client.release();
  }
});

module.exports=router;
