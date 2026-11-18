'use strict';
// Opt-in read-only weighted term merit. Existing merit and reports remain unchanged.
const express=require('express');
const db=require('../db');
const {authenticate,schoolBoundary,roles}=require('../middleware/auth');
const {validateWeights}=require('../services/merit-v6-engine');
const {calculateClass}=require('../services/merit-v6-assessment-match');
const router=express.Router();
router.use(authenticate);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
router.get('/:schoolId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,{academic_year_id:y,term_id:t,class_id:c}=req.query;
  if(![sid,y,t,c].every(x=>uuid.test(String(x||''))))return res.status(400).json({error:'School, academic year, term and class are required as valid IDs.'});
  const scope=await db.query(`SELECT c.id,c.name,c.stream,c.school_level_id FROM classes c JOIN academic_years ay ON ay.school_id=c.school_id AND ay.id=$2 JOIN terms t ON t.school_id=c.school_id AND t.academic_year_id=ay.id AND t.id=$3 WHERE c.school_id=$1 AND c.id=$4`,[sid,y,t,c]);
  if(!scope.rows.length)return res.status(404).json({error:'Class, year or term not found in this school.'});
  if(req.user.role==='CLASS_TEACHER'){
   const allowed=await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers th ON th.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND th.user_id=$4 AND COALESCE(th.is_active,true)=true LIMIT 1`,[sid,c,y,req.user.user_id]);
   if(!allowed.rowCount)return res.status(403).json({error:'You can only view your assigned class.'});
  }
  const profiles=await db.query(`SELECT class_id,weights FROM merit_weight_profiles WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND (class_id IS NULL OR class_id=$4)`,[sid,y,t,c]);
  const def=profiles.rows.find(p=>p.class_id===null),override=profiles.rows.find(p=>String(p.class_id)===c);
  if(!def&&!override)return res.status(409).json({error:'Configure a school or class assessment weighting profile before generating weighted term merit.'});
  const weights=validateWeights((override||def).weights);
  const assessments=(await db.query(`SELECT id,assessment_type,class_id,subject_id,max_mark FROM assessments WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND (class_id IS NULL OR class_id=$4)`,[sid,y,t,c])).rows;
  const expected=(await db.query(`SELECT DISTINCT subject_id FROM teacher_subject_assignments WHERE school_id=$1 AND academic_year_id=$2 AND class_id=$3 AND (term_id=$4 OR term_id IS NULL)`,[sid,y,c,t])).rows.map(x=>String(x.subject_id));
  if(!expected.length)return res.status(409).json({error:'No assigned subjects found for this class/year/term. Assign subjects before generating official merit.'});
  const learners=(await db.query(`SELECT l.id learner_id,l.admission_no,l.first_name,l.last_name,$3::uuid class_id,$4::uuid school_level_id FROM learners l JOIN learner_enrollments le ON le.learner_id=l.id AND le.school_id=l.school_id AND le.academic_year_id=$2 WHERE l.school_id=$1 AND le.class_id=$3 AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')`,[sid,y,c,scope.rows[0].school_level_id])).rows;
  const marks=(await db.query(`SELECT m.learner_id,m.subject_id,m.assessment_id,m.mark,a.max_mark FROM marks m JOIN assessments a ON a.id=m.assessment_id AND a.school_id=m.school_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.learner_id=ANY($4::uuid[]) AND m.subject_id=ANY($5::uuid[])`,[sid,y,t,learners.map(l=>l.learner_id),expected])).rows;
  const byLearner=new Map();
  for(const m of marks){const id=String(m.learner_id),sub=String(m.subject_id);if(!byLearner.has(id))byLearner.set(id,new Map());const sm=byLearner.get(id);if(!sm.has(sub))sm.set(sub,[]);const max=Number(m.max_mark);sm.get(sub).push({assessment_id:m.assessment_id,percent:m.mark===null||!Number.isFinite(max)||max<=0?null:Number(m.mark)/max*100});}
  const input=learners.map(l=>({...l,subjects:expected.map(subject_id=>({subject_id,marks:byLearner.get(String(l.learner_id))?.get(subject_id)||[]}))}));
  const result=calculateClass(input,assessments,weights,expected);
  // This endpoint is class-scoped. Grade-wide ranking requires a separate multi-class calculation.
  res.json({basis:'WEIGHTED_TERM_V6',scope:'CLASS',academic_year_id:y,term_id:t,class:scope.rows[0],weights,expected_subject_ids:expected,rows:result.map(r=>({...r,overall_rank:null,overall_rank_total:null})),summary:{learners:result.length,complete:result.filter(r=>r.complete).length,incomplete:result.filter(r=>!r.complete).length}});
 }catch(e){res.status(e.status||500).json({error:e.status?e.message:'Unable to calculate weighted term merit.',detail:process.env.NODE_ENV==='production'?undefined:e.message});}
});
module.exports=router;
