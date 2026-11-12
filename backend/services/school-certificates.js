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
 const subjectOrActivity=String(body.subject_or_activity||'').trim();
 const achievementDate=body.achievement_date?String(body.achievement_date):null;
 const signerName=String(body.signer_name||'').trim();
 const signerTitle=String(body.signer_title||'').trim();
 const secondSignerName=String(body.second_signer_name||'').trim();
 const secondSignerTitle=String(body.second_signer_title||'').trim();
 const replacesCertificateId=body.replaces_certificate_id||null;
 if(!UUID.test(learnerId))throw Object.assign(new Error('Select a valid learner.'),{status:400});
 if(!CATEGORIES.has(category))throw Object.assign(new Error('Select a valid certificate category.'),{status:400});
 if(title.length<3||title.length>120)throw Object.assign(new Error('Certificate title must be between 3 and 120 characters.'),{status:400});
 if(statement.length<4||statement.length>1000)throw Object.assign(new Error('Achievement statement must be between 4 and 1,000 characters.'),{status:400});
 if(subjectOrActivity.length>120)throw Object.assign(new Error('Subject or activity must be at most 120 characters.'),{status:400});
 if(achievementDate){
  const parsed=Date.parse(`${achievementDate}T00:00:00.000Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(achievementDate)||Number.isNaN(parsed)||new Date(parsed).toISOString().slice(0,10)!==achievementDate)
   throw Object.assign(new Error('Enter a valid achievement date.'),{status:400});
 }
 for(const [label,value] of [['Signer name',signerName],['Signer title',signerTitle],['Second signer name',secondSignerName],['Second signer title',secondSignerTitle]])
  if(value.length>100)throw Object.assign(new Error(`${label} must be at most 100 characters.`),{status:400});
 if(academicYearId&&!UUID.test(String(academicYearId)))throw Object.assign(new Error('Select a valid academic year.'),{status:400});
 if(termId&&!UUID.test(String(termId)))throw Object.assign(new Error('Select a valid term.'),{status:400});
 if(replacesCertificateId&&!UUID.test(String(replacesCertificateId)))throw Object.assign(new Error('Select a valid certificate being replaced.'),{status:400});
 return {
  learner_id:learnerId,category,title,achievement_statement:statement,academic_year_id:academicYearId,term_id:termId,
  subject_or_activity:subjectOrActivity||null,achievement_date:achievementDate,
  signer_name:signerName||null,signer_title:signerTitle||null,
  second_signer_name:secondSignerName||null,second_signer_title:secondSignerTitle||null,
  replaces_certificate_id:replacesCertificateId
 };
}

function assertCertificateTransition(current,next){
 if(!TRANSITIONS[next]?.has(current))throw Object.assign(new Error(`A certificate cannot move from ${current} to ${next}.`),{status:409});
}

module.exports={validateCertificateDraft,assertCertificateTransition};
