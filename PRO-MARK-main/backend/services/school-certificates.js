'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSITIONS = { ISSUED: new Set(['DRAFT']), REVOKED: new Set(['ISSUED']) };
const CATEGORIES = new Set([
  'ACADEMIC_ACHIEVEMENT', 'SUBJECT_PERFORMANCE', 'MOST_IMPROVED',
  'COMPLETION', 'CO_CURRICULAR', 'SPORTS', 'SCHOOL_RECOGNITION',
  'SCHOOL_LEAVING', 'LEADERSHIP', 'CONDUCT'
]);

function validIsoDate(value, label) {
  const str = String(value || '').trim();
  if (!str) return null;
  const parsed = Date.parse(`${str}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== str) {
    throw Object.assign(new Error(`Enter a valid ${label}.`), { status: 400 });
  }
  return str;
}

function sanitizeMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  if (raw.leaving_details && typeof raw.leaving_details === 'object' && !Array.isArray(raw.leaving_details)) {
    const ld = raw.leaving_details;
    out.leaving_details = {
      admission_date: ld.admission_date ? validIsoDate(ld.admission_date, 'admission date') : null,
      leaving_date: ld.leaving_date ? validIsoDate(ld.leaving_date, 'leaving date') : null,
      last_class: String(ld.last_class || '').trim().slice(0, 80) || null,
      conduct_remark: String(ld.conduct_remark || '').trim().slice(0, 180) || null,
      reason_for_leaving: String(ld.reason_for_leaving || '').trim().slice(0, 180) || null,
      kcpe_or_kpsea_index: String(ld.kcpe_or_kpsea_index || '').trim().slice(0, 80) || null
    };
  }
  if (raw.merit_score != null && Number.isFinite(Number(raw.merit_score))) {
    out.merit_score = Number(Number(raw.merit_score).toFixed(2));
  }
  if (raw.grade) out.grade = String(raw.grade).trim().slice(0, 20);
  if (raw.rank != null && Number.isInteger(Number(raw.rank))) out.rank = Number(raw.rank);
  return out;
}

function validateCertificateDraft(body = {}, allowedCategories = null) {
  const learnerId = String(body.learner_id || '');
  const category = String(body.category || 'ACADEMIC_ACHIEVEMENT').trim().toUpperCase();
  const title = String(body.title || '').trim();
  const statement = String(body.achievement_statement || '').trim();
  const academicYearId = body.academic_year_id || null;
  const termId = body.term_id || null;
  const assessmentId = body.assessment_id || null;
  const subjectId = body.subject_id || null;
  const signerUserId = body.signer_user_id || null;
  const secondSignerUserId = body.second_signer_user_id || null;
  const subjectOrActivity = String(body.subject_or_activity || '').trim();
  const achievementDate = validIsoDate(body.achievement_date, 'achievement date');
  const signerName = String(body.signer_name || '').trim();
  const signerTitle = String(body.signer_title || '').trim();
  const secondSignerName = String(body.second_signer_name || '').trim();
  const secondSignerTitle = String(body.second_signer_title || '').trim();
  const replacesCertificateId = body.replaces_certificate_id || null;

  if (!UUID.test(learnerId)) throw Object.assign(new Error('Select a valid learner.'), { status: 400 });
  const validCat = CATEGORIES.has(category) || (allowedCategories instanceof Set && allowedCategories.has(category));
  if (!validCat) throw Object.assign(new Error('Select a valid certificate category.'), { status: 400 });
  if (title.length < 3 || title.length > 120) throw Object.assign(new Error('Certificate title must be between 3 and 120 characters.'), { status: 400 });
  if (statement.length < 4 || statement.length > 1000) throw Object.assign(new Error('Achievement statement must be between 4 and 1,000 characters.'), { status: 400 });
  if (subjectOrActivity.length > 120) throw Object.assign(new Error('Subject or activity must be at most 120 characters.'), { status: 400 });

  for (const [label, value] of [
    ['Signer name', signerName], ['Signer title', signerTitle],
    ['Second signer name', secondSignerName], ['Second signer title', secondSignerTitle]
  ]) {
    if (value.length > 100) throw Object.assign(new Error(`${label} must be at most 100 characters.`), { status: 400 });
  }
  for (const [label, val] of [
    ['academic year', academicYearId], ['term', termId],
    ['assessment', assessmentId], ['subject', subjectId],
    ['first signer user', signerUserId], ['second signer user', secondSignerUserId],
    ['certificate being replaced', replacesCertificateId]
  ]) {
    if (val && !UUID.test(String(val))) throw Object.assign(new Error(`Select a valid ${label}.`), { status: 400 });
  }

  const out = {
    learner_id: learnerId, category, title, achievement_statement: statement,
    academic_year_id: academicYearId, term_id: termId,
    subject_or_activity: subjectOrActivity || null, achievement_date: achievementDate,
    signer_name: signerName || null, signer_title: signerTitle || null,
    second_signer_name: secondSignerName || null, second_signer_title: secondSignerTitle || null,
    replaces_certificate_id: replacesCertificateId
  };
  if (assessmentId) out.assessment_id = assessmentId;
  if (subjectId) out.subject_id = subjectId;
  if (signerUserId) out.signer_user_id = signerUserId;
  if (secondSignerUserId) out.second_signer_user_id = secondSignerUserId;
  if (body.metadata !== undefined) out.metadata = sanitizeMetadata(body.metadata);
  return out;
}

function validateIdCardOptions(queryOrBody = {}) {
  const validFrom = validIsoDate(queryOrBody.valid_from, 'card start date');
  const validUntil = validIsoDate(queryOrBody.valid_until, 'card expiry date');
  if (validFrom && validUntil && validUntil < validFrom) {
    throw Object.assign(new Error('Card expiry date must be on or after the start date.'), { status: 400 });
  }
  return { valid_from: validFrom, valid_until: validUntil };
}

function assertCertificateTransition(current, next) {
  if (!TRANSITIONS[next]?.has(current)) {
    throw Object.assign(new Error(`A certificate cannot move from ${current} to ${next}.`), { status: 409 });
  }
}

module.exports = {
  validateCertificateDraft,
  validateIdCardOptions,
  assertCertificateTransition
};
