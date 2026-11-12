'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {validateCertificateDraft,assertCertificateTransition}=require('../backend/services/school-certificates');

const draft={
 learner_id:'123e4567-e89b-42d3-a456-426614174000',
 title:'Certificate of Achievement',
 achievement_statement:'Awarded for the verified achievement recorded by the school.',
 academic_year_id:'123e4567-e89b-42d3-a456-426614174001',
 term_id:'123e4567-e89b-42d3-a456-426614174002'
};

test('validates and normalizes academic certificate drafts',()=>{
 const optionalFields={subject_or_activity:null,achievement_date:null,signer_name:null,signer_title:null,second_signer_name:null,second_signer_title:null,replaces_certificate_id:null};
 assert.deepEqual(validateCertificateDraft(draft),{...draft,category:'ACADEMIC_ACHIEVEMENT',...optionalFields});
 assert.deepEqual(validateCertificateDraft({...draft,category:'SPORTS'}),{...draft,category:'SPORTS',...optionalFields});
 assert.deepEqual(validateCertificateDraft({...draft,title:'  Recognition  ',academic_year_id:'',term_id:''}),{
  ...draft,category:'ACADEMIC_ACHIEVEMENT',title:'Recognition',academic_year_id:null,term_id:null,...optionalFields
 });
});

test('rejects invalid learner, context identifiers, title and statement',()=>{
 assert.throws(()=>validateCertificateDraft({...draft,learner_id:'not-a-uuid'}),/valid learner/);
 assert.throws(()=>validateCertificateDraft({...draft,category:'UNVERIFIED'}),/valid certificate category/);
 assert.throws(()=>validateCertificateDraft({...draft,academic_year_id:'wrong'}),/valid academic year/);
 assert.throws(()=>validateCertificateDraft({...draft,title:'x'}),/Certificate title/);
 assert.throws(()=>validateCertificateDraft({...draft,achievement_statement:'no'}),/Achievement statement/);
 assert.throws(()=>validateCertificateDraft({...draft,achievement_date:'2025-02-31'}),/valid achievement date/);
 assert.throws(()=>validateCertificateDraft({...draft,subject_or_activity:'x'.repeat(121)}),/Subject or activity/);
 assert.throws(()=>validateCertificateDraft({...draft,replaces_certificate_id:'invalid'}),/valid certificate being replaced/);
});

test('preserves optional certificate-specific details',()=>{
 assert.deepEqual(validateCertificateDraft({...draft,subject_or_activity:'Mathematics',achievement_date:'2025-04-30',signer_name:'A. Principal',signer_title:'Headteacher'}),{
  ...draft,category:'ACADEMIC_ACHIEVEMENT',subject_or_activity:'Mathematics',achievement_date:'2025-04-30',
  signer_name:'A. Principal',signer_title:'Headteacher',second_signer_name:null,second_signer_title:null,replaces_certificate_id:null
 });
});

test('allows only draft issue and issued revocation transitions',()=>{
 assertCertificateTransition('DRAFT','ISSUED');
 assertCertificateTransition('ISSUED','REVOKED');
 assert.throws(()=>assertCertificateTransition('ISSUED','ISSUED'),/cannot move/);
 assert.throws(()=>assertCertificateTransition('REVOKED','ISSUED'),/cannot move/);
});
