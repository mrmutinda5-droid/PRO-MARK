const STANDARD_TYPES = ['OPENER','MID_TERM','END_TERM'];
const STANDARD_LABELS = {OPENER:'Opener', MID_TERM:'Mid Term', END_TERM:'End Term'};
function standardAssessmentType(value){const t=String(value||'').trim().toUpperCase().replace(/[-\s]+/g,'_');return STANDARD_TYPES.includes(t)?t:null;}
function canonicalAssessmentName(type){return STANDARD_LABELS[standardAssessmentType(type)]||String(type||'Assessment').trim();}
module.exports={STANDARD_TYPES,STANDARD_LABELS,standardAssessmentType,canonicalAssessmentName};
