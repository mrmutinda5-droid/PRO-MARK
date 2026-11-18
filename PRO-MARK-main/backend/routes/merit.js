const express=require('express'),db=require('../db'),PDFDocument=require('pdfkit');
const {authenticate,schoolBoundary,roles}=require('../middleware/auth');
const {assertBelongs}=require('../services/tenant');
const {source:assetSource}=require('../services/assets');
const router=express.Router();router.use(authenticate);

// Short-lived cache for expensive Merit calculations.
// Keyed by school/year/term/class/assessment so schools never share results.
const meritCache=new Map();
const MERIT_CACHE_TTL_MS=30000;

function meritCacheKey(sid,yearId,termId,classId,assessmentId){
 return [sid,yearId,termId,classId||'',assessmentId||''].join('|');
}

function getMeritCache(key){
 const hit=meritCache.get(key);
 if(!hit)return null;
 if(Date.now()-hit.createdAt>MERIT_CACHE_TTL_MS){
   meritCache.delete(key);
   return null;
 }
 return hit.value;
}

function setMeritCache(key,value){
 meritCache.set(key,{createdAt:Date.now(),value});
 return value;
}

function clearMeritCache(){
 meritCache.clear();
}
// Merit lists expose whole-class results, so classroom staff must be linked to
// the selected class: class teachers through their class assignment, subject
// teachers through an active subject assignment for that class and year.
async function enforceMeritClassAccess(req,sid,classId,yearId){
 if(!['CLASS_TEACHER','TEACHER'].includes(req.user.role))return;
 if(!classId)throw Object.assign(new Error('Select your assigned class.'),{status:400});
 const classTeacher=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers th ON th.id=a.teacher_id AND th.school_id=a.school_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND th.user_id=$4 AND COALESCE(th.is_active,true)=true LIMIT 1`,[sid,classId,yearId,req.user.user_id])).rows[0];
 if(classTeacher)return;
 const subjectTeacher=(await db.query(`SELECT 1 FROM teacher_subject_assignments tsa JOIN teachers th ON th.id=tsa.teacher_id AND th.school_id=tsa.school_id WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3 AND th.user_id=$4 AND COALESCE(tsa.is_active,true)=true AND COALESCE(th.is_active,true)=true LIMIT 1`,[sid,classId,yearId,req.user.user_id])).rows[0];
 if(!subjectTeacher)throw Object.assign(new Error('You can only view merit for a class you are assigned to.'),{status:403});
}
function drawTextWatermark(doc,name,motto,cx,cy,width,opacity=.035){const title=String(name||'').trim();if(!title)return false;try{doc.save().opacity(opacity).fillColor('#334155').font('Helvetica-Bold').fontSize(34).text(title,cx-width/2,cy-20,{width,align:'center',lineBreak:false,ellipsis:true});if(motto)doc.font('Helvetica').fontSize(13).text(String(motto),cx-width/2,cy+22,{width,align:'center',lineBreak:false,ellipsis:true});doc.restore();return true;}catch{try{doc.restore();}catch{}return false;}}
function fmt(v){const n=Number(v);return Number.isFinite(n)?(Math.abs(n-Math.round(n))<0.00001?String(Math.round(n)):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')):'—';}
function calc(values){const usable=values.filter(x=>Number.isFinite(x.percent));return usable.length?usable.reduce((s,x)=>s+x.percent,0)/usable.length:null;}
async function compute(sid,yearId,termId,classId=null,assessmentId=null){
 const cacheKey=meritCacheKey(sid,yearId,termId,classId,assessmentId);
 const cached=getMeritCache(cacheKey);
 if(cached)return cached;

 await assertBelongs('academic_years',yearId,sid);await assertBelongs('terms',termId,sid);
 const termInfo=(await db.query(`SELECT term_no FROM terms WHERE id=$1 AND school_id=$2 AND academic_year_id=$3`,[termId,sid,yearId])).rows[0];
 if(!termInfo)throw Object.assign(new Error('Term not found for the selected academic year'),{status:404});
 const classMeta=classId?(await db.query(`SELECT id,name,stream,school_level_id FROM classes WHERE id=$1 AND school_id=$2`,[classId,sid])).rows[0]:null;
 if(classId&&!classMeta)throw Object.assign(new Error('Selected class was not found.'),{status:404});
 const meritLevelId=classMeta?.school_level_id||null;
 let assessmentType=null;
 if(assessmentId){
   const selected=(await db.query(`SELECT assessment_type FROM assessments WHERE id=$1 AND school_id=$2 AND academic_year_id=$3 AND term_id=$4`,[assessmentId,sid,yearId,termId])).rows[0];
   if(!selected)throw Object.assign(new Error('Selected assessment was not found for this school, year and term.'),{status:404});
   assessmentType=String(selected.assessment_type||'').toUpperCase()||null;
 }
 const marks=(await db.query(`SELECT m.learner_id,l.admission_no,l.assessment_no,l.first_name,l.last_name,
           COALESCE(m.class_id,le.class_id,l.class_id) merit_class_id,
           mc.name merit_class_name,mc.stream merit_class_stream,mc.school_level_id merit_school_level_id,
           m.subject_id,s.code subject_code,s.name subject_name,m.assessment_id,m.mark,a.id assessment_id,a.name assessment_name,a.assessment_order,a.max_mark,a.weight,a.assessment_type,
           COALESCE((SELECT ac.include_in_merit FROM assessment_configurations ac WHERE ac.school_id=m.school_id AND ac.assessment_id=m.assessment_id AND (ac.subject_id=m.subject_id OR ac.subject_id IS NULL) ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_merit,
           (SELECT ac.grading_system_id FROM assessment_configurations ac WHERE ac.school_id=m.school_id AND (ac.assessment_id=m.assessment_id OR ac.assessment_id IS NULL) AND (ac.subject_id=m.subject_id OR ac.subject_id IS NULL) AND (ac.class_id=m.class_id OR ac.class_id IS NULL) ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.assessment_id IS NOT NULL) DESC,(ac.class_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1) grading_system_id FROM marks m JOIN learners l ON l.id=m.learner_id JOIN subjects s ON s.id=m.subject_id JOIN assessments a ON a.id=m.assessment_id
LEFT JOIN learner_enrollments le ON le.school_id=m.school_id AND le.learner_id=m.learner_id AND le.academic_year_id=m.academic_year_id
LEFT JOIN classes mc ON mc.id=COALESCE(m.class_id,le.class_id,l.class_id) AND mc.school_id=m.school_id
WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
  AND ($4::uuid IS NULL OR COALESCE(le.class_id,l.class_id)= $4 OR m.class_id=$4 OR ($6::uuid IS NOT NULL AND mc.school_level_id=$6))
  AND (COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED') OR m.class_id=$4 OR l.is_active=true)
 AND (($7::uuid IS NOT NULL AND a.id=$7) OR ($7::uuid IS NULL AND a.include_in_final=true AND a.assessment_type IN ('OPENER','MID_TERM','END_TERM')))
 ORDER BY l.last_name,l.first_name,s.name,a.assessment_order`,[sid,yearId,termId,classId,assessmentType,meritLevelId,assessmentId])).rows;
 const byLearner=new Map();const seenAssessments=new Set();for(const r of marks){const at=String(r.assessment_type||'').toUpperCase();const aid=String(r.assessment_id||'');const keySeen=`${r.learner_id}|${r.subject_id}|${aid}`;if((!assessmentId&&!['OPENER','MID_TERM','END_TERM'].includes(at))||!aid||seenAssessments.has(keySeen)||r.include_in_merit===false||r.mark===null)continue;seenAssessments.add(keySeen);const key=r.learner_id;if(!byLearner.has(key))byLearner.set(key,{learner_id:key,admission_no:r.admission_no,assessment_no:r.assessment_no,first_name:r.first_name,last_name:r.last_name,class_id:r.merit_class_id,class_name:r.merit_class_name,class_stream:r.merit_class_stream,school_level_id:r.merit_school_level_id,subjects:new Map()});const L=byLearner.get(key);if(!L.subjects.has(r.subject_id))L.subjects.set(r.subject_id,{subject_id:r.subject_id,subject_code:r.subject_code,subject_name:r.subject_name,items:[]});L.subjects.get(r.subject_id).items.push({percent:Number(r.mark)/Number(r.max_mark||100)*100,display_percent:Math.round(Number(r.mark)/Number(r.max_mark||100)*100),weight:Number(r.weight||0),grading_system_id:r.grading_system_id,assessment_id:r.assessment_id,assessment_name:r.assessment_name,assessment_type:at,assessment_order:r.assessment_order});}
 const gradingRows=(await db.query(`SELECT gs.id system_id,gs.name system_name,gs.code system_code,gb.label,gb.min_mark,gb.max_mark,gb.points FROM grading_systems gs JOIN grading_bands gb ON gb.grading_system_id=gs.id WHERE gs.school_id=$1`,[sid])).rows;
 const gradeFor=(value,systemId)=>{
   if(value===null)return null;
   const raw=Number(value);
   if(!Number.isFinite(raw))return null;
   // Merit grades follow the displayed whole-number average. This makes the
   // boundary explicit: 59.5 -> 60 (ME when 60 is the ME floor), while 59.4
   // -> 59 (AE). The underlying average remains unchanged for display/ranking.
   const n=Math.round(raw + Number.EPSILON);
   const bands=gradingRows.filter(x=>systemId?x.system_id===systemId:false);
   return bands.find(x=>n>=Number(x.min_mark)&&n<=Number(x.max_mark))||null;
 };
 const overallSystemId=classId?(await db.query(`SELECT ac.grading_system_id FROM assessment_configurations ac JOIN classes c ON c.id=$2 AND c.school_id=$1 WHERE ac.school_id=$1 AND ac.section_id IS NULL AND ac.subject_id IS NULL AND ac.assessment_id IS NULL AND (ac.class_id=$2 OR (ac.class_id IS NULL AND ac.level_id=c.school_level_id)) ORDER BY (ac.class_id IS NOT NULL) DESC,ac.created_at DESC LIMIT 1`,[sid,classId])).rows[0]?.grading_system_id:null;
 const allRows=[...byLearner.values()].map(L=>{const subjects=[...L.subjects.values()].map(s=>{const average=calc(s.items);const systemId=s.items.find(i=>i.grading_system_id)?.grading_system_id||null;const g=gradeFor(average,systemId);const assessments_used=[...new Map(s.items.map(i=>[String(i.assessment_id),{id:i.assessment_id,name:i.assessment_name,type:i.assessment_type,order:i.assessment_order||0}])).values()].sort((a,b)=>Number(a.order)-Number(b.order));return {...s,average,display_average:average===null?null:Math.round(average),grade:g?.label||'',points:g?.points??'',grading_system_id:systemId,assessments_used};}).filter(s=>s.average!==null).sort((a,b)=>b.average-a.average||a.subject_name.localeCompare(b.subject_name));const total=subjects.reduce((s,x)=>s+Number(x.average||0),0);const average=subjects.length?total/subjects.length:null;const overallGrade=gradeFor(average,overallSystemId||subjects.find(s=>s.grading_system_id)?.grading_system_id||null);const assessments_used=[...new Map(subjects.flatMap(s=>s.assessments_used||[]).map(a=>[String(a.id),a])).values()].sort((a,b)=>Number(a.order)-Number(b.order));return {...L,subjects,average_mark:average,total_mark:total,overall_grade:overallGrade?.label||'',overall_points:overallGrade?.points??'',assessments_used};}).filter(x=>x.subjects.length).sort((a,b)=>b.average_mark-a.average_mark||b.total_mark-a.total_mark||a.last_name.localeCompare(b.last_name));
 const rows=classId
   ? allRows.filter(x=>String(x.class_id)===String(classId))
   : allRows;

// Full-precision subject average determines ranking (not total marks).
// Competition ranking: 1, 2, 2, 4.
if(rows.length){
  const competitionRanks=(items)=>{
    const sorted=[...items].sort((a,b)=>{
      const aa=Number(a.average_mark??-Infinity);
      const bb=Number(b.average_mark??-Infinity);
      if(bb!==aa)return bb-aa;
      return String(a.learner_id).localeCompare(String(b.learner_id));
    });

    const ranks=new Map();
    let previousTotal=null;
    let previousRank=0;

    sorted.forEach((x,index)=>{
      const total=Number(x.average_mark);

      if(previousTotal===null || Math.abs(total-previousTotal)>0.000001){
        previousRank=index+1;
        previousTotal=total;
      }

      ranks.set(String(x.learner_id),previousRank);
    });

    return {sorted,ranks};
  };

  const classRanking=competitionRanks(rows);

  // Overall position covers all streams belonging to the same grade/level.
  const overallPool=classId && meritLevelId
    ? allRows.filter(x=>String(x.school_level_id)===String(meritLevelId))
    : rows;

  const overallRanking=competitionRanks(overallPool);

  rows.forEach(x=>{
    x.class_rank=classRanking.ranks.get(String(x.learner_id))??null;
    x.class_rank_total=classRanking.sorted.length;

    x.overall_rank=overallRanking.ranks.get(String(x.learner_id))??null;
    x.overall_rank_total=overallRanking.sorted.length;

    // Compatibility with existing frontend code.
    x.stream_rank=x.class_rank;
    x.stream_rank_total=x.class_rank_total;
  });
}

// FIX: an empty merit list used to give no clue why — the admin only saw "no
 // learners". Diagnose the specific reason (wrong class on the mark records,
 // wrong term/assessment-type, or excluded by assessment configuration) instead
 // of guessing, so it's fixable without database access.
 let diagnostics=null;
 if(!rows.length && classId){
   const selectedMarks=classId?marks.filter(r=>String(r.merit_class_id)===String(classId)):marks;
   const rawCount=selectedMarks.length;
   if(rawCount===0){
     // FIX: check for inactive learners FIRST and against the EXACT selected
     // year/term/class — this is the scenario that was actually happening here.
     // The earlier version of this diagnostic only checked whether marks existed
     // under a DIFFERENT year/term, which could wrongly tell the admin to pick a
     // different term even when the term they picked was already correct and the
     // real cause was inactive learners (Results & Saved Marks has no is_active
     // filter at all, so it shows these learners fine, while merit requires it).
     const inactiveLearners=(await db.query(`SELECT l.id,l.first_name,l.last_name,count(*)::int n FROM marks m JOIN learners l ON l.id=m.learner_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.class_id=$4 AND l.is_active=false GROUP BY l.id,l.first_name,l.last_name`,[sid,yearId,termId,classId])).rows;
     if(inactiveLearners.length){
       diagnostics=`Marks DO exist for this exact class/year/term, but every learner who has them is marked inactive (is_active=false) in the database: ${inactiveLearners.map(x=>`${[x.first_name,x.last_name].filter(Boolean).join(' ')} (${x.n} mark(s))`).join(', ')}. Merit and report cards both require is_active=true, but the Class List and "Results & Saved Marks" screens do not check it, which is why they show these learners fine while merit shows nothing. There is currently no in-app control to reactivate a learner — this needs a direct database fix (UPDATE learners SET is_active=true WHERE id IN (...)) unless these learners are genuinely meant to be inactive.`;
     } else {
     const anyMarksThisClass=(await db.query(`SELECT DISTINCT ay.id year_id,ay.year_label,t.id term_id,t.name term_name,t.term_no FROM marks m JOIN academic_years ay ON ay.id=m.academic_year_id JOIN terms t ON t.id=m.term_id WHERE m.school_id=$1 AND m.class_id=$2 ORDER BY ay.year_label,t.term_no LIMIT 20`,[sid,classId])).rows;
     const learnerClassMismatch=(await db.query(`SELECT count(*)::int n FROM marks m JOIN learners l ON l.id=m.learner_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND l.class_id=$4 AND m.class_id<>$4`,[sid,yearId,termId,classId])).rows[0].n;
     if(learnerClassMismatch>0){
       diagnostics=`${learnerClassMismatch} mark record(s) belong to learners currently in this class, but the marks themselves were saved under a DIFFERENT class_id (likely entered while the learner, or the mark-entry class dropdown, pointed at a different/duplicate class record). Merit matches marks by the class recorded on the mark itself, not the learner's current class, so these are invisible here.`;
     } else if(anyMarksThisClass.length){
       // Check specifically for a DUPLICATE year/term: same label the admin picked,
       // but a different underlying id — this is invisible in any dropdown (both
       // options read identically) and is a common cause of "this used to work".
       const selected=(await db.query(`SELECT ay.year_label,t.name term_name,t.term_no FROM academic_years ay,terms t WHERE ay.id=$1 AND ay.school_id=$2 AND t.id=$3 AND t.school_id=$2`,[yearId,sid,termId])).rows[0];
       const labelMatch=selected&&anyMarksThisClass.find(x=>x.year_label===selected.year_label && (x.term_name||`Term ${x.term_no}`)===(selected.term_name||`Term ${selected.term_no}`));
       if(labelMatch){
         diagnostics=`This looks like a DUPLICATE academic year or term record. You selected "${selected.year_label} ${selected.term_name||`Term ${selected.term_no}`}" and the marks are recorded under a year/term that displays with the exact same name — but they are different underlying records (different ids), so this is not a simple dropdown mistake. This usually happens when "Create Year" or "Create Term" was run twice for the same period. Go to Academic Management, check whether "${selected.year_label}" appears more than once in the list, and if so pick the OTHER one with the same name on this Merit screen, or merge/delete the duplicate.`;
       } else {
         diagnostics=`Marks exist for this class, but not for the academic year/term you have selected. This class has marks recorded for: ${anyMarksThisClass.map(x=>`${x.year_label} ${x.term_name||`Term ${x.term_no}`}`).join(', ')}. Pick one of those in the Academic year / Term dropdowns above and generate again.`;
       }
     } else {
       diagnostics='No marks at all are recorded against this class_id for any year or term. Marks may have been entered under a different (possibly duplicate) class record — check Marks Management for this class to confirm.';
     }
     }
   } else {
     // Re-check against the exact conditions the aggregation loop above applies,
     // so this diagnosis can never disagree with what actually happened.
     const seen=new Set();let excludedByDuplicate=0,excludedByConfig=0,excludedByNullMark=0;
     for(const r of marks){
       const at=String(r.assessment_type||'').toUpperCase();
       const dupKey=`${r.learner_id}|${r.subject_id}|${at}`;
       if(r.mark===null){excludedByNullMark++;continue;}
       if(r.include_in_merit===false){excludedByConfig++;continue;}
       if(seen.has(dupKey)){excludedByDuplicate++;continue;}
       seen.add(dupKey);
     }
     const parts=[];
     if(excludedByNullMark)parts.push(`${excludedByNullMark} mark(s) have no numeric value recorded`);
     if(excludedByConfig)parts.push(`${excludedByConfig} mark(s) are explicitly excluded from merit by assessment configuration`);
     if(excludedByDuplicate)parts.push(`${excludedByDuplicate} mark(s) are duplicate entries for the same learner/subject/assessment type (only the first is kept)`);
     diagnostics=parts.length?`${rawCount} matching mark row(s) were found for this class/year/term, but all were excluded: ${parts.join('; ')}.`:`${rawCount} matching mark row(s) were found but none produced a usable subject average — check for missing or zero max_mark values on the assessments used.`;
   }
 }
 if(diagnostics){
   const result={rows,subject_rankings:[],diagnostics};
   return setMeritCache(cacheKey,result);
 }
 const subjectMap=new Map();for(const r of rows)for(const s of r.subjects){if(!subjectMap.has(s.subject_id))subjectMap.set(s.subject_id,{subject_id:s.subject_id,subject_code:s.subject_code,subject_name:s.subject_name,values:[]});subjectMap.get(s.subject_id).values.push(s.average);}
 const teacherRows=classId?(await db.query(`SELECT DISTINCT ON (tsa.subject_id) tsa.subject_id,th.id teacher_id,th.first_name,th.last_name,th.staff_no FROM teacher_subject_assignments tsa JOIN teachers th ON th.id=tsa.teacher_id AND COALESCE(th.is_active,true)=true WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3 AND COALESCE(tsa.is_active,true)=true AND NOT (upper(trim(coalesce(th.first_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.last_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.staff_no,''))) IN ('TEACHER','ADMIN','MR.TEACHER','MR. TEACHER')) ORDER BY tsa.subject_id,CASE WHEN tsa.term_id=$4 THEN 0 WHEN tsa.term_id IS NULL THEN 1 ELSE 2 END,tsa.created_at DESC,tsa.id DESC`,[sid,classId,yearId,termId])).rows:[];
 const teacherBySubject=new Map(teacherRows.map(x=>[x.subject_id, x]));
 const isPlaceholderTeacher=x=>{const f=String(x?.first_name||'').trim().toUpperCase(),l=String(x?.last_name||'').trim().toUpperCase(),s=String(x?.staff_no||'').trim().toUpperCase();return !f&&!l || f==='TEACHER'||l==='TEACHER'||f==='ADMIN'||l==='ADMIN'||s==='TEACHER'||s==='ADMIN';};
 const teacherLabel=x=>{if(!x||isPlaceholderTeacher(x))return 'Not assigned';const full=[x.first_name,x.last_name].filter(Boolean).join(' ').trim();return full||'Not assigned';};
 const subject_rankings=[...subjectMap.values()].map(s=>{const average=s.values.reduce((a,b)=>a+b,0)/s.values.length;const g=gradeFor(average,overallSystemId||null);return {...s,average,learner_count:s.values.length,grade:g?.label||'',points:g?.points??'',teacher_name:teacherLabel(teacherBySubject.get(s.subject_id))};}).sort((a,b)=>b.average-a.average||a.subject_name.localeCompare(b.subject_name));
 const result={rows,subject_rankings};
 setMeritCache(cacheKey,result);
 return result;
}
router.get('/:schoolId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{try{const sid=req.params.schoolId,cls=req.query.class_id||null,y=req.query.academic_year_id||null,t=req.query.term_id||null,a=req.query.assessment_id||null;await enforceMeritClassAccess(req,sid,cls,y);res.json(await compute(sid,y,t,cls,a));}catch(e){res.status(e.status||400).json({error:e.message});}});
router.post('/:schoolId/runs',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'),async(req,res)=>{try{const b=req.body,r=await compute(req.params.schoolId,b.academic_year_id,b.term_id,b.class_id||null,b.assessment_id||null);const q=await db.query(`INSERT INTO merit_runs(school_id,academic_year_id,term_id,basis,filters,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.params.schoolId,b.academic_year_id,b.term_id,b.basis||'AVERAGE',JSON.stringify(b.filters||{}),req.user.user_id]);res.status(201).json({run:q.rows[0],...r});}catch(e){res.status(e.status||400).json({error:e.message});}});
router.get('/:schoolId/pdf',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{try{
 const sid=req.params.schoolId,yearId=req.query.academic_year_id,termId=req.query.term_id,classId=req.query.class_id||null,assessmentId=req.query.assessment_id||null;
 if(!classId)return res.status(400).json({error:'Select a class before generating the merit PDF.'});
 await enforceMeritClassAccess(req,sid,classId,yearId);
 const r=await compute(sid,yearId,termId,classId,assessmentId);
 const meta=(await db.query(`SELECT s.name school_name,s.code school_code,si.logo_url,si.motto,si.address,si.contact_phone,si.contact_email,si.primary_color,si.secondary_color,si.watermark_enabled,
   (SELECT file_url FROM school_document_assets da WHERE da.school_id=s.id AND da.asset_type='STAMP' AND da.is_active=true ORDER BY da.effective_from DESC,da.created_at DESC LIMIT 1) stamp_url,
   ay.year_label,t.name term_name,c.name class_name,c.stream
   FROM schools s LEFT JOIN school_identity si ON si.school_id=s.id
   JOIN academic_years ay ON ay.id=$2 JOIN terms t ON t.id=$3
   JOIN classes c ON c.id=$4 WHERE s.id=$1`,[sid,yearId,termId,classId])).rows[0]||{};
 const configuredSubjects=(await db.query(`SELECT DISTINCT ON (s.id) s.id subject_id,s.code subject_code,s.name subject_name
   FROM teacher_subject_assignments tsa JOIN subjects s ON s.id=tsa.subject_id
   WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3 AND (tsa.term_id=$4 OR tsa.term_id IS NULL)
   ORDER BY s.id,(tsa.term_id IS NOT NULL) DESC,tsa.created_at,tsa.id`,[sid,classId,yearId,termId])).rows;
 const computedSubjects=[...new Map(r.rows.flatMap(x=>x.subjects||[]).map(s=>[s.subject_id,s])).values()];
 const computedSubjectIds=new Set(computedSubjects.map(s=>String(s.subject_id)));
 const configuredUsed=configuredSubjects.filter(s=>computedSubjectIds.has(String(s.subject_id)));
 const configuredIds=new Set(configuredUsed.map(s=>String(s.subject_id)));
 const subjects=[...configuredUsed,...computedSubjects.filter(s=>!configuredIds.has(String(s.subject_id)))];

 // Merit uses one fixed landscape width. The content area reserves a dedicated
 // footer band on every page so the footer can never force/occupy a second page.
 const pageSize='A4';
 const doc=new PDFDocument({size:pageSize,layout:'landscape',margin:18,autoFirstPage:false});
 const chunks=[];
 doc.on('data',chunk=>chunks.push(chunk));
 const pdfDone=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 // Explicitly create the first page before accessing doc.page.
 doc.addPage({size:pageSize,layout:'landscape',margin:18});
 const pageW=doc.page.width,pageH=doc.page.height,margin=28,tableW=pageW-margin*2,x0=margin;
 const footerBandHeight=48;
 const footerBandTop=pageH-footerBandHeight;
 const contentBottom=footerBandTop-7;
 const navy=(String(meta.primary_color||'').toUpperCase()==='#17365D'?'#0B4F8A':meta.primary_color)||'#0B4F8A',gold=(String(meta.secondary_color||'').toUpperCase()==='#D9A441'?'#16A36A':meta.secondary_color)||'#16A36A',ink='#111111',muted='#374151',grid='#111111';
 const fixed=[52,52,125,72],tail=[38,38,42,42,34];
 const available=tableW-fixed.reduce((a,b)=>a+b,0)-tail.reduce((a,b)=>a+b,0);
 const subjectW=subjects.length?Math.max(15,available/subjects.length):available;
 const widths=[...fixed,...subjects.map(()=>subjectW),...tail];
 const headerH=38,rowH=28;
 const gradeFill=g=>g==='EE'?'#DDF4E4':g==='ME'?'#E5F0FB':g==='AE'?'#FFF0C9':g==='BE'?'#FBE0E0':'#F5F7FA';

 // Branding is shown as a header on the same page as the data — no separate
 // near-empty cover page, so nothing is skipped over when flipping/printing.
 let y=42;
 const drawPageHeader=()=>{
   const logoPath=assetSource(meta.logo_url);
   if(logoPath)try{doc.image(logoPath,x0,y,{fit:[48,48]});}catch{}
   // Subtle ZELIMU CBC identity watermark, analogous to a document security watermark.
   if(meta.watermark_enabled!==false){if(logoPath)try{doc.save().opacity(.055);doc.image(logoPath,x0+tableW/2-115,pageH/2-115,{fit:[230,230],align:'center',valign:'center'});doc.restore();}catch{try{doc.restore();}catch{}}else drawTextWatermark(doc,meta.school_name,meta.motto,pageW/2,pageH/2,420,.035);}
   doc.fillColor(navy).font('Helvetica-Bold').fontSize(13).text(meta.school_name||'SCHOOL',x0+48,y+2,{width:tableW-48});
   if(meta.motto)doc.fillColor(muted).font('Helvetica').fontSize(6.5).text(String(meta.motto),x0+48,y+17,{width:tableW-48,lineBreak:false,ellipsis:true});
   doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text('CLASS MERIT REPORT',x0+48,y+29,{width:tableW-48});
   doc.fillColor(muted).font('Helvetica').fontSize(7).text(`${meta.year_label||''} • ${meta.term_name||''} • ${meta.class_name||''}${meta.stream?' · '+meta.stream:''}`,x0+48,y+44,{width:tableW-48});
   y+=61;
   doc.moveTo(x0,y).lineTo(x0+tableW,y).strokeColor(gold).lineWidth(1.4).stroke();y+=13;
   doc.fillColor(ink).font('Helvetica-Bold').fontSize(8).text('MERIT / MARK SHEET',x0,y);
   const assessmentLabel=(usedAssessmentTypes||[]).length?usedAssessmentTypes.join(' • '):'ALL CONFIGURED MAIN ASSESSMENTS';
   doc.fillColor(muted).font('Helvetica-Bold').fontSize(5.8).text(`TERM: ${meta.term_name||'—'}  •  TYPE OF ASSESSMENT: ${assessmentLabel}`,x0+100,y+1,{width:tableW-100,lineBreak:false,ellipsis:true});
   doc.fillColor(muted).font('Helvetica').fontSize(6.1).text('Highest total marks first • Average = total marks ÷ subjects assessed • Grade uses the rounded whole-number average.',x0,y+11,{width:tableW,lineBreak:false,ellipsis:true});
   y+=24;
   let xx=x0;doc.fillColor(navy).rect(x0,y,tableW,headerH).fill();
   const heads=['ADM. NO.','ASSES. NO.','STUDENT NAME','CLASS / STREAM',...subjects.map(s=>(s.subject_code||s.subject_name||'').toUpperCase()),'TOTAL','AVERAGE','CLASS POS.','OVERALL POS.','GRADE'];
   heads.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(i<4?5.8:4.5);doc.text(String(h),xx+2,y+7,{width:widths[i]-4,height:headerH-10,align:i<4?'left':'center',lineBreak:false,ellipsis:true});if(i<heads.length-1){doc.strokeColor('#FFFFFF').lineWidth(.7).moveTo(xx+widths[i],y).lineTo(xx+widths[i],y+headerH).stroke();}xx+=widths[i];});
   y+=headerH;
 };
 const usedAssessments=[...new Map(r.rows.flatMap(row=>row.assessments_used||[]).map(a=>[String(a.id||a.type||a.name),a])).values()].sort((a,b)=>Number(a.order||0)-Number(b.order||0));
 const usedAssessmentTypes=[...new Set(usedAssessments.map(a=>{const name=String(a.name||'').trim(),type=String(a.type||'').trim();return name&&type&&name.toUpperCase()!==type.toUpperCase()?`${name} (${type})`:name||type;}).filter(Boolean))];
 const footer=()=>{
   const fy=pageH-34;
   doc.save().strokeColor('#111111').lineWidth(.8).moveTo(x0,footerBandTop).lineTo(x0+tableW,footerBandTop).stroke().restore();
   doc.fillColor(muted).font('Helvetica').fontSize(5.2).text(`ZELIMU CBC • ${meta.contact_email||'School contact email'} • ${meta.class_name||''}${meta.stream?' · '+meta.stream:''} • Page ${doc.page.index+1}`,x0,fy,{width:tableW,height:7,align:'right',lineBreak:false,ellipsis:true});
 };
 drawPageHeader();
 if(r.diagnostics && !r.rows.length){
   doc.fillColor('#991B1B').font('Helvetica-Bold').fontSize(11).text('MERIT DATA CHECK',x0,y,tableW);
   y+=18;doc.fillColor(ink).font('Helvetica').fontSize(8).text(String(r.diagnostics),x0,y,tableW,{height:70,ellipsis:false,lineBreak:true});
   y+=78;doc.fillColor(muted).font('Helvetica').fontSize(7).text('No ranking rows were generated because the selected filters/configuration produced no usable main-assessment marks.',x0,y,tableW);
   y+=18;
 }
 if(usedAssessments.length){
   const label='ASSESSMENTS USED: '+usedAssessments.map(a=>String(a.name||a.type||'')).join(' • ');
   doc.fillColor(muted).font('Helvetica-Bold').fontSize(6).text(label,x0,y,tableW,{ellipsis:true});
   y+=12;
 }
 r.rows.forEach((row,idx)=>{
   if(y+rowH>contentBottom){footer();doc.addPage({size:pageSize,layout:'landscape',margin:18});y=42;drawPageHeader();}
   let x=x0;
   if(idx%2===0)doc.save().fillColor('#FBFCFD').rect(x,y,tableW,rowH).fill().restore();
   doc.strokeColor(grid).lineWidth(1).rect(x,y,tableW,rowH).stroke();
   let gx=x; widths.forEach((wi)=>{gx+=wi; if(gx<x+tableW-.1){doc.moveTo(gx,y).lineTo(gx,y+rowH).stroke();}});
   const learnerName=`${row.first_name||''} ${row.last_name||''}`.trim()||'—';
   const learnerClass=row.class_name ? `${row.class_name}${row.class_stream ? ' / '+row.class_stream : ''}` : '—';
   const core=[row.admission_no||'',row.assessment_no||'',learnerName,learnerClass];
   core.forEach((v,i)=>{doc.fillColor(ink).font(i>=2?'Helvetica-Bold':'Helvetica').fontSize(i===2?6.5:i===3?5.8:6);doc.text(String(v),x+3,y+12,{width:widths[i]-6,height:rowH-8,align:'left',ellipsis:true,lineBreak:false});x+=widths[i];});
   subjects.forEach(sub=>{
     const got=(row.subjects||[]).find(s=>s.subject_id===sub.subject_id);
     const mark=got?.display_average??(got?.average==null?null:Math.round(Number(got.average)));const grade=got?.grade||'';
     doc.fillColor(ink).font('Helvetica-Bold').fontSize(5.4).text(mark,x+1,y+5,{width:widths[4]-2,align:'center'});
     doc.fillColor(gradeFill(grade)).rect(x+2,y+18,widths[4]-4,11).fill();
     doc.fillColor(ink).font('Helvetica-Bold').fontSize(5).text(grade,x+2,y+20,{width:widths[4]-4,align:'center'});x+=widths[4];
   });
   const vals=[fmt(row.total_mark),fmt(row.average_mark),row.class_rank==null?'—':String(row.class_rank),row.overall_rank==null?'—':String(row.overall_rank),row.overall_grade||''];
   vals.forEach((v,j)=>{const wi=tail[j];if(j===2)doc.fillColor(gradeFill(v)).rect(x,y,wi,rowH).fill();doc.fillColor(ink).font('Helvetica-Bold').fontSize(6).text(String(v),x+2,y+12,{width:wi-4,align:'center'});x+=wi;});
   y+=rowH;
 });

 // Subject averages summary is part of the merit report and is always rendered
 // after the learner register, continuing onto a new page only when necessary.
 const summaryTitleH=24, summaryRowH=18;
 const summaryRows=r.subject_rankings||[];
 const summaryNeeded=summaryTitleH + summaryRows.length*summaryRowH + 28;
 if(summaryRows.length){
   if(y+summaryNeeded>contentBottom){
     footer();
     doc.addPage({size:pageSize,layout:'landscape',margin:18});
     y=42;
     drawPageHeader();
   }
   doc.fillColor(navy).font('Helvetica-Bold').fontSize(9).text('SUBJECT AVERAGES • CLASS RANKING • SUBJECT TEACHERS',x0,y);
   y+=12;
   const sw=[38,210,70,58,120];
   const sh=['RANK','SUBJECT / LEARNING AREA','CLASS AVERAGE','GRADE','SUBJECT TEACHER'];
   let sx=x0;
   doc.fillColor(navy).rect(x0,y,tableW,18).fill();
   sh.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(5.5).text(h,sx+2,y+6,{width:sw[i]-4,align:i===1||i===4?'left':'center',lineBreak:false});if(i<sh.length-1){doc.strokeColor('#FFFFFF').lineWidth(.7).moveTo(sx+sw[i],y).lineTo(sx+sw[i],y+18).stroke();}sx+=sw[i];});
   y+=18;
   summaryRows.forEach((sr,i)=>{
     if(y+summaryRowH>contentBottom){
       footer(); doc.addPage({size:'A4',layout:'landscape',margin:18}); y=42; drawPageHeader();
       doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text('SUBJECT AVERAGES • CONTINUED',x0,y); y+=12;
     }
     if(i%2===0)doc.save().fillColor('#FBFCFD').rect(x0,y,tableW,summaryRowH).fill().restore();
     doc.strokeColor(grid).lineWidth(1).rect(x0,y,tableW,summaryRowH).stroke();
     let sg=x0; sw.forEach((wi)=>{sg+=wi; if(sg<x0+tableW-.1){doc.moveTo(sg,y).lineTo(sg,y+summaryRowH).stroke();}});
     const vals=[String(i+1),String(sr.subject_name||sr.subject_code||'—'),fmt(sr.average),String(sr.grade||'—'),String(sr.teacher_name||'—')];
     let xx=x0; vals.forEach((v,j)=>{doc.fillColor(ink).font(j===1||j===4?'Helvetica-Bold':'Helvetica').fontSize(5.8).text(v,xx+3,y+6,{width:sw[j]-6,align:j===1||j===4?'left':'center',ellipsis:true,lineBreak:false});xx+=sw[j];});
     y+=summaryRowH;
   });
   y+=6;
 }
 footer();doc.end();
 const pdf=await pdfDone;
 res.setHeader('Content-Type','application/pdf');
 res.setHeader('Content-Disposition','inline; filename="zelimu-cbc-merit-list.pdf"');
 res.end(pdf);
 }catch(e){console.error('Merit PDF failed:',e);if(!res.headersSent)res.status(e.status||400).json({error:e.message||'Unable to create merit PDF'});}});
module.exports=router;
