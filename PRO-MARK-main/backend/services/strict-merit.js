// Pure, independently testable official merit calculation rules.
function subjectScore(items,required=null){
 if(!Array.isArray(items)||!items.length)return null;
 const valid=items.filter(x=>Number.isFinite(Number(x.percent))&&Number(x.percent)>=0&&Number(x.percent)<=100);
 if(valid.length!==items.length)return null;
 if(required){
  if(!required.length)return null;
  const weights=required.map(a=>Number(a.weight));
  if(weights.some(w=>!Number.isFinite(w)||w<0)||Math.abs(weights.reduce((a,b)=>a+b,0)-100)>0.000001)return null;
  const byId=new Map(valid.map(x=>[String(x.assessment_id),x]));
  if(required.some(a=>!byId.has(String(a.id))))return null;
  return required.reduce((sum,a)=>sum+Number(byId.get(String(a.id)).percent)*Number(a.weight)/100,0);
 }
 return valid.reduce((sum,x)=>sum+Number(x.percent),0)/valid.length;
}
function competitionRanks(items){
 const sorted=items.filter(x=>x.complete&&Number.isFinite(x.average_mark)).sort((a,b)=>b.average_mark-a.average_mark||String(a.learner_id).localeCompare(String(b.learner_id)));
 const ranks=new Map();let previous=null,rank=0;
 sorted.forEach((x,i)=>{if(previous===null||Math.abs(x.average_mark-previous)>1e-9){rank=i+1;previous=x.average_mark;}ranks.set(String(x.learner_id),rank);});
 return {sorted,ranks};
}
module.exports={subjectScore,competitionRanks};
