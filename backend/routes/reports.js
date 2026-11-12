const express=require("express"),db=require("../db");
const {authenticate,schoolBoundary,roles}=require("../middleware/auth");
const {buildTermReport,buildYearReport,invalidateReportCaches}=require("../services/report-engine");
const {reportPdf,reportPdfs,buildReportPdfsBuffer,streamReportPdfs,invalidateReportPdfCache}=require("../services/report-pdf");
const {assertBelongs}=require("../services/tenant");
const router=express.Router();router.use(authenticate);
const classReportPdfCache=new Map();
function getClassReportPdf(key){const hit=classReportPdfCache.get(key);if(hit&&hit.expires>Date.now())return hit.value;if(hit)classReportPdfCache.delete(key);return null;}
function putClassReportPdf(key,value){classReportPdfCache.set(key,{value,expires:Date.now()+15000});if(classReportPdfCache.size>24){const oldest=[...classReportPdfCache.entries()].sort((a,b)=>a[1].expires-b[1].expires)[0];if(oldest)classReportPdfCache.delete(oldest[0]);}}
function pathwayGuidanceError(res,error){const missing=error?.code==='42P01';return res.status(missing?503:error.status||400).json({error:missing?'Pathway guidance is not installed. Apply database/035_report_pathway_guidance.sql first.':error.message});}
async function enforceClassTeacherLearner(req,learnerId,yearId){
 if(req.user.role!=='CLASS_TEACHER')return;
 const ok=(await db.query(`SELECT 1 FROM learners l JOIN class_teacher_assignments a ON a.class_id=l.class_id AND a.school_id=l.school_id JOIN teachers t ON t.id=a.teacher_id WHERE l.id=$1 AND l.school_id=$2 AND a.academic_year_id=$3 AND t.user_id=$4 AND COALESCE(t.is_active,true)=true LIMIT 1`,[learnerId,req.params.schoolId,yearId,req.user.user_id])).rows[0];
 if(!ok)throw Object.assign(new Error('You can only access report cards for learners in your assigned class.'),{status:403});
}
// Teachers may view report cards for classes they are attached to, either as
// class teacher or through a subject assignment. Learners are scoped through
// their enrolment for the selected year so past classes are handled correctly.
async function enforceReportClassAccess(req,classId,yearId){
 if(!['CLASS_TEACHER','TEACHER'].includes(req.user.role))return;
 const ok=(await db.query(`SELECT 1 FROM teachers th WHERE th.school_id=$1 AND th.user_id=$2 AND COALESCE(th.is_active,true)=true AND (EXISTS(SELECT 1 FROM class_teacher_assignments cta WHERE cta.school_id=th.school_id AND cta.teacher_id=th.id AND cta.class_id=$3 AND cta.academic_year_id=$4) OR EXISTS(SELECT 1 FROM teacher_subject_assignments tsa WHERE tsa.school_id=th.school_id AND tsa.teacher_id=th.id AND tsa.class_id=$3 AND tsa.academic_year_id=$4 AND COALESCE(tsa.is_active,true)=true)) LIMIT 1`,[req.params.schoolId,req.user.user_id,classId,yearId])).rows[0];
 if(!ok)throw Object.assign(new Error('You can only access report cards for classes you are assigned to.'),{status:403});
}
async function enforceReportLearnerAccess(req,learnerId,yearId){
 if(req.user.role==='CLASS_TEACHER')return enforceClassTeacherLearner(req,learnerId,yearId);
 if(req.user.role!=='TEACHER')return;
 const row=(await db.query(`SELECT COALESCE((SELECT le.class_id FROM learner_enrollments le WHERE le.school_id=$1 AND le.learner_id=$2 AND le.academic_year_id=$3 AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED') ORDER BY (le.status='ACTIVE') DESC,le.enrolled_at DESC LIMIT 1),l.class_id) class_id FROM learners l WHERE l.id=$2 AND l.school_id=$1`,[req.params.schoolId,learnerId,yearId])).rows[0];
 if(!row||!row.class_id)throw Object.assign(new Error('Learner is not enrolled for the selected academic year.'),{status:404});
 await enforceReportClassAccess(req,row.class_id,yearId);
}
async function assertTermInYear(sid,yearId,termId){
 const ok=(await db.query('SELECT 1 FROM terms WHERE id=$1 AND school_id=$2 AND academic_year_id=$3',[termId,sid,yearId])).rows[0];
 if(!ok)throw Object.assign(new Error('Selected term does not belong to the selected academic year.'),{status:400});
}

router.get("/:schoolId/term/:learnerId/:yearId/:termId",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceReportLearnerAccess(req,req.params.learnerId,req.params.yearId);const r=await buildTermReport(req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId);if(!r)return res.status(404).json({error:"Report not found"});res.json(r); }catch(e){console.error('[ZELIMU CBC term report]',e);res.status(e.status||500).json({error:e.message||'Report generation failed'});}});
router.get("/:schoolId/term/:learnerId/:yearId/:termId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceReportLearnerAccess(req,req.params.learnerId,req.params.yearId);const r=await buildTermReport(req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId);if(!r)return res.status(404).json({error:"Report not found"});await reportPdf(r,res); }catch(e){console.error('[ZELIMU CBC term report PDF]',e);if(!res.headersSent)res.status(e.status||500).json({error:e.message||'PDF generation failed'});}});
router.get("/:schoolId/year/:learnerId/:yearId",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceReportLearnerAccess(req,req.params.learnerId,req.params.yearId);const r=await buildYearReport(req.params.schoolId,req.params.learnerId,req.params.yearId);if(!r)return res.status(404).json({error:"Annual report not found"});res.json(r); }catch(e){console.error('[ZELIMU CBC annual report]',e);res.status(e.status||500).json({error:e.message||'Annual report generation failed'});}});
router.get("/:schoolId/year/:learnerId/:yearId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceReportLearnerAccess(req,req.params.learnerId,req.params.yearId);const r=await buildYearReport(req.params.schoolId,req.params.learnerId,req.params.yearId);if(!r)return res.status(404).json({error:"Annual report not found"});await reportPdf(r,res); }catch(e){console.error('[ZELIMU CBC annual report PDF]',e);if(!res.headersSent)res.status(e.status||500).json({error:e.message||'PDF generation failed'});}});
router.get("/:schoolId/class/:classId/:yearId/:termId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","CLASS_TEACHER","SENIOR_TEACHER","TEACHER"),async(req,res)=>{try{
 const cls=(await db.query('SELECT c.id,c.name,c.stream,s.name school_name,si.motto,si.primary_color,si.secondary_color FROM classes c JOIN schools s ON s.id=c.school_id LEFT JOIN school_identity si ON si.school_id=c.school_id WHERE c.id=$1 AND c.school_id=$2',[req.params.classId,req.params.schoolId])).rows[0];
 if(!cls)return res.status(404).json({error:'Class not found'});
 await enforceReportClassAccess(req,req.params.classId,req.params.yearId,req.params.termId);
 const learners=(await db.query(`SELECT DISTINCT l.id,l.first_name,l.middle_name,l.last_name FROM learners l WHERE l.school_id=$1 AND (l.class_id=$2 OR EXISTS (SELECT 1 FROM learner_enrollments le WHERE le.learner_id=l.id AND le.school_id=$1 AND le.academic_year_id=$3 AND le.class_id=$2 AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')) OR (EXISTS (SELECT 1 FROM marks mx WHERE mx.school_id=l.school_id AND mx.learner_id=l.id AND mx.academic_year_id=$3 AND mx.term_id=$4 AND mx.class_id=$2) AND NOT EXISTS (SELECT 1 FROM learner_enrollments lex WHERE lex.learner_id=l.id AND lex.school_id=$1 AND lex.academic_year_id=$3))) ORDER BY l.last_name NULLS LAST,l.first_name NULLS LAST,l.middle_name NULLS LAST,l.id`,[req.params.schoolId,req.params.classId,req.params.yearId,req.params.termId])).rows;
 if(!learners.length)return res.status(404).json({error:'No learners are enrolled in this class for the selected academic year and term.'});
 // Stream the PDF while reports are being built. The old route waited for the entire
 // class to finish building and only then sent the first byte, which made hosted
 // requests hit a 503/timeout for larger classes. The generator keeps the existing
 // report engine and ordering, but sends each completed learner page immediately.
 let produced=0,skipped=0;
 const factory=async function*(){
    const poolMax=Number(db.pool?.options?.max)||10;
    const limit=Math.max(1,Math.min(8,poolMax-2,learners.length));
   for(let i=0;i<learners.length;i+=limit){
     const batch=learners.slice(i,i+limit);
     const built=await Promise.all(batch.map(async l=>{
       try{return {learner:l,report:await buildTermReport(req.params.schoolId,l.id,req.params.yearId,req.params.termId)};}
       catch(e){return {learner:l,error:e};}
     }));
     for(const item of built){
       if(item.report){produced++;yield item.report;}
       else {
         skipped++;
         yield {report_kind:'TERM',school_name:cls.school_name||'SCHOOL',motto:cls.motto||'',primary_color:cls.primary_color||'#12355B',secondary_color:cls.secondary_color||'#B8860B',learner_name:[item.learner?.first_name,item.learner?.middle_name,item.learner?.last_name].filter(Boolean).join(' '),class_name:cls.name||'',stream:cls.stream||'',subjects:[],exam_columns:[],grading_bands:[]};
       }
     }
   }
 };

 res.setHeader('X-Pro-Mark-Report-Count',String(learners.length));
 res.setHeader('X-Pro-Mark-Skipped-Count','0');
 await streamReportPdfs(factory,res,{expectedCount:learners.length,download:String(req.query.download||'')==='1'});
 }catch(e){console.error('[ZELIMU CBC class report PDF]',e);if(!res.headersSent)res.status(e.status||500).json({error:e.message||'Class report PDF generation failed'});}});
router.get('/:schoolId/class/:classId/:yearId/:termId/learners',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','CLASS_TEACHER','SENIOR_TEACHER','TEACHER'),async(req,res)=>{try{await enforceReportClassAccess(req,req.params.classId,req.params.yearId,req.params.termId);const q=await db.query(`SELECT l.id,l.admission_no,l.assessment_no,l.first_name,l.middle_name,l.last_name FROM learners l JOIN learner_enrollments le ON le.learner_id=l.id AND le.school_id=l.school_id WHERE l.school_id=$1 AND le.academic_year_id=$2 AND le.class_id=$3 AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED') ORDER BY l.last_name NULLS LAST,l.first_name NULLS LAST,l.middle_name NULLS LAST,l.id`,[req.params.schoolId,req.params.yearId,req.params.classId]);res.json(q.rows);}catch(e){res.status(e.status||400).json({error:e.message})}});
router.get("/:schoolId/comments/:learnerId/:yearId/:termId",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceReportLearnerAccess(req,req.params.learnerId,req.params.yearId);const q=await db.query(`SELECT * FROM report_comments WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4 ORDER BY comment_type`,[req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId]);res.json(q.rows);}catch(e){res.status(e.status||400).json({error:e.message})}});
router.post("/:schoolId/comments",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","CLASS_TEACHER","SENIOR_TEACHER","TEACHER"),async(req,res)=>{const b=req.body||{};try{if(!b.learner_id||!b.academic_year_id||!b.term_id||!b.comment_type)return res.status(400).json({error:"Learner, year, term and comment type are required"});
if(typeof b.comment_type!=='string'||!b.comment_type.trim()||b.comment_type.trim().length>80)
  return res.status(400).json({error:"Invalid report comment type."});
if(b.comment_text!=null&&typeof b.comment_text!=='string')
  return res.status(400).json({error:"Report comment must be text."});
if((b.comment_text||'').trim().length>2000)
  return res.status(400).json({error:"Report comment exceeds 2000 characters."});
b.comment_type=b.comment_type.trim();
b.comment_text=(b.comment_text||'').trim();
await enforceReportLearnerAccess(req,b.learner_id,b.academic_year_id);
await assertBelongs('learners',b.learner_id,req.params.schoolId);await assertBelongs('academic_years',b.academic_year_id,req.params.schoolId);await assertBelongs('terms',b.term_id,req.params.schoolId);
await assertTermInYear(req.params.schoolId,b.academic_year_id,b.term_id);const q=await db.query(`INSERT INTO report_comments(school_id,learner_id,academic_year_id,term_id,comment_type,comment_text,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(learner_id,academic_year_id,term_id,comment_type) DO UPDATE SET comment_text=EXCLUDED.comment_text,created_by=EXCLUDED.created_by,updated_at=now() RETURNING *`,[req.params.schoolId,b.learner_id,b.academic_year_id,b.term_id,b.comment_type,b.comment_text||"",req.user.user_id]);invalidateReportCaches();invalidateReportPdfCache();res.json(q.rows[0]);}catch(e){res.status(e.status||400).json({error:e.message});}});
router.get('/:schoolId/pathway-guidance/:learnerId/:yearId/:termId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{try{
 await enforceReportLearnerAccess(req,req.params.learnerId,req.params.yearId);
 const q=await db.query(`SELECT selected_pathway,track_specialisation,pathway_evidence,strengths,competency_development,development_area,career_exploration,teacher_guidance
  FROM report_pathway_guidance WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4`,[req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId]);
 res.json(q.rows[0]||{});
}catch(e){pathwayGuidanceError(res,e);}});
router.put('/:schoolId/pathway-guidance',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER'),async(req,res)=>{try{
 const b=req.body||{};
 if(!b.learner_id||!b.academic_year_id||!b.term_id)return res.status(400).json({error:'Learner, academic year and term are required'});
 await enforceClassTeacherLearner(req,b.learner_id,b.academic_year_id);
 await assertBelongs('learners',b.learner_id,req.params.schoolId);await assertBelongs('academic_years',b.academic_year_id,req.params.schoolId);await assertBelongs('terms',b.term_id,req.params.schoolId);
 const termContext=(await db.query('SELECT 1 FROM terms WHERE id=$1 AND school_id=$2 AND academic_year_id=$3',[b.term_id,req.params.schoolId,b.academic_year_id])).rows[0];
 if(!termContext)return res.status(400).json({error:'Selected term does not belong to the selected academic year.'});
 const textFields=['selected_pathway','track_specialisation','strengths','competency_development','development_area','career_exploration','teacher_guidance'];
 const values={};
 for(const field of textFields){
   const value=b[field]==null?'':b[field];
   if(typeof value!=='string'||value.trim().length>1000)return res.status(400).json({error:`Invalid ${field.replace(/_/g,' ')} value`});
   values[field]=value.trim()||null;
 }
 const evidence=b.pathway_evidence==null?{}:b.pathway_evidence;
 if(typeof evidence!=='object'||Array.isArray(evidence)||Object.keys(evidence).length>12)return res.status(400).json({error:'Pathway evidence must be an object with no more than 12 pathway entries'});
 for(const [key,item] of Object.entries(evidence)){
   if(!/^[A-Z0-9_-]{1,60}$/i.test(key)||!item||typeof item!=='object'||Array.isArray(item))return res.status(400).json({error:'Invalid pathway evidence entry'});
   for(const field of ['strength','evidence','teacher_guidance'])if(item[field]!=null&&(typeof item[field]!=='string'||item[field].trim().length>500))return res.status(400).json({error:`Invalid ${field} in pathway evidence`});
 }
 const q=await db.query(`INSERT INTO report_pathway_guidance(school_id,learner_id,academic_year_id,term_id,selected_pathway,track_specialisation,pathway_evidence,strengths,competency_development,development_area,career_exploration,teacher_guidance,updated_by)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
  ON CONFLICT(school_id,learner_id,academic_year_id,term_id) DO UPDATE SET selected_pathway=EXCLUDED.selected_pathway,track_specialisation=EXCLUDED.track_specialisation,pathway_evidence=EXCLUDED.pathway_evidence,strengths=EXCLUDED.strengths,competency_development=EXCLUDED.competency_development,development_area=EXCLUDED.development_area,career_exploration=EXCLUDED.career_exploration,teacher_guidance=EXCLUDED.teacher_guidance,updated_by=EXCLUDED.updated_by,updated_at=now()
  RETURNING selected_pathway,track_specialisation,pathway_evidence,strengths,competency_development,development_area,career_exploration,teacher_guidance`,[req.params.schoolId,b.learner_id,b.academic_year_id,b.term_id,values.selected_pathway,values.track_specialisation,JSON.stringify(evidence),values.strengths,values.competency_development,values.development_area,values.career_exploration,values.teacher_guidance,req.user.user_id]);
 invalidateReportCaches();invalidateReportPdfCache();
 res.json(q.rows[0]);
}catch(e){pathwayGuidanceError(res,e);}});
router.get('/:schoolId/designation/:learnerId/:yearId/:termId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','CLASS_TEACHER','SENIOR_TEACHER','TEACHER'),async(req,res)=>{try{
 await enforceReportLearnerAccess(req,req.params.learnerId,req.params.yearId);
 const q=await db.query(`SELECT designation,decision,attendance_days,school_open_days,conduct,effort,next_term_target,intervention_plan,teacher_comment,headteacher_comment
  FROM report_card_designations WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4`,[req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId]);
 res.json(q.rows[0]||{});
}catch(e){res.status(e.status||400).json({error:e.message})}});
router.put('/:schoolId/designation',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{try{
 const b=req.body||{};
 if(!b.learner_id||!b.academic_year_id||!b.term_id)return res.status(400).json({error:'Learner, academic year and term are required'});
 await enforceClassTeacherLearner(req,b.learner_id,b.academic_year_id);
 await assertBelongs('learners',b.learner_id,req.params.schoolId);await assertBelongs('academic_years',b.academic_year_id,req.params.schoolId);await assertBelongs('terms',b.term_id,req.params.schoolId);
 await assertTermInYear(req.params.schoolId,b.academic_year_id,b.term_id);
 const allowedDesignation=['AUTO','DISTINCTION','MERIT','CREDIT','PASS','DEVELOPING','AT_RISK','INCOMPLETE'];
 const allowedDecision=['AUTO','PROMOTED','PROCEED','REPEAT','REVIEW','GRADUATED'];
 if(!allowedDesignation.includes(String(b.designation||'AUTO').toUpperCase()))return res.status(400).json({error:'Invalid designation'});
 if(!allowedDecision.includes(String(b.decision||'AUTO').toUpperCase()))return res.status(400).json({error:'Invalid progression decision'});
 const wholeNumber=(value,label,max)=>{if(value===''||value==null)return null;const n=Number(value);if(!Number.isInteger(n)||n<0||n>max)throw Object.assign(new Error(`${label} must be a whole number between 0 and ${max}.`),{status:400});return n;};
 const shortText=(value,label,max=200)=>{if(value==null)return null;if(typeof value!=='string')throw Object.assign(new Error(`${label} must be text.`),{status:400});const text=value.trim();if(text.length>max)throw Object.assign(new Error(`${label} exceeds ${max} characters.`),{status:400});return text||null;};
 const attendanceDays=wholeNumber(b.attendance_days,'Attendance days',366);
 const schoolOpenDays=wholeNumber(b.school_open_days,'School open days',366);
 if(attendanceDays!==null&&schoolOpenDays!==null&&attendanceDays>schoolOpenDays)return res.status(400).json({error:'Attendance days cannot exceed school open days.'});
 const nextTermTarget=wholeNumber(b.next_term_target,'Next term target',100);
 const conduct=shortText(b.conduct,'Conduct');
 const effort=shortText(b.effort,'Effort');
 const interventionPlan=shortText(b.intervention_plan,'Intervention plan',2000);
 const teacherComment=shortText(b.teacher_comment,'Teacher comment',2000);
 const headteacherComment=shortText(b.headteacher_comment,'Head teacher comment',2000);
 const q=await db.query(`INSERT INTO report_card_designations(school_id,learner_id,academic_year_id,term_id,designation,decision,attendance_days,school_open_days,conduct,effort,next_term_target,intervention_plan,teacher_comment,headteacher_comment,updated_by)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
 ON CONFLICT(learner_id,academic_year_id,term_id) DO UPDATE SET designation=EXCLUDED.designation,decision=EXCLUDED.decision,attendance_days=EXCLUDED.attendance_days,school_open_days=EXCLUDED.school_open_days,conduct=EXCLUDED.conduct,effort=EXCLUDED.effort,next_term_target=EXCLUDED.next_term_target,intervention_plan=EXCLUDED.intervention_plan,teacher_comment=EXCLUDED.teacher_comment,headteacher_comment=EXCLUDED.headteacher_comment,updated_by=EXCLUDED.updated_by,updated_at=now()
 RETURNING *`,[req.params.schoolId,b.learner_id,b.academic_year_id,b.term_id,String(b.designation||'AUTO').toUpperCase(),String(b.decision||'AUTO').toUpperCase(),attendanceDays,schoolOpenDays,conduct,effort,nextTermTarget,interventionPlan,teacherComment,headteacherComment,req.user.user_id]);
 invalidateReportCaches();
 invalidateReportPdfCache();
 res.json(q.rows[0]);
}catch(e){res.status(e.status||400).json({error:e.message})}});
module.exports=router;
