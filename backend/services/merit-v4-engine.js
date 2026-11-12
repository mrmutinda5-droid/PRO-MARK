'use strict';
// Isolated merit calculations. No database writes or dashboard changes.
const EPS=1e-9;
function weightedSubject(marks, exams) {
 if(!Array.isArray(exams)||!exams.length)return {complete:false,score:null,reason:'NO_REQUIRED_EXAMS'};
 const ids=exams.map(e=>String(e.id));
 if(new Set(ids).size!==ids.length)return {complete:false,score:null,reason:'DUPLICATE_EXAM'};
 const weights=exams.map(e=>Number(e.weight));
 if(weights.some(w=>!Number.isFinite(w)||w<0)||Math.abs(weights.reduce((a,b)=>a+b,0)-100)>EPS)
  return {complete:false,score:null,reason:'INVALID_WEIGHTS'};
 const byId=new Map();
 for(const m of marks||[]) {
  const id=String(m.assessment_id);
  if(byId.has(id))return {complete:false,score:null,reason:'DUPLICATE_MARK'};
  byId.set(id,m);
 }
 let score=0;
 for(let i=0;i<exams.length;i++){
  const m=byId.get(ids[i]);
  if(!m||m.percent===null||m.percent===undefined||m.percent==='')
   return {complete:false,score:null,reason:'MISSING_EXAM',assessment_id:ids[i]};
  const p=Number(m.percent);
  if(!Number.isFinite(p)||p<0||p>100)return {complete:false,score:null,reason:'INVALID_MARK'};
  score+=p*weights[i]/100;
 }
 return {complete:true,score,reason:null};
}
function learnerAverage(subjectResults,expectedSubjectIds,exemptSubjectIds=[]){
 const expected=[...new Set((expectedSubjectIds||[]).map(String))];
 const exempt=new Set((exemptSubjectIds||[]).map(String));
 if(!expected.length)return {complete:false,average:null,reason:'NO_EXPECTED_SUBJECTS'};
 const required=expected.filter(id=>!exempt.has(id));
 if(!required.length)return {complete:false,average:null,reason:'ALL_EXEMPT'};
 const byId=new Map((subjectResults||[]).map(s=>[String(s.subject_id),s]));
 let total=0;
 for(const id of required){
  const s=byId.get(id);
  if(!s||s.complete!==true||!Number.isFinite(s.score))
   return {complete:false,average:null,reason:'INCOMPLETE_SUBJECT',subject_id:id};
  total+=s.score;
 }
 return {complete:true,average:total/required.length,reason:null,subject_count:required.length};
}
function rankGroup(learners){
 const eligible=(learners||[]).filter(x=>x.complete===true&&Number.isFinite(x.average))
  .slice().sort((a,b)=>b.average-a.average||String(a.learner_id).localeCompare(String(b.learner_id)));
 const ranks=new Map();let previous=null,rank=0;
 eligible.forEach((x,i)=>{if(previous===null||Math.abs(x.average-previous)>EPS){rank=i+1;previous=x.average;}ranks.set(String(x.learner_id),rank);});
 return {ranks,total:eligible.length};
}
function scopedRanks(learners){
 const byGrade=new Map(),byClass=new Map();
 for(const l of learners||[]){
  const grade=String(l.school_level_id),cls=String(l.class_id);
  if(!byGrade.has(grade))byGrade.set(grade,[]);
  if(!byClass.has(cls))byClass.set(cls,[]);
  byGrade.get(grade).push(l);byClass.get(cls).push(l);
 }
 const grades=new Map([...byGrade].map(([k,v])=>[k,rankGroup(v)]));
 const classes=new Map([...byClass].map(([k,v])=>[k,rankGroup(v)]));
 return (learners||[]).map(l=>{
  const c=classes.get(String(l.class_id)),g=grades.get(String(l.school_level_id)),id=String(l.learner_id);
  return {...l,stream_rank:c.ranks.get(id)??null,stream_rank_total:c.total,
   class_rank:c.ranks.get(id)??null,class_rank_total:c.total,
   overall_rank:g.ranks.get(id)??null,overall_rank_total:g.total};
 });
}
module.exports={weightedSubject,learnerAverage,rankGroup,scopedRanks};
