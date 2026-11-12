'use strict';
// V6 pure calculation engine: no writes, no side effects.
const {weightedSubject,learnerAverage,scopedRanks}=require('./merit-v4-engine');
const TYPES=['OPENER','CAT_1','CAT_2','MID_TERM','END_TERM'];
function normalizeType(value){const s=String(value||'').trim().toUpperCase().replace(/[\s-]+/g,'_');const aliases={CAT1:'CAT_1',CAT2:'CAT_2',CAT:'CAT_1',MIDTERM:'MID_TERM',ENDTERM:'END_TERM',CONTINUOUS_ASSESSMENT:'CAT_1'};return aliases[s]||s;}
function validateWeights(input){
 if(!Array.isArray(input)||!input.length)throw new Error('Select at least one assessment weight.');
 const seen=new Set(),out=[];
 for(const item of input){
  const assessment_type=normalizeType(item.assessment_type||item.type);
  if(!TYPES.includes(assessment_type))throw new Error('Unsupported assessment type: '+assessment_type);
  if(seen.has(assessment_type))throw new Error('Duplicate assessment type: '+assessment_type);
  seen.add(assessment_type);
  const weight=Number(item.weight);
  if(item.weight===null||item.weight===undefined||item.weight===''||!Number.isFinite(weight)||weight<=0||weight>100)throw new Error('Each included assessment needs a weight above 0 and at most 100.');
  out.push({assessment_type,weight});
 }
 const total=out.reduce((s,x)=>s+x.weight,0);
 if(Math.abs(total-100)>1e-7)throw new Error('Assessment weights must total exactly 100%; received '+total+'%.');
 return out;
}
function chooseWeights(defaultWeights,classOverrides,classId){
 const override=classId&&classOverrides&&classOverrides[String(classId)];
 return validateWeights(override||defaultWeights);
}
function calculateSubjectTerm(marks,assessments,weights){
 const w=validateWeights(weights),byType=new Map();
 for(const a of assessments||[]){const type=normalizeType(a.assessment_type);if(!w.some(x=>x.assessment_type===type))continue;
  if(byType.has(type))return {complete:false,score:null,reason:'AMBIGUOUS_ASSESSMENT_TYPE',assessment_type:type};
  byType.set(type,a);
 }
 for(const item of w)if(!byType.has(item.assessment_type))return {complete:false,score:null,reason:'MISSING_ASSESSMENT_SETUP',assessment_type:item.assessment_type};
 const exams=w.map(item=>({id:byType.get(item.assessment_type).id,weight:item.weight}));
 return weightedSubject(marks,exams);
}
function calculateTermLearners(learners,assessments,weights,expectedSubjectsByClass){
 const output=(learners||[]).map(l=>{
  const selected=chooseWeights(weights.default,weights.overrides,l.class_id);
  const subjects=(l.subjects||[]).map(s=>({subject_id:s.subject_id,...calculateSubjectTerm(s.marks,assessments.filter(a=>!a.class_id||String(a.class_id)===String(l.class_id)),selected)}));
  const avg=learnerAverage(subjects,(expectedSubjectsByClass||{})[String(l.class_id)]||[],l.exempt_subject_ids||[]);
  return {...l,subjects,complete:avg.complete,average:avg.average,incomplete_reason:avg.reason||null};
 });
 return scopedRanks(output);
}
module.exports={TYPES,normalizeType,validateWeights,chooseWeights,calculateSubjectTerm,calculateTermLearners};
