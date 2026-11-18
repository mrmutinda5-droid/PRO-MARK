'use strict';
const {normalizeType,validateWeights}=require('./merit-v6-engine');
const {weightedSubject,learnerAverage,scopedRanks}=require('./merit-v4-engine');
// An assessment may be global, class-specific, subject-specific or both.
// Prefer the most specific applicable setup; reject equally specific duplicates.
function selectAssessment(assessments,type,classId,subjectId){
 const matches=(assessments||[]).filter(a=>normalizeType(a.assessment_type)===type &&
  (!a.class_id||String(a.class_id)===String(classId)) &&
  (!a.subject_id||String(a.subject_id)===String(subjectId)));
 if(!matches.length)return {error:'MISSING_ASSESSMENT_SETUP'};
 const specificity=a=>Number(Boolean(a.class_id))+Number(Boolean(a.subject_id));
 const top=Math.max(...matches.map(specificity));
 const winners=matches.filter(a=>specificity(a)===top);
 if(winners.length!==1)return {error:'AMBIGUOUS_ASSESSMENT_SETUP'};
 return {assessment:winners[0]};
}
function calculateSubject(marks,assessments,weights,classId,subjectId){
 const chosen=[];
 for(const item of validateWeights(weights)){
  const match=selectAssessment(assessments,item.assessment_type,classId,subjectId);
  if(match.error)return {complete:false,score:null,reason:match.error,assessment_type:item.assessment_type};
  chosen.push({id:match.assessment.id,weight:item.weight});
 }
 // Ignore marks belonging to unrelated assessments; still detect duplicate marks for required ones.
 const ids=new Set(chosen.map(a=>String(a.id)));
 return weightedSubject((marks||[]).filter(m=>ids.has(String(m.assessment_id))),chosen);
}
function calculateClass(learners,assessments,weights,expectedSubjects){
 const validated=validateWeights(weights);
 const output=(learners||[]).map(l=>{
  const subjects=(expectedSubjects||[]).map(subject_id=>({subject_id,...calculateSubject(
   l.subjects?.find(s=>String(s.subject_id)===String(subject_id))?.marks||[],assessments,validated,l.class_id,subject_id)}));
  const avg=learnerAverage(subjects,expectedSubjects,l.exempt_subject_ids||[]);
  return {...l,subjects,complete:avg.complete,average:avg.average,incomplete_reason:avg.reason||null};
 });
 return scopedRanks(output);
}
module.exports={selectAssessment,calculateSubject,calculateClass};
