'use strict';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSITIONS={ISSUED:new Set(['DRAFT']),REVOKED:new Set(['ISSUED'])};
const CATEGORIES=new Set(['ACADEMIC_ACHIEVEMENT','SUBJECT_PERFORMANCE','MOST_IMPROVED','COMPLETION','CO_CURRICULAR','SPORTS','SCHOOL_RECOGNITION']);

function validateCertificateDraft(body={}){
 const learnerId=String(body.learner_id||'');
 const category=String(body.category||'ACADEMIC_ACHIEVEMENT');
 const title=String(body.title||'').trim();
 const statement=String(body.achievement_statement||'').trim();
 const academicYearId=body.academic_year_id||null;
 const termId=body.term_id||null;
 if(!UUID.test(learnerId))throw Object.assign(new Error('Select a valid learner.'),{status:400});
 if(!CATEGORIES.has(category))throw Object.assign(new Error('Select a valid certificate category.'),{status:400});
 if(title.length<3||title.length>120)throw Object.assign(new Error('Certificate title must be between 3 and 120 characters.'),{status:400});
 if(statement.length<4||statement.length>1000)throw Object.assign(new Error('Achievement statement must be between 4 and 1,000 characters.'),{status:400});
 if(academicYearId&&!UUID.test(String(academicYearId)))throw Object.assign(new Error('Select a valid academic year.'),{status:400});
 if(termId&&!UUID.test(String(termId)))throw Object.assign(new Error('Select a valid term.'),{status:400});
 return {learner_id:learnerId,category,title,achievement_statement:statement,academic_year_id:academicYearId,term_id:termId};
}

function assertCertificateTransition(current,next){
 if(!TRANSITIONS[next]?.has(current))throw Object.assign(new Error(`A certificate cannot move from ${current} to ${next}.`),{status:409});
}

module.exports={validateCertificateDraft,assertCertificateTransition};
