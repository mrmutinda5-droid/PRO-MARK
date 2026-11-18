'use strict';

const express = require('express');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const { ZipArchive } = require('archiver');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('../db');
const { authenticate, roles, schoolBoundary } = require('../middleware/auth');
const {
  documentTemplate, documentTemplates, validDocumentCategory,
  getCertificateCategory, renderCustomStatement
} = require('../services/document-templates');
const {
  randomDocumentToken, documentTokenHash, encryptDocumentToken,
  decryptDocumentToken, getActiveEncryptionKey
} = require('../services/document-security');
const {
  storeSnapshotAsset, loadSnapshotAssetBuffers, resolveRenderImage
} = require('../services/snapshot-assets');
const {
  validateCertificateDraft, validateIdCardOptions, assertCertificateTransition
} = require('../services/school-certificates');

const router = express.Router();
const VIEW = ['SCHOOL_ADMIN', 'ADMIN', 'HEADTEACHER', 'DEPUTY_HEADTEACHER', 'SENIOR_TEACHER'];
const WRITE = ['SCHOOL_ADMIN', 'ADMIN', 'HEADTEACHER', 'DEPUTY_HEADTEACHER'];
const ISSUE = ['SCHOOL_ADMIN', 'ADMIN', 'HEADTEACHER'];
const certificateNumber = /^ZAC-\d{4}-[A-F0-9]{24}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = (value, max = 250) => String(value ?? '').trim().slice(0, max);
const safeColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
const CARD_WIDTH = 85.6 * 72 / 25.4;
const CARD_HEIGHT = 53.98 * 72 / 25.4;

function verificationUrl(req, pagePath, token) {
  const base = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
  const origin = new URL(base);
  if (!['http:', 'https:'].includes(origin.protocol)) throw Error('PUBLIC_APP_URL must use HTTP or HTTPS.');
  const url = new URL(pagePath, origin);
  url.searchParams.set('token', token);
  return url.toString();
}

async function getSchoolCategorySet(schoolId) {
  try {
    const q = await db.query(
      `SELECT upper(code) code FROM school_document_categories
       WHERE is_active = true AND (school_id IS NULL OR school_id = $1)`,
      [schoolId]
    );
    return new Set(q.rows.map(r => r.code));
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

async function loadOptionalLearnerProfile(clientOrDb, schoolId, learnerId) {
  try {
    const q = await clientOrDb.query(
      `SELECT residence_type, emergency_phone, guardian_alt_phone
       FROM learner_admission_profiles
       WHERE school_id = $1 AND learner_id = $2 LIMIT 1`,
      [schoolId, learnerId]
    );
    return q.rows[0] || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

async function loadCertificateIssueSnapshot(client, schoolId, certificateId, issuerId, issuerRole, template) {
  const row = (await client.query(`
    SELECT c.*,
      l.admission_no, l.assessment_no, l.first_name, l.middle_name, l.last_name,
      COALESCE(le.class_id, l.class_id) resolved_class_id, cl.name class_name, cl.stream,
      ay.year_label, t.term_no, t.name term_name,
      s.name school_name, s.code school_code,
      si.logo_url, si.motto, si.address, si.contact_phone, si.contact_email,
      si.primary_color, si.secondary_color,
      s1.first_name s1_first, s1.last_name s1_last, t1.signature_url s1_signature_url,
      s2.first_name s2_first, s2.last_name s2_last, t2.signature_url s2_signature_url,
      (SELECT file_url FROM school_document_assets a
       WHERE a.school_id = c.school_id AND a.asset_type = 'STAMP' AND a.is_active = true
         AND a.effective_from <= CURRENT_DATE AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE)
       ORDER BY a.effective_from DESC, a.created_at DESC LIMIT 1) stamp_url
    FROM school_academic_certificates c
    JOIN learners l ON l.id = c.learner_id AND l.school_id = c.school_id
    LEFT JOIN learner_enrollments le ON le.school_id = c.school_id AND le.learner_id = l.id
      AND le.academic_year_id = c.academic_year_id AND COALESCE(le.status, 'ACTIVE') IN ('ACTIVE', 'COMPLETED')
    LEFT JOIN classes cl ON cl.id = COALESCE(le.class_id, l.class_id) AND cl.school_id = c.school_id
    LEFT JOIN academic_years ay ON ay.id = c.academic_year_id AND ay.school_id = c.school_id
    LEFT JOIN terms t ON t.id = c.term_id AND t.school_id = c.school_id
    JOIN schools s ON s.id = c.school_id
    LEFT JOIN school_identity si ON si.school_id = c.school_id
    LEFT JOIN users s1 ON s1.id = COALESCE(c.signer_user_id, $3)
    LEFT JOIN teachers t1 ON t1.user_id = COALESCE(c.signer_user_id, $3) AND t1.school_id = c.school_id AND COALESCE(t1.is_active, true) = true
    LEFT JOIN users s2 ON s2.id = c.second_signer_user_id
    LEFT JOIN teachers t2 ON t2.user_id = c.second_signer_user_id AND t2.school_id = c.school_id AND COALESCE(t2.is_active, true) = true
    WHERE c.school_id = $1 AND c.id = $2
  `, [schoolId, certificateId, issuerId])).rows[0];

  if (!row) throw Error('Certificate details could not be loaded for issue snapshot.');
  row.class_id = row.resolved_class_id;
  row.signer_name = row.signer_name || [row.s1_first, row.s1_last].filter(Boolean).join(' ') || 'Authorised school officer';
  row.signer_title = row.signer_title || String(issuerRole || 'Authorised school officer').replaceAll('_', ' ');
  if (!row.second_signer_name && (row.s2_first || row.s2_last)) {
    row.second_signer_name = [row.s2_first, row.s2_last].filter(Boolean).join(' ');
  }

  row.logo_asset_id = await storeSnapshotAsset(client, schoolId, row.logo_url);
  row.stamp_asset_id = await storeSnapshotAsset(client, schoolId, row.stamp_url);
  row.issuer_signature_asset_id = await storeSnapshotAsset(client, schoolId, row.s1_signature_url);
  row.second_signature_asset_id = await storeSnapshotAsset(client, schoolId, row.s2_signature_url);

  delete row.logo_url;
  delete row.stamp_url;
  delete row.s1_signature_url;
  delete row.s2_signature_url;
  delete row.s1_first;
  delete row.s1_last;
  delete row.s2_first;
  delete row.s2_last;
  row.template_id = template;
  return row;
}

async function validateCertificateReplacement(client, schoolId, replacesId, currentId = null) {
  if (!replacesId) return;
  const original = (await client.query(
    `SELECT status FROM school_academic_certificates WHERE school_id = $1 AND id = $2 FOR UPDATE`,
    [schoolId, replacesId]
  )).rows[0];
  if (!original) throw Object.assign(new Error('The certificate being replaced was not found in this school.'), { status: 400 });
  if (original.status !== 'REVOKED') throw Object.assign(new Error('Only a revoked certificate can be replaced.'), { status: 409 });
  const prior = (await client.query(
    `SELECT id FROM school_academic_certificates
     WHERE school_id = $1 AND replaces_certificate_id = $2
       AND id <> COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [schoolId, replacesId, currentId]
  )).rows[0];
  if (prior) throw Object.assign(new Error('A replacement certificate already exists for this reference.'), { status: 409 });
}

async function buildHolderCardSnapshot(client, schoolId, holder, cardType, options = {}) {
  const logoAssetId = await storeSnapshotAsset(client, schoolId, holder.logo_url);
  const stampAssetId = await storeSnapshotAsset(client, schoolId, holder.stamp_url);
  const photoAssetId = await storeSnapshotAsset(client, schoolId, holder.passport_photo_url || holder.photo_url);
  const principalSigAssetId = await storeSnapshotAsset(client, schoolId, holder.principal_signature_url);

  return {
    card_type: cardType,
    school_name: holder.school_name,
    school_code: holder.school_code,
    motto: holder.motto,
    primary_color: holder.primary_color,
    secondary_color: holder.secondary_color,
    address: holder.address,
    contact_phone: holder.contact_phone,
    logo_asset_id: logoAssetId,
    stamp_asset_id: stampAssetId,
    photo_asset_id: photoAssetId,
    principal_signature_asset_id: principalSigAssetId,
    learner_id: cardType === 'LEARNER' ? holder.id : null,
    teacher_id: cardType === 'STAFF' ? holder.id : null,
    admission_no: holder.admission_no || null,
    staff_no: holder.staff_no || null,
    assessment_no: holder.assessment_no || null,
    first_name: holder.first_name,
    middle_name: holder.middle_name || null,
    last_name: holder.last_name,
    class_name: holder.class_name || null,
    stream: holder.stream || null,
    department: holder.department || null,
    residence_type: holder.residence_type || null,
    emergency_phone: holder.emergency_phone || holder.parent_phone || null,
    year_label: holder.year_label || null,
    valid_from: options.valid_from || null,
    valid_until: options.valid_until || null
  };
}

async function issueOrReprintIdCard(req, holder, cardType, template, academicYearId, replaceActive = false, clientOverride = null, replaceReason = null, options = {}) {
  const sid = req.params.schoolId;
  const client = clientOverride || await db.pool.connect();
  const ownsClient = !clientOverride;
  const holderCol = cardType === 'STAFF' ? 'teacher_id' : 'learner_id';
  try {
    if (ownsClient) await client.query('BEGIN');
    const active = await client.query(
      `SELECT * FROM school_learner_cards
       WHERE school_id = $1 AND ${holderCol} = $2 AND status = 'ACTIVE' FOR UPDATE`,
      [sid, holder.id]
    );
    let card, token, action, previousCardId = null, cardSnapshot;
    if (active.rowCount && !replaceActive) {
      card = active.rows[0];
      token = decryptDocumentToken(card.verification_token_ciphertext);
      cardSnapshot = card.snapshot;
      action = cardType === 'STAFF' ? 'STAFF_ID_CARD_REPRINTED' : 'LEARNER_ID_CARD_REPRINTED';
    } else {
      const snapObj = await buildHolderCardSnapshot(client, sid, holder, cardType, options);
      const snapshot = JSON.stringify(snapObj);
      if (active.rowCount) {
        previousCardId = active.rows[0].id;
        await client.query(`UPDATE school_learner_cards SET status = 'REPLACED', updated_at = now() WHERE school_id = $1 AND id = $2`, [sid, previousCardId]);
      }
      token = randomDocumentToken();
      const { version } = getActiveEncryptionKey();
      const year = (String(holder.year_label || new Date().getUTCFullYear()).match(/\d{4}/) || [])[0] || String(new Date().getUTCFullYear());
      const prefix = cardType === 'STAFF' ? 'ZSID' : 'ZID';
      const reference = `${prefix}-${year}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      card = (await client.query(
        `INSERT INTO school_learner_cards
          (school_id, card_type, learner_id, teacher_id, academic_year_id, card_reference,
           verification_token_hash, verification_token_ciphertext, key_version,
           template_id, valid_from, valid_until, snapshot, issued_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
         RETURNING *`,
        [
          sid, cardType,
          cardType === 'LEARNER' ? holder.id : null,
          cardType === 'STAFF' ? holder.id : null,
          academicYearId, reference,
          documentTokenHash(token), encryptDocumentToken(token), version,
          template, options.valid_from || null, options.valid_until || null,
          snapshot, req.user.user_id
        ]
      )).rows[0];
      cardSnapshot = card.snapshot;
      if (previousCardId) {
        await client.query(`UPDATE school_learner_cards SET replaced_by = $3 WHERE school_id = $1 AND id = $2`, [sid, previousCardId, card.id]);
        action = cardType === 'STAFF' ? 'STAFF_ID_CARD_REPLACED' : 'LEARNER_ID_CARD_REPLACED';
      } else {
        action = cardType === 'STAFF' ? 'STAFF_ID_CARD_ISSUED' : 'LEARNER_ID_CARD_ISSUED';
      }
    }
    await client.query(
      `INSERT INTO audit_log(school_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, 'school_learner_card', $4, $5::jsonb)`,
      [sid, req.user.user_id, action, card.id, JSON.stringify({ card_reference: card.card_reference, card_type: cardType, holder_id: holder.id, template_id: template, reason: replaceReason })]
    );
    if (ownsClient) await client.query('COMMIT');
    return { card, token, snapshot: cardSnapshot };
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

async function loadSchoolCardExtras(schoolId) {
  const [stampRes, sigRes] = await Promise.all([
    db.query(
      `SELECT file_url FROM school_document_assets
       WHERE school_id = $1 AND asset_type = 'STAMP' AND is_active = true
         AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
      [schoolId]
    ),
    db.query(
      `SELECT t.signature_url FROM teachers t
       JOIN user_school_roles r ON r.user_id = t.user_id AND r.school_id = t.school_id
       WHERE t.school_id = $1 AND COALESCE(t.is_active, true) = true AND t.signature_url IS NOT NULL
         AND r.role IN ('HEADTEACHER', 'SCHOOL_ADMIN', 'ADMIN')
       ORDER BY CASE r.role WHEN 'HEADTEACHER' THEN 0 ELSE 1 END, t.updated_at DESC NULLS LAST LIMIT 1`,
      [schoolId]
    ).catch(() => ({ rows: [] }))
  ]);
  return {
    stamp_url: stampRes.rows[0]?.file_url || null,
    principal_signature_url: sigRes.rows[0]?.signature_url || null
  };
}

async function loadLearnerForCard(schoolId, learnerId, academicYearId, yearLabel) {
  const row = (await db.query(`
    SELECT l.id, l.admission_no, l.assessment_no, l.first_name, l.middle_name, l.last_name,
      l.passport_photo_url, to_jsonb(l)->>'parent_phone' AS parent_phone,
      cl.name class_name, cl.stream,
      s.name school_name, s.code school_code,
      si.logo_url, si.motto, si.primary_color, si.secondary_color, si.address, si.contact_phone,
      $3::text year_label
    FROM learners l
    JOIN schools s ON s.id = l.school_id
    LEFT JOIN learner_enrollments le ON le.school_id = l.school_id AND le.learner_id = l.id
      AND le.academic_year_id = $4 AND COALESCE(le.status, 'ACTIVE') IN ('ACTIVE', 'COMPLETED')
    LEFT JOIN classes cl ON cl.id = COALESCE(le.class_id, l.class_id) AND cl.school_id = l.school_id
    LEFT JOIN school_identity si ON si.school_id = l.school_id
    WHERE l.school_id = $1 AND l.id = $2 AND COALESCE(l.is_active, true) = true
  `, [schoolId, learnerId, yearLabel, academicYearId])).rows[0];
  if (!row) return null;
  const [profile, extras] = await Promise.all([
    loadOptionalLearnerProfile(db, schoolId, learnerId),
    loadSchoolCardExtras(schoolId)
  ]);
  return {
    ...row,
    residence_type: profile?.residence_type || null,
    emergency_phone: profile?.emergency_phone || profile?.guardian_alt_phone || row.parent_phone || null,
    ...extras
  };
}

async function loadStaffForCard(schoolId, teacherId, yearLabel) {
  const row = (await db.query(`
    SELECT th.id, to_jsonb(th)->>'staff_no' AS staff_no,
      th.first_name, to_jsonb(th)->>'middle_name' AS middle_name, th.last_name,
      to_jsonb(th)->>'photo_url' AS photo_url, th.phone, th.signature_url,
      COALESCE(r.role::text, to_jsonb(th)->>'imported_role', 'TEACHER') AS department,
      s.name school_name, s.code school_code,
      si.logo_url, si.motto, si.primary_color, si.secondary_color, si.address, si.contact_phone,
      $3::text year_label
    FROM teachers th
    JOIN schools s ON s.id = th.school_id
    LEFT JOIN user_school_roles r ON r.user_id = th.user_id AND r.school_id = th.school_id
    LEFT JOIN school_identity si ON si.school_id = th.school_id
    WHERE th.school_id = $1 AND th.id = $2 AND COALESCE(th.is_active, true) = true
  `, [schoolId, teacherId, yearLabel])).rows[0];
  if (!row) return null;
  const extras = await loadSchoolCardExtras(schoolId);
  return {
    ...row,
    department: String(row.department || 'TEACHER').replaceAll('_', ' '),
    emergency_phone: row.phone || row.contact_phone || null,
    ...extras
  };
}

async function hydrateRenderAssets(schoolId, obj) {
  const ids = [
    obj.logo_asset_id, obj.stamp_asset_id, obj.photo_asset_id,
    obj.issuer_signature_asset_id, obj.second_signature_asset_id, obj.principal_signature_asset_id
  ].filter(Boolean);
  const map = ids.length ? await loadSnapshotAssetBuffers(db, schoolId, ids) : new Map();
  return {
    logoBuf: resolveRenderImage(map, obj.logo_asset_id, obj.logo_url),
    stampBuf: resolveRenderImage(map, obj.stamp_asset_id, obj.stamp_url),
    photoBuf: resolveRenderImage(map, obj.photo_asset_id, obj.passport_photo_url || obj.photo_url),
    sig1Buf: resolveRenderImage(map, obj.issuer_signature_asset_id, obj.issuer_signature_url),
    sig2Buf: resolveRenderImage(map, obj.second_signature_asset_id, obj.second_signer_signature_url),
    principalSigBuf: resolveRenderImage(map, obj.principal_signature_asset_id, obj.principal_signature_url)
  };
}

function drawLogoBuffer(pdf, buf, x, y, width, height) {
  if (buf) { try { pdf.image(buf, x, y, { fit: [width, height], align: 'center', valign: 'center' }); } catch {} }
}

function drawCertificateStatement(pdf, row, x, y, width) {
  const text = String(row.achievement_statement || '');
  let fontSize = 12;
  while (fontSize > 8 && pdf.heightOfString(text, { width, font: 'Helvetica', fontSize, lineGap: 3 }) > 88) fontSize--;
  const height = pdf.heightOfString(text, { width, font: 'Helvetica', fontSize, lineGap: 3 });
  pdf.fillColor('#334155').font('Helvetica').fontSize(fontSize).text(text, x, y, { width, align: 'center', lineGap: 3 });
  return y + height;
}

function drawLeavingDetailsBox(pdf, leaving, x, y, width, primary, accent) {
  if (!leaving || typeof leaving !== 'object') return y;
  const parts = [
    leaving.last_class ? `Last Class: ${leaving.last_class}` : null,
    leaving.admission_date ? `Admitted: ${leaving.admission_date}` : null,
    leaving.leaving_date ? `Left: ${leaving.leaving_date}` : null,
    leaving.kcpe_or_kpsea_index ? `KPSEA/KCPE Index: ${leaving.kcpe_or_kpsea_index}` : null,
    leaving.conduct_remark ? `Conduct: ${leaving.conduct_remark}` : null,
    leaving.reason_for_leaving ? `Reason: ${leaving.reason_for_leaving}` : null
  ].filter(Boolean);
  if (!parts.length) return y;
  pdf.roundedRect(x, y, width, 40, 6).fill('#f8fafc').lineWidth(0.8).strokeColor(accent).stroke();
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(8.5)
    .text(parts.slice(0, 3).join('   ·   '), x + 10, y + 8, { width: width - 20, align: 'center', lineBreak: false, ellipsis: true });
  if (parts.length > 3) {
    pdf.fillColor('#334155').font('Helvetica').fontSize(8)
      .text(parts.slice(3).join('   ·   '), x + 10, y + 23, { width: width - 20, align: 'center', lineBreak: false, ellipsis: true });
  }
  return y + 48;
}

function renderCertificate(pdf, row, template, assets = {}) {
  const fallbackPrimary = template === 'sports-achievement' ? '#166534' : template === 'subject-champion' ? '#1456a0' : template === 'participation' ? '#583556' : '#071f49';
  const primary = safeColor(row.primary_color, fallbackPrimary);
  const accent = safeColor(row.secondary_color, '#d4a52c');
  const schoolDetails = [row.motto, row.address, row.contact_phone, row.contact_email].filter(Boolean).join(' · ');
  const learner = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ');
  const idText = [
    `Admission no: ${row.admission_no || 'Not assigned'}`,
    row.assessment_no ? `UPI / Assessment no: ${row.assessment_no}` : null
  ].filter(Boolean).join('  ·  ');
  const context = [
    row.year_label,
    row.term_no ? `Term ${row.term_no}` : row.term_name,
    [row.class_name, row.stream].filter(Boolean).join(' '),
    row.achievement_date ? `Date: ${String(row.achievement_date).slice(0, 10)}` : null
  ].filter(Boolean).join(' · ');
  const draftLabel = row.status === 'DRAFT' ? 'DRAFT PREVIEW' : row.status === 'REVOKED' ? 'REVOKED' : `Issued: ${String(row.issued_on || '').slice(0, 10)}`;
  const issuer = row.signer_name || (row.issuer_first_name ? [row.issuer_first_name, row.issuer_last_name].filter(Boolean).join(' ') : 'Authorised school officer');

  pdf.rect(0, 0, 842, 595).fill('#ffffff');

  if (assets.logoBuf) {
    try {
      pdf.save().opacity(0.06);
      pdf.image(assets.logoBuf, 321, 198, { fit: [200, 200], align: 'center', valign: 'center' });
      pdf.restore();
    } catch {}
  }

  let contentY = 390;
  if (template === 'classic') {
    pdf.rect(18, 18, 806, 559).lineWidth(3).strokeColor(primary).stroke();
    pdf.rect(27, 27, 788, 541).lineWidth(1).strokeColor(accent).stroke();
    pdf.rect(36, 36, 770, 523).lineWidth(0.5).strokeColor(primary).stroke();
    [[38, 38, 1, 1], [804, 38, -1, 1], [38, 557, 1, -1], [804, 557, -1, -1]].forEach(([x, y, sx, sy]) => {
      pdf.moveTo(x, y + 24 * sy).lineTo(x, y).lineTo(x + 24 * sx, y).lineWidth(3).strokeColor(accent).stroke();
    });
    drawLogoBuffer(pdf, assets.logoBuf, 394, 45, 54, 54);
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(18).text(String(row.school_name || ''), 76, 108, { width: 690, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(schoolDetails, 76, 130, { width: 690, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(10).text(String(row.category || 'ACADEMIC_ACHIEVEMENT').replaceAll('_', ' '), 80, 158, { width: 682, align: 'center', lineBreak: false });
    pdf.fillColor(primary).font('Times-Bold').fontSize(28).text(String(row.title || ''), 80, 186, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('This certificate is proudly presented to', 80, 232, { width: 682, align: 'center' });
    pdf.fillColor(primary).font('Times-Italic').fontSize(28).text(learner, 80, 260, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(idText, 80, 294, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.moveTo(240, 312).lineTo(602, 312).lineWidth(1).strokeColor(accent).stroke();
    contentY = drawCertificateStatement(pdf, row, 105, 326, 632);
    contentY = drawLeavingDetailsBox(pdf, row.metadata?.leaving_details, 110, contentY + 8, 622, primary, accent);
  } else if (template === 'modern') {
    pdf.rect(0, 0, 166, 595).fill(primary);
    pdf.rect(157, 0, 9, 595).fill(accent);
    pdf.circle(83, 78, 30).lineWidth(1.5).strokeColor('#ffffff').stroke();
    drawLogoBuffer(pdf, assets.logoBuf, 59, 54, 48, 48);
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(String(row.school_name || ''), 20, 133, { width: 126, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#e2e8f0').font('Helvetica').fontSize(8).text(String(row.school_code || 'SCHOOL'), 20, 153, { width: 126, align: 'center' });
    pdf.fillColor('#ffffff').font('Helvetica').fontSize(7).text('LEARN · LEAD · ACHIEVE', 18, 548, { width: 130, align: 'center' });
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(10).text(String(row.category || 'ACADEMIC_ACHIEVEMENT').replaceAll('_', ' '), 207, 84, { width: 588, align: 'left', lineBreak: false, ellipsis: true });
    pdf.fillColor('#17365d').font('Helvetica-Bold').fontSize(29).text(String(row.title || ''), 207, 114, { width: 588, align: 'left', lineBreak: false, ellipsis: true });
    pdf.moveTo(207, 156).lineTo(794, 156).lineWidth(1).strokeColor('#dce5ec').stroke();
    pdf.fillColor('#526176').font('Helvetica').fontSize(12).text('Presented to', 207, 182);
    pdf.fillColor(primary).font('Times-Italic').fontSize(28).text(learner, 207, 208, { width: 588, align: 'left', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(idText, 207, 242, { width: 588, align: 'left', lineBreak: false, ellipsis: true });
    pdf.moveTo(207, 262).lineTo(515, 262).lineWidth(2).strokeColor(accent).stroke();
    contentY = drawCertificateStatement(pdf, row, 207, 278, 585);
    contentY = drawLeavingDetailsBox(pdf, row.metadata?.leaving_details, 207, contentY + 8, 585, primary, accent);
  } else if (template === 'subject-champion') {
    pdf.rect(18, 18, 806, 559).lineWidth(3).strokeColor(primary).stroke();
    pdf.rect(18, 18, 806, 66).fill(primary);
    pdf.circle(421, 122, 31).fill(accent);
    pdf.circle(421, 122, 23).lineWidth(2).strokeColor('#fff').stroke();
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text('1', 409, 113, { width: 24, align: 'center' });
    drawLogoBuffer(pdf, assets.logoBuf, 394, 35, 54, 38);
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(String(row.school_name || ''), 76, 45, { width: 690, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(11).text('CERTIFICATE OF SUBJECT CHAMPION', 80, 171, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('Awarded to', 80, 204, { width: 682, align: 'center' });
    pdf.fillColor(primary).font('Times-Bold').fontSize(30).text(learner, 80, 229, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(idText, 80, 260, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    const subject = String(row.subject_or_activity || row.subject_name || 'Academic subject');
    pdf.roundedRect(242, 276, 358, 35, 8).fill('#fff6dc').strokeColor(accent).stroke();
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(14).text(subject, 252, 286, { width: 338, align: 'center', lineBreak: false, ellipsis: true });
    contentY = drawCertificateStatement(pdf, row, 105, 326, 632);
    contentY = drawLeavingDetailsBox(pdf, row.metadata?.leaving_details, 110, contentY + 8, 622, primary, accent);
  } else if (template === 'most-improved') {
    pdf.rect(18, 18, 806, 559).lineWidth(3).strokeColor(primary).stroke();
    pdf.rect(28, 28, 786, 539).lineWidth(1).strokeColor(accent).stroke();
    pdf.circle(421, 83, 29).fill(accent);
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI / 2 + i * 2 * Math.PI / 5, inner = 12, outer = 23;
      const x1 = 421 + Math.cos(angle) * outer, y1 = 83 + Math.sin(angle) * outer;
      const x2 = 421 + Math.cos(angle + Math.PI / 5) * inner, y2 = 83 + Math.sin(angle + Math.PI / 5) * inner;
      if (i === 0) pdf.moveTo(x1, y1); else pdf.lineTo(x1, y1); pdf.lineTo(x2, y2);
    }
    pdf.closePath().fill('#fff');
    drawLogoBuffer(pdf, assets.logoBuf, 394, 38, 54, 54);
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(17).text(String(row.school_name || ''), 76, 116, { width: 690, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(11).text('MOST IMPROVED LEARNER', 80, 166, { width: 682, align: 'center', lineBreak: false });
    pdf.fillColor(primary).font('Times-Bold').fontSize(29).text(learner, 80, 205, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(idText, 80, 238, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    contentY = drawCertificateStatement(pdf, row, 105, 256, 632);
    contentY = drawLeavingDetailsBox(pdf, row.metadata?.leaving_details, 110, contentY + 8, 622, primary, accent);
  } else if (template === 'sports-achievement') {
    pdf.rect(0, 0, 842, 595).fill('#fff');
    pdf.rect(18, 18, 806, 559).lineWidth(3).strokeColor(primary).stroke();
    pdf.rect(18, 18, 806, 64).fill(primary);
    pdf.circle(421, 127, 30).fill(accent);
    pdf.rect(412, 119, 18, 22).fill('#fff'); pdf.rect(404, 115, 8, 7).fill('#fff'); pdf.rect(430, 115, 8, 7).fill('#fff');
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(String(row.school_name || ''), 76, 42, { width: 690, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(12).text('SPORTS ACHIEVEMENT', 80, 178, { width: 682, align: 'center', lineBreak: false });
    pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('This award is presented to', 80, 212, { width: 682, align: 'center' });
    pdf.fillColor(primary).font('Times-Bold').fontSize(30).text(learner, 80, 238, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(idText, 80, 270, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    const activity = String(row.subject_or_activity || row.subject_name || 'Sport or activity');
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(14).text(activity, 80, 289, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    contentY = drawCertificateStatement(pdf, row, 105, 321, 632);
    contentY = drawLeavingDetailsBox(pdf, row.metadata?.leaving_details, 110, contentY + 8, 622, primary, accent);
  } else if (template === 'participation') {
    pdf.rect(18, 18, 806, 559).lineWidth(2).strokeColor(primary).stroke();
    pdf.rect(26, 26, 790, 543).lineWidth(1).strokeColor(accent).stroke();
    pdf.polygon([18, 18], [82, 18], [18, 82]).fill(primary);
    pdf.polygon([824, 18], [760, 18], [824, 82]).fill(accent);
    pdf.polygon([18, 577], [82, 577], [18, 513]).fill(accent);
    pdf.polygon([824, 577], [760, 577], [824, 513]).fill(primary);
    drawLogoBuffer(pdf, assets.logoBuf, 394, 49, 54, 54);
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(17).text(String(row.school_name || ''), 76, 116, { width: 690, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor(primary).font('Times-Bold').fontSize(26).text('CERTIFICATE OF PARTICIPATION', 80, 177, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('Presented to', 80, 220, { width: 682, align: 'center' });
    pdf.fillColor(primary).font('Times-Italic').fontSize(29).text(learner, 80, 247, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(idText, 80, 279, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(13).text(String(row.subject_or_activity || 'Co-curricular participation'), 80, 296, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    contentY = drawCertificateStatement(pdf, row, 105, 324, 632);
    contentY = drawLeavingDetailsBox(pdf, row.metadata?.leaving_details, 110, contentY + 8, 622, primary, accent);
  } else {
    pdf.rect(18, 18, 806, 559).lineWidth(2).strokeColor(primary).stroke();
    pdf.rect(27, 27, 788, 541).lineWidth(1).strokeColor(accent).stroke();
    pdf.rect(18, 18, 806, 13).fill(primary);
    pdf.rect(18, 564, 806, 13).fill(primary);
    drawLogoBuffer(pdf, assets.logoBuf, 394, 48, 54, 54);
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(18).text(String(row.school_name || ''), 76, 111, { width: 690, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(schoolDetails, 76, 133, { width: 690, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(10).text(String(row.category || 'ACADEMIC_ACHIEVEMENT').replaceAll('_', ' '), 80, 157, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor(primary).font('Times-Bold').fontSize(27).text(String(row.title || ''), 80, 186, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('is proudly presented to', 80, 232, { width: 682, align: 'center' });
    pdf.fillColor(primary).font('Times-Italic').fontSize(28).text(learner, 80, 260, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(idText, 80, 294, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
    pdf.moveTo(165, 314).lineTo(677, 314).lineWidth(0.8).strokeColor(accent).stroke();
    contentY = drawCertificateStatement(pdf, row, 105, 326, 632);
    contentY = drawLeavingDetailsBox(pdf, row.metadata?.leaving_details, 110, contentY + 8, 622, primary, accent);
  }

  if (context) {
    pdf.fillColor('#52647a').font('Helvetica').fontSize(9).text(context, 90, Math.min(Math.max(contentY + 8, 444), 456), { width: 662, align: 'center', lineBreak: false, ellipsis: true });
  }
  pdf.fillColor('#52647a').font('Helvetica').fontSize(8).text(`${draftLabel}  ·  Reference: ${row.certificate_no}`, 90, 469, { width: 662, align: 'center', lineBreak: false, ellipsis: true });

  pdf.moveTo(83, 520).lineTo(269, 520).lineWidth(0.8).strokeColor('#94a3b8').stroke();
  if (assets.sig1Buf) { try { pdf.image(assets.sig1Buf, 116, 487, { fit: [120, 30], align: 'center', valign: 'center' }); } catch {} }
  pdf.fillColor('#334155').font('Helvetica').fontSize(9).text(String(issuer), 83, 528, { width: 186, align: 'center', lineBreak: false, ellipsis: true });
  if (row.signer_title) pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text(String(row.signer_title), 83, 541, { width: 186, align: 'center', lineBreak: false, ellipsis: true });

  pdf.moveTo(328, 520).lineTo(514, 520).lineWidth(0.8).strokeColor('#94a3b8').stroke();
  if (assets.sig2Buf) { try { pdf.image(assets.sig2Buf, 361, 487, { fit: [120, 30], align: 'center', valign: 'center' }); } catch {} }
  pdf.fillColor('#334155').font('Helvetica').fontSize(9).text(String(row.second_signer_name || 'Second authorised signatory'), 328, 528, { width: 186, align: 'center', lineBreak: false, ellipsis: true });
  if (row.second_signer_title) pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text(String(row.second_signer_title), 328, 541, { width: 186, align: 'center', lineBreak: false, ellipsis: true });

  if (assets.stampBuf) { try { pdf.image(assets.stampBuf, 634, 476, { fit: [66, 44], align: 'center', valign: 'center' }); } catch {} }
  pdf.moveTo(574, 520).lineTo(760, 520).lineWidth(0.8).strokeColor('#94a3b8').stroke();
  pdf.fillColor('#334155').font('Helvetica').fontSize(9).text('Official school stamp', 574, 528, { width: 186, align: 'center' });
  const verifyInstruction = row.qrBuffer
    ? `Scan QR or verify reference ${row.certificate_no} and learner admission number.`
    : `Verify with reference ${row.certificate_no} and learner admission number.`;
  pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text(verifyInstruction, 80, 560, { width: 682, align: 'center', lineBreak: false, ellipsis: true });
  if (row.qrBuffer) pdf.image(row.qrBuffer, 779, 510, { width: 42, height: 42 });

  if (row.status === 'DRAFT' || row.status === 'REVOKED') {
    pdf.save().rotate(-22, { origin: [421, 300] }).fillColor(row.status === 'DRAFT' ? '#64748b' : '#b91c1c').opacity(0.12).font('Helvetica-Bold').fontSize(64).text(row.status, { x: 180, y: 266, width: 480, align: 'center' }).restore();
  }
}

function renderIdCard(pdf, holder, template, card = {}, assets = {}, layoutOpts = {}) {
  const isStaff = holder.card_type === 'STAFF';
  const primary = safeColor(holder.primary_color, '#17365d');
  const accent = safeColor(holder.secondary_color, '#d9a441');
  const fullName = [holder.first_name, holder.middle_name, holder.last_name].filter(Boolean).join(' ');
  const idLabel = isStaff ? 'STAFF NO.' : 'ADM NO.';
  const idValue = String((isStaff ? holder.staff_no : holder.admission_no) || 'Not assigned');
  const upiText = !isStaff && holder.assessment_no && layoutOpts.show_upi !== false ? String(holder.assessment_no) : null;
  const classOrDept = isStaff ? String(holder.department || 'Staff') : String(holder.class_name || 'Not assigned');
  const streamOrStatus = isStaff
    ? (holder.year_label || 'ACTIVE')
    : ([holder.stream, layoutOpts.show_house !== false ? holder.residence_type : null].filter(Boolean).join(' · ') || '—');
  const validityText = (holder.valid_from || holder.valid_until) && layoutOpts.show_expiry !== false
    ? `VALID: ${holder.valid_from || '—'} to ${holder.valid_until || '—'}`
    : `${isStaff ? 'STAFF ID CARD' : 'STUDENT ID CARD'}${holder.year_label ? ' · ' + holder.year_label : ''}`;

  pdf.rect(0, 0, 340, 216).fill('#ffffff');
  pdf.roundedRect(4, 4, 332, 208, 10).lineWidth(1.5).strokeColor(primary).stroke();

  const headerH = template === 'modern' ? 48 : 52;
  pdf.roundedRect(4, 4, 332, headerH, 9).fill(primary);
  if (template === 'modern') pdf.rect(322, 4, 14, headerH).fill(accent);
  drawLogoBuffer(pdf, assets.logoBuf, 13, 10, 34, 34);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5).text(String(holder.school_name || ''), 52, 12, { width: 226, align: 'center', lineBreak: false, ellipsis: true });
  pdf.font('Helvetica').fontSize(6).text(String(holder.school_code || (isStaff ? 'OFFICIAL STAFF ID' : 'OFFICIAL LEARNER ID')), 52, 26, { width: 226, align: 'center', lineBreak: false, ellipsis: true });
  pdf.font('Helvetica-Oblique').fontSize(6).text(String(holder.motto || (isStaff ? 'STAFF IDENTIFICATION' : 'STUDENT ID CARD')), 52, 37, { width: 226, align: 'center', lineBreak: false, ellipsis: true });

  if (card.qrBuffer) {
    pdf.image(card.qrBuffer, 292, 8, { width: 34, height: 34 });
    pdf.fillColor('#ffffff').font('Helvetica').fontSize(4).text(String(card.cardReference || 'VERIFY'), 288, 44, { width: 43, align: 'center', lineBreak: false, ellipsis: true });
  } else {
    pdf.roundedRect(284, 14, 46, 16, 4).fill(accent);
    pdf.fillColor('#111827').font('Helvetica-Bold').fontSize(6).text(isStaff ? 'STAFF' : 'LEARNER', 284, 19, { width: 46, align: 'center' });
  }

  const photoBg = template === 'academic' ? '#f1edf2' : '#eef2f7';
  pdf.roundedRect(18, 66, 78, 104, 5).fill(photoBg).strokeColor('#cbd5e1').stroke();
  if (assets.photoBuf) {
    try { pdf.image(assets.photoBuf, 21, 69, { cover: [72, 98], align: 'center', valign: 'center' }); } catch {}
  } else {
    pdf.fillColor('#64748b').font('Helvetica').fontSize(6.5).text('PHOTO NOT ON FILE', 20, 113, { width: 74, align: 'center' });
  }

  const dx = 108, dw = 214;
  pdf.fillColor(accent).font('Helvetica-Bold').fontSize(6).text(isStaff ? 'STAFF NAME' : 'LEARNER NAME', dx, 65);
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(9.5).text(fullName, dx, 74, { width: dw, height: 24, ellipsis: true });

  pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text(idLabel, dx, 102);
  pdf.fillColor('#111827').font('Helvetica-Bold').fontSize(8).text(idValue, dx, 110, { width: 105, lineBreak: false, ellipsis: true });
  if (upiText) {
    pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text('UPI / ASSESSMENT', dx + 110, 102);
    pdf.fillColor('#111827').font('Helvetica').fontSize(7.5).text(upiText, dx + 110, 110, { width: 104, lineBreak: false, ellipsis: true });
  }

  pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text(isStaff ? 'ROLE / DEPARTMENT' : 'CLASS / GRADE', dx, 128);
  pdf.fillColor('#111827').font('Helvetica').fontSize(8).text(classOrDept, dx, 136, { width: 112, lineBreak: false, ellipsis: true });

  pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text(isStaff ? 'ACADEMIC YEAR' : 'STREAM / STATUS', dx + 116, 128);
  pdf.fillColor('#111827').font('Helvetica').fontSize(7.5).text(streamOrStatus, dx + 116, 136, { width: 98, lineBreak: false, ellipsis: true });

  if (assets.principalSigBuf) {
    try { pdf.image(assets.principalSigBuf, 232, 156, { fit: [78, 22], align: 'center', valign: 'center' }); } catch {}
    pdf.fillColor('#64748b').font('Helvetica').fontSize(5).text('Principal Signature', 228, 179, { width: 86, align: 'center' });
  }

  const footerBg = template === 'classic' ? '#f3ead4' : template === 'modern' ? '#eff4f6' : '#f1edf2';
  const footerText = template === 'classic' ? '#73581f' : primary;
  pdf.rect(4, 190, 332, 22).fill(footerBg);
  pdf.fillColor(footerText).font('Helvetica-Bold').fontSize(6.5).text(validityText, 12, 197, { width: 316, align: 'center', lineBreak: false, ellipsis: true });
}

function renderIdCardBack(pdf, holder, card = {}, assets = {}, layoutOpts = {}) {
  const primary = safeColor(holder.primary_color, '#17365d');
  const accent = safeColor(holder.secondary_color, '#d9a441');
  pdf.rect(0, 0, 340, 216).fill('#ffffff');
  pdf.roundedRect(4, 4, 332, 208, 10).lineWidth(1.5).strokeColor(primary).stroke();
  pdf.roundedRect(4, 4, 332, 40, 9).fill(primary);
  drawLogoBuffer(pdf, assets.logoBuf, 13, 8, 28, 28);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5).text(String(holder.school_name || ''), 49, 11, { width: 270, align: 'center', lineBreak: false, ellipsis: true });
  pdf.fillColor('#e2e8f0').font('Helvetica').fontSize(6).text('IDENTITY VERIFICATION & EMERGENCY CONTACT', 49, 25, { width: 270, align: 'center' });

  if (card.qrBuffer) pdf.image(card.qrBuffer, 18, 56, { width: 68, height: 68 });
  if (assets.stampBuf) {
    try {
      pdf.save().opacity(0.28);
      pdf.image(assets.stampBuf, 260, 126, { fit: [62, 42], align: 'center', valign: 'center' });
      pdf.restore();
    } catch {}
  }

  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(6.5).text('IF FOUND, PLEASE RETURN THIS CARD TO', 98, 56, { width: 224, align: 'left' });
  pdf.fillColor('#334155').font('Helvetica').fontSize(7).text(String(holder.school_name || ''), 98, 68, { width: 224, lineBreak: false, ellipsis: true });
  if (holder.address) pdf.text(String(holder.address), 98, 79, { width: 224, lineBreak: false, ellipsis: true });
  if (holder.contact_phone) pdf.text(`School Office: ${holder.contact_phone}`, 98, 90, { width: 224, lineBreak: false, ellipsis: true });
  if (holder.emergency_phone && layoutOpts.show_emergency_phone !== false) {
    pdf.fillColor(primary).font('Helvetica-Bold').fontSize(6.5).text(`Emergency / Guardian: ${holder.emergency_phone}`, 98, 104, { width: 224, lineBreak: false, ellipsis: true });
  }

  pdf.roundedRect(98, 128, 156, 36, 5).fill('#f1f5f9');
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(6).text('CARD REFERENCE & VALIDITY', 105, 134);
  pdf.fillColor('#334155').font('Helvetica').fontSize(7).text(String(card.cardReference || 'Preview only'), 105, 144, { width: 142, lineBreak: false, ellipsis: true });
  if (holder.valid_until) {
    pdf.fillColor('#475569').font('Helvetica').fontSize(6).text(`Expires: ${holder.valid_until}`, 105, 154, { width: 142, lineBreak: false, ellipsis: true });
  }

  pdf.moveTo(18, 180).lineTo(322, 180).lineWidth(1).strokeColor(accent).stroke();
  pdf.fillColor('#64748b').font('Helvetica').fontSize(6).text('Scan the QR code to verify whether this card is active, expired, or revoked.', 18, 188, { width: 304, align: 'center', lineBreak: false, ellipsis: true });
}

function createIdCardPdf(holder, template, card = {}, side = 'front', assets = {}, layoutOpts = {}) {
  return new Promise((resolve, reject) => {
    const idStr = holder.admission_no || holder.staff_no || 'preview';
    const pdf = new PDFDocument({ size: [CARD_WIDTH, CARD_HEIGHT], margin: 0, info: { Title: `School ID ${idStr}`, Author: String(holder.school_name || 'ZELIMU CBC') } });
    const chunks = [];
    pdf.on('data', chunk => chunks.push(chunk));
    pdf.on('error', reject);
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.scale(CARD_WIDTH / 340);
    renderIdCard(pdf, holder, template, card, assets, layoutOpts);
    if (side === 'both') {
      pdf.addPage({ size: [CARD_WIDTH, CARD_HEIGHT], margin: 0 });
      pdf.scale(CARD_WIDTH / 340);
      renderIdCardBack(pdf, holder, card, assets, layoutOpts);
    }
    pdf.end();
  });
}

function createIdCardArchive(files) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 6 } }), chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    files.forEach(file => archive.append(file.buffer, { name: file.name }));
    archive.finalize().catch(reject);
  });
}

async function createCombinedIdCardPdf(files) {
  const combined = await PDFLibDocument.create();
  for (const file of files) {
    const source = await PDFLibDocument.load(file.buffer);
    const pages = await combined.copyPages(source, source.getPageIndices());
    pages.forEach(page => combined.addPage(page));
  }
  return Buffer.from(await combined.save());
}

async function loadIdCardLayoutOptions(schoolId) {
  try {
    const q = await db.query(
      `SELECT layout_options FROM school_document_template_preferences
       WHERE school_id = $1 AND document_type = 'ID_CARD' AND category = 'DEFAULT' LIMIT 1`,
      [schoolId]
    );
    return q.rows[0]?.layout_options || {};
  } catch {
    return {};
  }
}

async function buildBulkIdCards(req, format) {
  const learnerIds = req.body?.learner_ids;
  if (!Array.isArray(learnerIds) || learnerIds.length < 1 || learnerIds.length > 25 || learnerIds.some(id => !uuid.test(String(id))) || new Set(learnerIds).size !== learnerIds.length) {
    throw Object.assign(new Error('Select between 1 and 25 unique valid learners.'), { status: 400 });
  }
  const template = documentTemplate(req.body?.template_id, 'ID_CARD');
  if (!template) throw Object.assign(new Error('Select a supported ID card design.'), { status: 400 });
  const academicYearId = req.body?.academic_year_id || null;
  if (academicYearId && !uuid.test(academicYearId)) throw Object.assign(new Error('Invalid academic year.'), { status: 400 });
  const cardOptions = validateIdCardOptions(req.body || {});
  const side = req.body?.side === 'both' ? 'both' : 'front', issue = req.body?.issue !== false;
  let yearLabel = null, client = null;
  try {
    if (academicYearId) {
      yearLabel = (await db.query('SELECT year_label FROM academic_years WHERE school_id = $1 AND id = $2', [req.params.schoolId, academicYearId])).rows[0]?.year_label;
      if (!yearLabel) throw Object.assign(new Error('Academic year does not belong to this school.'), { status: 400 });
    }
    const learners = [];
    for (const learnerId of learnerIds) {
      const learner = await loadLearnerForCard(req.params.schoolId, learnerId, academicYearId, yearLabel);
      if (!learner) throw Object.assign(new Error('One or more selected learners are not active in this school.'), { status: 404 });
      learners.push(learner);
    }
    const layoutOpts = await loadIdCardLayoutOptions(req.params.schoolId);
    if (issue) { client = await db.pool.connect(); await client.query('BEGIN'); }
    const files = [];
    for (const learner of learners) {
      let card = { cardReference: 'PREVIEW' }, renderHolder = { ...learner, ...cardOptions, card_type: 'LEARNER' }, selectedTemplate = template;
      if (issue) {
        const issued = await issueOrReprintIdCard(req, learner, 'LEARNER', template, academicYearId, false, client, null, cardOptions);
        card = { cardReference: issued.card.card_reference };
        renderHolder = issued.snapshot;
        selectedTemplate = issued.card.template_id;
        card.qrBuffer = await QRCode.toBuffer(verificationUrl(req, '/verify-id-card.html', issued.token), { errorCorrectionLevel: 'M', margin: 1, width: 180 });
      }
      const assets = await hydrateRenderAssets(req.params.schoolId, renderHolder);
      const admission = clean(renderHolder.admission_no, 80).replace(/[^a-zA-Z0-9_-]/g, '-') || 'learner';
      files.push({
        name: `ID_${admission}${issue ? `_${card.cardReference}` : '_PREVIEW'}.pdf`,
        buffer: await createIdCardPdf(renderHolder, selectedTemplate, card, side, assets, layoutOpts)
      });
    }
    const output = format === 'zip' ? await createIdCardArchive(files) : await createCombinedIdCardPdf(files);
    if (issue) await client.query('COMMIT');
    if (client) { client.release(); client = null; }
    return output;
  } catch (error) {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); client = null; }
    throw error;
  }
}

router.get('/verify', async (req, res) => {
  try {
    const number = clean(req.query.certificate_no, 40).toUpperCase();
    const admission = clean(req.query.admission_no, 100);
    if (!certificateNumber.test(number) || !admission) return res.status(400).json({ error: 'Enter the certificate reference and learner admission number.' });
    const record = (await db.query(`
      SELECT c.certificate_no, c.title, c.issued_on, c.status, s.name school_name
      FROM school_academic_certificates c
      JOIN schools s ON s.id = c.school_id
      JOIN learners l ON l.id = c.learner_id AND l.school_id = c.school_id
      WHERE c.certificate_no = $1 AND upper(l.admission_no) = upper($2)
        AND c.status IN ('ISSUED', 'REVOKED')
    `, [number, admission])).rows[0];
    if (!record) return res.status(404).json({ valid: false, error: 'No matching issued certificate was found.' });
    res.json({ valid: record.status === 'ISSUED', status: record.status, certificate_no: record.certificate_no, title: record.title, issued_on: record.issued_on, school_name: record.school_name });
  } catch (error) {
    console.error('Verify academic certificate failed:', error);
    res.status(500).json({ error: 'Unable to verify this certificate right now.' });
  }
});

router.get('/verify-token', async (req, res) => {
  try {
    const token = clean(req.query.token, 100);
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return res.json({ valid: false, status: 'INVALID' });
    const record = (await db.query(`
      SELECT c.certificate_no, c.category, c.title, c.issued_on, c.issued_at, c.status,
        c.revocation_reason, c.subject_or_activity, c.achievement_date, c.snapshot,
        s.name school_name
      FROM school_academic_certificates c
      JOIN schools s ON s.id = c.school_id
      WHERE c.verification_token_hash = $1 AND c.status IN ('ISSUED', 'REVOKED')
    `, [documentTokenHash(token)])).rows[0];
    if (!record) return res.json({ valid: false, status: 'INVALID' });
    const snap = record.snapshot || {};
    const learnerName = [snap.first_name, snap.middle_name, snap.last_name].filter(Boolean).join(' ') || null;
    const signers = [snap.signer_name, snap.second_signer_name].filter(Boolean);
    res.json({
      valid: record.status === 'ISSUED',
      status: record.status,
      certificate_no: record.certificate_no,
      title: record.title,
      issued_on: record.issued_on,
      school_name: record.school_name,
      certificate: {
        status: record.status,
        school_name: snap.school_name || record.school_name,
        category: record.category,
        category_label: getCertificateCategory(record.category).label,
        title: record.title,
        learner_name: learnerName,
        admission_no: snap.admission_no || null,
        assessment_no: snap.assessment_no || null,
        subject_or_activity: record.subject_or_activity || snap.subject_or_activity || null,
        achievement_date: record.achievement_date || snap.achievement_date || null,
        leaving_details: snap.metadata?.leaving_details || null,
        signers,
        certificate_no: record.certificate_no,
        issued_at: record.issued_at,
        revocation_reason: record.revocation_reason || null
      }
    });
  } catch (error) {
    console.error('Verify academic certificate token failed:', error);
    res.status(500).json({ error: 'Unable to verify this certificate right now.' });
  }
});

router.get('/verify-id', async (req, res) => {
  try {
    const token = clean(req.query.token, 100);
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return res.json({ valid: false, status: 'INVALID' });
    const record = (await db.query(`
      SELECT c.card_reference, c.card_type, c.status, c.valid_from, c.valid_until,
        c.issued_at, c.revocation_reason, c.snapshot, s.name school_name,
        (c.valid_until IS NOT NULL AND c.valid_until < CURRENT_DATE) AS is_expired
      FROM school_learner_cards c
      JOIN schools s ON s.id = c.school_id
      WHERE c.verification_token_hash = $1
    `, [documentTokenHash(token)])).rows[0];
    if (!record) return res.json({ valid: false, status: 'INVALID' });
    const snap = record.snapshot || {};
    const effectiveStatus = (record.status === 'ACTIVE' && record.is_expired) ? 'EXPIRED' : record.status;
    const holderName = [snap.first_name, snap.middle_name, snap.last_name].filter(Boolean).join(' ') || null;
    res.json({
      valid: effectiveStatus === 'ACTIVE',
      status: effectiveStatus,
      is_expired: Boolean(record.is_expired),
      card_reference: record.card_reference,
      school_name: record.school_name,
      card: {
        status: effectiveStatus,
        is_expired: Boolean(record.is_expired),
        card_type: record.card_type || snap.card_type || 'LEARNER',
        school_name: snap.school_name || record.school_name,
        school_phone: snap.contact_phone || null,
        holder_name: holderName,
        learner_name: holderName,
        admission_no: snap.admission_no || null,
        staff_no: snap.staff_no || null,
        assessment_no: snap.assessment_no || null,
        class_name: [snap.class_name, snap.stream].filter(Boolean).join(' ') || null,
        department: snap.department || null,
        residence_type: snap.residence_type || null,
        year_label: snap.year_label || null,
        valid_from: record.valid_from ? String(record.valid_from).slice(0, 10) : (snap.valid_from || null),
        valid_until: record.valid_until ? String(record.valid_until).slice(0, 10) : (snap.valid_until || null),
        card_reference: record.card_reference,
        issued_at: record.issued_at,
        revocation_reason: record.revocation_reason || null
      }
    });
  } catch (error) {
    console.error('Verify ID card failed:', error);
    res.status(500).json({ error: 'Unable to verify this ID card right now.' });
  }
});

router.use(authenticate);

router.get('/:schoolId/categories', schoolBoundary, roles(...VIEW), async (req, res) => {
  try {
    const q = await db.query(
      `SELECT id, school_id, code, label, default_title, default_statement, is_leaving, sort_order
       FROM school_document_categories
       WHERE is_active = true AND (school_id IS NULL OR school_id = $1)
       ORDER BY sort_order, label`,
      [req.params.schoolId]
    );
    res.json(q.rows);
  } catch (error) {
    if (error.code === '42P01') return res.json([]);
    console.error('Load document categories failed:', error);
    res.status(500).json({ error: 'Unable to load certificate categories.' });
  }
});

router.post('/:schoolId/categories', schoolBoundary, roles('SCHOOL_ADMIN', 'ADMIN'), async (req, res) => {
  const code = clean(req.body?.code, 40).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const label = clean(req.body?.label, 80);
  const defaultTitle = clean(req.body?.default_title, 120) || `Certificate of ${label}`;
  const defaultStatement = clean(req.body?.default_statement, 500);
  if (!/^[A-Z0-9_]{3,40}$/.test(code) || label.length < 3) {
    return res.status(400).json({ error: 'Provide a valid category code and label (at least 3 characters).' });
  }
  try {
    const q = await db.query(
      `INSERT INTO school_document_categories(school_id, code, label, default_title, default_statement, is_leaving)
       VALUES($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.schoolId, code, label, defaultTitle, defaultStatement, Boolean(req.body?.is_leaving)]
    );
    res.status(201).json(q.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That certificate category already exists.' });
    console.error('Create document category failed:', error);
    res.status(500).json({ error: 'Unable to create certificate category.' });
  }
});

router.get('/:schoolId/templates', schoolBoundary, roles(...VIEW), async (req, res) => {
  const type = String(req.query.document_type || '');
  const category = String(req.query.category || 'DEFAULT').toUpperCase();
  if (!['ID_CARD', 'CERTIFICATE'].includes(type)) return res.status(400).json({ error: 'Select ID_CARD or CERTIFICATE.' });
  if (type === 'ID_CARD' && category !== 'DEFAULT') return res.status(400).json({ error: 'ID card preferences use the DEFAULT category.' });
  const extraCats = type === 'CERTIFICATE' && category !== 'DEFAULT' ? await getSchoolCategorySet(req.params.schoolId) : null;
  if (type === 'CERTIFICATE' && category !== 'DEFAULT' && !validDocumentCategory(category, extraCats)) {
    return res.status(400).json({ error: 'Select a valid certificate category.' });
  }
  try {
    const saved = await db.query(
      `SELECT template_id, COALESCE(layout_options, '{}'::jsonb) AS layout_options
       FROM school_document_template_preferences
       WHERE school_id = $1 AND document_type = $2 AND category = $3`,
      [req.params.schoolId, type, category]
    );
    const options = documentTemplates(type);
    res.json({
      document_type: type, category, templates: options,
      selected: options.some(item => item.id === saved.rows[0]?.template_id) ? saved.rows[0].template_id : options[0].id,
      layout_options: saved.rows[0]?.layout_options || {}
    });
  } catch (error) {
    console.error('Load document template preferences failed:', error);
    res.status(500).json({ error: 'Unable to load document designs.' });
  }
});

router.put('/:schoolId/templates', schoolBoundary, roles('SCHOOL_ADMIN', 'ADMIN'), async (req, res) => {
  const type = String(req.body?.document_type || '');
  const category = String(req.body?.category || 'DEFAULT').toUpperCase();
  const template = String(req.body?.template_id || '');
  const layoutOptions = (req.body?.layout_options && typeof req.body.layout_options === 'object' && !Array.isArray(req.body.layout_options)) ? req.body.layout_options : {};
  if (!['ID_CARD', 'CERTIFICATE'].includes(type)) return res.status(400).json({ error: 'Select ID_CARD or CERTIFICATE.' });
  if (type === 'ID_CARD' && category !== 'DEFAULT') return res.status(400).json({ error: 'ID card preferences use the DEFAULT category.' });
  const extraCats = type === 'CERTIFICATE' && category !== 'DEFAULT' ? await getSchoolCategorySet(req.params.schoolId) : null;
  if (type === 'CERTIFICATE' && category !== 'DEFAULT' && !validDocumentCategory(category, extraCats)) {
    return res.status(400).json({ error: 'Select a valid certificate category.' });
  }
  if (!documentTemplate(template, type)) return res.status(400).json({ error: 'Select an available design for this document type.' });
  try {
    const saved = await db.query(
      `INSERT INTO school_document_template_preferences (school_id, document_type, category, template_id, layout_options, updated_by)
       VALUES($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT(school_id, document_type, category) DO UPDATE SET
        template_id = EXCLUDED.template_id, layout_options = EXCLUDED.layout_options, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING document_type, category, template_id, layout_options, updated_at`,
      [req.params.schoolId, type, category, template, JSON.stringify(layoutOptions), req.user.user_id]
    );
    res.json(saved.rows[0]);
  } catch (error) {
    console.error('Save document template preference failed:', error);
    res.status(500).json({ error: 'Unable to save the school document design.' });
  }
});

router.get('/:schoolId/academic-certificates', schoolBoundary, roles(...VIEW), async (req, res) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    if (status && !['DRAFT', 'ISSUED', 'REVOKED'].includes(status)) return res.status(400).json({ error: 'Invalid certificate status filter.' });
    const category = String(req.query.category || '').toUpperCase();
    const yearId = req.query.academic_year_id || null, termId = req.query.term_id || null, classId = req.query.class_id || null;
    const search = clean(req.query.search, 100);
    const extraCats = category ? await getSchoolCategorySet(req.params.schoolId) : null;
    if (category && !validDocumentCategory(category, extraCats)) return res.status(400).json({ error: 'Invalid certificate category filter.' });
    for (const [label, value] of [['academic year', yearId], ['term', termId], ['class', classId]]) {
      if (value && !uuid.test(value)) return res.status(400).json({ error: `Invalid ${label} filter.` });
    }
    const paginated = req.query.page !== undefined || req.query.page_size !== undefined;
    const page = paginated ? Number(req.query.page || 1) : 1, pageSize = paginated ? Number(req.query.page_size || 30) : 500;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return res.status(400).json({ error: 'Invalid certificate register page.' });
    }
    const offset = (page - 1) * pageSize;
    const params = [req.params.schoolId, status || null, category || null, yearId, termId, classId, search ? `%${search}%` : null];
    const joins = `FROM school_academic_certificates c
      JOIN learners l ON l.id = c.learner_id AND l.school_id = c.school_id
      LEFT JOIN learner_enrollments le ON le.school_id = c.school_id AND le.learner_id = l.id AND le.academic_year_id = COALESCE($4::uuid, c.academic_year_id)
      LEFT JOIN classes cl ON cl.id = COALESCE(le.class_id, l.class_id) AND cl.school_id = c.school_id
      LEFT JOIN academic_years ay ON ay.id = c.academic_year_id AND ay.school_id = c.school_id
      LEFT JOIN terms t ON t.id = c.term_id AND t.school_id = c.school_id
      LEFT JOIN users creator ON creator.id = c.created_by LEFT JOIN users issuer ON issuer.id = c.issued_by
      LEFT JOIN school_academic_certificates replaced ON replaced.id = c.replaces_certificate_id AND replaced.school_id = c.school_id
      LEFT JOIN school_academic_certificates replacement ON replacement.replaces_certificate_id = c.id AND replacement.school_id = c.school_id
      WHERE c.school_id = $1 AND ($2::text IS NULL OR c.status = $2) AND ($3::text IS NULL OR c.category = $3)
        AND ($4::uuid IS NULL OR c.academic_year_id = $4) AND ($5::uuid IS NULL OR c.term_id = $5)
        AND ($6::uuid IS NULL OR COALESCE(le.class_id, l.class_id) = $6)
        AND ($7::text IS NULL OR c.certificate_no ILIKE $7 OR l.admission_no ILIKE $7 OR l.assessment_no ILIKE $7
          OR l.first_name ILIKE $7 OR l.middle_name ILIKE $7 OR l.last_name ILIKE $7
          OR concat_ws(' ', l.first_name, l.middle_name, l.last_name) ILIKE $7)`;
    const count = paginated ? Number((await db.query(`SELECT count(*)::int count ${joins}`, params)).rows[0].count) : null;
    const rows = await db.query(`SELECT c.id, c.learner_id, c.certificate_no, c.category, c.title, c.achievement_statement, c.status, c.issued_on,
        c.template_id, c.subject_or_activity, c.achievement_date, c.signer_name, c.signer_title, c.second_signer_name, c.second_signer_title,
        c.signer_user_id, c.second_signer_user_id, c.assessment_id, c.subject_id, c.metadata,
        c.replaces_certificate_id, replaced.certificate_no replaced_certificate_no, replacement.certificate_no replacement_certificate_no,
        c.academic_year_id, c.term_id, c.created_at, c.issued_at, c.revoked_at, c.revocation_reason,
        l.admission_no, l.assessment_no, l.first_name, l.middle_name, l.last_name, cl.name class_name, cl.stream,
        ay.year_label, t.term_no, t.name term_name,
        creator.first_name creator_first_name, creator.last_name creator_last_name,
        issuer.first_name issuer_first_name, issuer.last_name issuer_last_name
      ${joins} ORDER BY c.created_at DESC, c.id DESC LIMIT $8 OFFSET $9`, [...params, pageSize, offset]);
    res.json(paginated ? { rows: rows.rows, pagination: { page, page_size: pageSize, total: count, pages: Math.ceil(count / pageSize) } } : rows.rows);
  } catch (error) {
    console.error('Load academic certificates failed:', error);
    res.status(500).json({ error: 'Unable to load academic certificates.' });
  }
});

router.post('/:schoolId/academic-certificates', schoolBoundary, roles(...WRITE), async (req, res) => {
  const sid = req.params.schoolId;
  let input;
  try { input = validateCertificateDraft(req.body, await getSchoolCategorySet(sid)); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  try {
    if (!(await db.query('SELECT id FROM learners WHERE school_id = $1 AND id = $2', [sid, input.learner_id])).rowCount) {
      return res.status(404).json({ error: 'Learner not found in this school.' });
    }
    if (input.academic_year_id && !(await db.query('SELECT id FROM academic_years WHERE school_id = $1 AND id = $2', [sid, input.academic_year_id])).rowCount) {
      return res.status(400).json({ error: 'Academic year does not belong to this school.' });
    }
    if (input.term_id) {
      const term = await db.query('SELECT academic_year_id FROM terms WHERE school_id = $1 AND id = $2', [sid, input.term_id]);
      if (!term.rowCount) return res.status(400).json({ error: 'Term does not belong to this school.' });
      if (input.academic_year_id && String(term.rows[0].academic_year_id) !== String(input.academic_year_id)) {
        return res.status(400).json({ error: 'Selected term does not belong to the selected academic year.' });
      }
      input.academic_year_id = input.academic_year_id || term.rows[0].academic_year_id;
    }
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await validateCertificateReplacement(client, sid, input.replaces_certificate_id);
      const number = `ZAC-${new Date().getUTCFullYear()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
      const row = (await client.query(`
        INSERT INTO school_academic_certificates
          (school_id, learner_id, academic_year_id, term_id, assessment_id, subject_id,
           certificate_no, category, title, achievement_statement, subject_or_activity, achievement_date,
           signer_user_id, signer_name, signer_title, second_signer_user_id, second_signer_name, second_signer_title,
           replaces_certificate_id, metadata, created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21) RETURNING *`,
      [sid, input.learner_id, input.academic_year_id, input.term_id, input.assessment_id, input.subject_id,
        number, input.category, input.title, input.achievement_statement, input.subject_or_activity, input.achievement_date,
        input.signer_user_id, input.signer_name, input.signer_title, input.second_signer_user_id, input.second_signer_name, input.second_signer_title,
        input.replaces_certificate_id, JSON.stringify(input.metadata || {}), req.user.user_id])).rows[0];
      await client.query(`INSERT INTO audit_log(school_id, user_id, action, entity_type, entity_id, details) VALUES($1,$2,'ACADEMIC_CERTIFICATE_DRAFT_CREATED','school_academic_certificate',$3,$4::jsonb)`,
        [sid, req.user.user_id, row.id, JSON.stringify({ certificate_no: number, category: input.category, learner_id: input.learner_id, title: input.title, replaces_certificate_id: input.replaces_certificate_id })]);
      await client.query('COMMIT');
      res.status(201).json(row);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Create academic certificate draft failed:', error);
    res.status(500).json({ error: 'Unable to create certificate draft.' });
  }
});

router.post('/:schoolId/academic-certificates/bulk-from-merit', schoolBoundary, roles(...WRITE), async (req, res) => {
  const sid = req.params.schoolId, b = req.body || {};
  const classId = b.class_id, yearId = b.academic_year_id, termId = b.term_id;
  const subjectId = b.subject_id || null, assessmentId = b.assessment_id || null;
  const topN = Math.min(Math.max(Number(b.top_n || 3), 1), 20);
  if (!uuid.test(String(classId || '')) || !uuid.test(String(yearId || '')) || !uuid.test(String(termId || ''))) {
    return res.status(400).json({ error: 'Select valid academic year, term, and class.' });
  }
  const client = await db.pool.connect();
  try {
    const q = await client.query(`
      SELECT m.learner_id, l.first_name, l.last_name,
        ROUND(AVG(CASE WHEN a.max_mark > 0 THEN (m.mark / a.max_mark) * 100 END)::numeric, 2) AS avg_score
      FROM marks m
      JOIN assessments a ON a.id = m.assessment_id AND a.school_id = m.school_id
      JOIN learners l ON l.id = m.learner_id AND l.school_id = m.school_id
      LEFT JOIN learner_enrollments le ON le.school_id = m.school_id AND le.learner_id = l.id AND le.academic_year_id = m.academic_year_id
      WHERE m.school_id = $1 AND m.academic_year_id = $2 AND m.term_id = $3
        AND COALESCE(le.class_id, l.class_id) = $4 AND ($5::uuid IS NULL OR m.subject_id = $5)
        AND ($6::uuid IS NULL OR m.assessment_id = $6) AND m.mark IS NOT NULL
      GROUP BY m.learner_id, l.first_name, l.last_name
      ORDER BY avg_score DESC NULLS LAST, l.last_name, l.first_name LIMIT $7`,
    [sid, yearId, termId, classId, subjectId, assessmentId, topN]);
    if (!q.rows.length) return res.status(404).json({ error: 'No entered marks found for that selection.' });
    const category = subjectId ? 'SUBJECT_PERFORMANCE' : 'ACADEMIC_ACHIEVEMENT';
    const title = clean(b.title, 120) || (subjectId ? 'Subject Champion Certificate' : 'Certificate of Academic Excellence');
    const subjectName = subjectId ? (await client.query('SELECT name FROM subjects WHERE school_id = $1 AND id = $2', [sid, subjectId])).rows[0]?.name : null;
    await client.query('BEGIN');
    const created = [];
    for (let i = 0; i < q.rows.length; i++) {
      const r = q.rows[i], rank = i + 1;
      const number = `ZAC-${new Date().getUTCFullYear()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
      const statement = clean(b.achievement_statement, 1000) || `Achieved Position #${rank} with an average score of ${r.avg_score}%${subjectName ? ` in ${subjectName}` : ''}.`;
      const inserted = (await client.query(`
        INSERT INTO school_academic_certificates
          (school_id, learner_id, academic_year_id, term_id, assessment_id, subject_id,
           certificate_no, category, title, achievement_statement, subject_or_activity, achievement_date, metadata, created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_DATE,$12::jsonb,$13)
        RETURNING id, certificate_no, learner_id, title, category, status`,
      [sid, r.learner_id, yearId, termId, assessmentId, subjectId, number, category, title, statement, subjectName || null, JSON.stringify({ merit_score: Number(r.avg_score), rank }), req.user.user_id])).rows[0];
      created.push(inserted);
    }
    await client.query('COMMIT');
    res.status(201).json({ created_count: created.length, certificates: created });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Bulk draft certificates from merit failed:', error);
    res.status(500).json({ error: 'Unable to create merit draft certificates.' });
  } finally { client.release(); }
});

router.patch('/:schoolId/academic-certificates/:certificateId', schoolBoundary, roles(...WRITE), async (req, res) => {
  if (!uuid.test(req.params.certificateId)) return res.status(400).json({ error: 'Invalid certificate ID.' });
  let input;
  try { input = validateCertificateDraft(req.body, await getSchoolCategorySet(req.params.schoolId)); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT * FROM school_academic_certificates WHERE school_id = $1 AND id = $2 FOR UPDATE', [req.params.schoolId, req.params.certificateId])).rows[0];
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Certificate not found.' }); }
    if (current.status !== 'DRAFT') throw Object.assign(new Error('Only draft certificates can be edited.'), { status: 409 });
    await validateCertificateReplacement(client, req.params.schoolId, input.replaces_certificate_id, current.id);
    if (!(await client.query('SELECT id FROM learners WHERE school_id = $1 AND id = $2', [req.params.schoolId, input.learner_id])).rowCount) {
      throw Object.assign(new Error('Learner not found in this school.'), { status: 400 });
    }
    if (input.academic_year_id && !((await client.query('SELECT id FROM academic_years WHERE school_id = $1 AND id = $2', [req.params.schoolId, input.academic_year_id])).rowCount)) {
      throw Object.assign(new Error('Academic year does not belong to this school.'), { status: 400 });
    }
    if (input.term_id) {
      const term = (await client.query('SELECT academic_year_id FROM terms WHERE school_id = $1 AND id = $2', [req.params.schoolId, input.term_id])).rows[0];
      if (!term) throw Object.assign(new Error('Term does not belong to this school.'), { status: 400 });
      if (input.academic_year_id && String(term.academic_year_id) !== String(input.academic_year_id)) {
        throw Object.assign(new Error('Selected term does not belong to the selected academic year.'), { status: 400 });
      }
      input.academic_year_id = input.academic_year_id || term.academic_year_id;
    }
    const updated = (await client.query(`
      UPDATE school_academic_certificates SET
        learner_id=$3, academic_year_id=$4, term_id=$5, assessment_id=$6, subject_id=$7,
        category=$8, title=$9, achievement_statement=$10, subject_or_activity=$11, achievement_date=$12,
        signer_user_id=$13, signer_name=$14, signer_title=$15, second_signer_user_id=$16, second_signer_name=$17, second_signer_title=$18,
        replaces_certificate_id=$19, metadata=$20::jsonb, updated_at=now()
      WHERE school_id=$1 AND id=$2 RETURNING *`,
    [req.params.schoolId, current.id, input.learner_id, input.academic_year_id, input.term_id, input.assessment_id, input.subject_id,
      input.category, input.title, input.achievement_statement, input.subject_or_activity, input.achievement_date,
      input.signer_user_id, input.signer_name, input.signer_title, input.second_signer_user_id, input.second_signer_name, input.second_signer_title,
      input.replaces_certificate_id, JSON.stringify(input.metadata || {})])).rows[0];
    await client.query(`INSERT INTO audit_log(school_id, user_id, action, entity_type, entity_id, details) VALUES($1,$2,'ACADEMIC_CERTIFICATE_DRAFT_UPDATED','school_academic_certificate',$3,$4::jsonb)`,
      [req.params.schoolId, req.user.user_id, current.id, JSON.stringify({ certificate_no: current.certificate_no, previous_title: current.title, title: input.title, replaces_certificate_id: input.replaces_certificate_id })]);
    await client.query('COMMIT'); res.json(updated);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Update academic certificate draft failed:', error);
    res.status(500).json({ error: 'Unable to update certificate draft.' });
  } finally { client.release(); }
});

router.post('/:schoolId/academic-certificates/:certificateId/issue', schoolBoundary, roles(...ISSUE), async (req, res) => {
  if (!uuid.test(req.params.certificateId)) return res.status(400).json({ error: 'Invalid certificate ID.' });
  const requestedTemplate = req.body?.template_id;
  if (requestedTemplate && !documentTemplate(requestedTemplate, 'CERTIFICATE')) return res.status(400).json({ error: 'Select a supported certificate design.' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT * FROM school_academic_certificates WHERE school_id = $1 AND id = $2 FOR UPDATE', [req.params.schoolId, req.params.certificateId])).rows[0];
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Certificate not found.' }); }
    assertCertificateTransition(current.status, 'ISSUED');
    const prefRow = (await client.query(`SELECT template_id, COALESCE(layout_options,'{}'::jsonb) AS layout_options FROM school_document_template_preferences WHERE school_id=$1 AND document_type='CERTIFICATE' AND category IN ($2,'DEFAULT') ORDER BY CASE WHEN category=$2 THEN 0 ELSE 1 END LIMIT 1`, [req.params.schoolId, current.category])).rows[0];
    const template = requestedTemplate || documentTemplate(prefRow?.template_id, 'CERTIFICATE') || 'classic';
    await client.query(`UPDATE school_academic_certificates SET status='ISSUED', issued_on=CURRENT_DATE, issued_by=$3, issued_at=now(), template_id=$4, updated_at=now() WHERE school_id=$1 AND id=$2`, [req.params.schoolId, current.id, req.user.user_id, template]);
    const token = randomDocumentToken();
    const { version } = getActiveEncryptionKey();
    const snapshot = await loadCertificateIssueSnapshot(client, req.params.schoolId, current.id, req.user.user_id, req.user.role, template);
    if (prefRow?.layout_options?.custom_body_template && current.status === 'DRAFT') {
      const rendered = renderCustomStatement(prefRow.layout_options.custom_body_template, {
        learner_name: [snapshot.first_name, snapshot.middle_name, snapshot.last_name].filter(Boolean).join(' '),
        admission_no: snapshot.admission_no || '', assessment_no: snapshot.assessment_no || '',
        subject_or_activity: snapshot.subject_or_activity || '',
        class_name: [snapshot.class_name, snapshot.stream].filter(Boolean).join(' '),
        year_label: snapshot.year_label || '', school_name: snapshot.school_name || ''
      });
      if (rendered) snapshot.achievement_statement = rendered;
    }
    const saved = (await client.query(`UPDATE school_academic_certificates SET snapshot=$3::jsonb, verification_token_hash=$4, verification_token_ciphertext=$5, key_version=$6 WHERE school_id=$1 AND id=$2 RETURNING *`,
      [req.params.schoolId, current.id, JSON.stringify(snapshot), documentTokenHash(token), encryptDocumentToken(token), version])).rows[0];
    await client.query(`INSERT INTO audit_log(school_id, user_id, action, entity_type, entity_id, details) VALUES($1,$2,'ACADEMIC_CERTIFICATE_ISSUED','school_academic_certificate',$3,$4::jsonb)`,
      [req.params.schoolId, req.user.user_id, current.id, JSON.stringify({ certificate_no: current.certificate_no, template_id: template, category: current.category, replaces_certificate_id: current.replaces_certificate_id })]);
    await client.query('COMMIT');
    res.json({ id: saved.id, certificate_no: saved.certificate_no, status: saved.status, issued_on: saved.issued_on, issued_at: saved.issued_at, template_id: saved.template_id });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Issue academic certificate failed:', error);
    res.status(500).json({ error: 'Unable to issue certificate.' });
  } finally { client.release(); }
});

router.post('/:schoolId/academic-certificates/:certificateId/revoke', schoolBoundary, roles(...ISSUE), async (req, res) => {
  if (!uuid.test(req.params.certificateId)) return res.status(400).json({ error: 'Invalid certificate ID.' });
  const reason = clean(req.body?.reason, 500);
  if (reason.length < 4) return res.status(400).json({ error: 'Provide a revocation reason of at least four characters.' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT * FROM school_academic_certificates WHERE school_id = $1 AND id = $2 FOR UPDATE', [req.params.schoolId, req.params.certificateId])).rows[0];
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Certificate not found.' }); }
    assertCertificateTransition(current.status, 'REVOKED');
    const revoked = (await client.query(`UPDATE school_academic_certificates SET status='REVOKED', revoked_by=$3, revoked_at=now(), revocation_reason=$4, updated_at=now() WHERE school_id=$1 AND id=$2 RETURNING *`, [req.params.schoolId, current.id, req.user.user_id, reason])).rows[0];
    await client.query(`INSERT INTO audit_log(school_id, user_id, action, entity_type, entity_id, details) VALUES($1,$2,'ACADEMIC_CERTIFICATE_REVOKED','school_academic_certificate',$3,$4::jsonb)`, [req.params.schoolId, req.user.user_id, current.id, JSON.stringify({ certificate_no: current.certificate_no, reason })]);
    await client.query('COMMIT'); res.json(revoked);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Revoke academic certificate failed:', error);
    res.status(500).json({ error: 'Unable to revoke certificate.' });
  } finally { client.release(); }
});

router.get('/:schoolId/academic-certificates/:certificateId/pdf', schoolBoundary, roles(...VIEW), async (req, res) => {
  try {
    if (!uuid.test(req.params.certificateId)) return res.status(400).json({ error: 'Invalid certificate ID.' });
    const requestedTemplate = req.query.template ? documentTemplate(req.query.template, 'CERTIFICATE') : null;
    if (req.query.template && !requestedTemplate) return res.status(400).json({ error: 'Select a supported certificate design.' });
    let row = (await db.query(`
      SELECT c.*, l.admission_no, l.assessment_no, l.first_name, l.middle_name, l.last_name, l.passport_photo_url,
        cl.name class_name, cl.stream, ay.year_label, t.term_no, t.name term_name,
        s.name school_name, s.code school_code, si.logo_url, si.motto, si.address, si.contact_phone, si.contact_email, si.primary_color, si.secondary_color,
        issuer.first_name issuer_first_name, issuer.last_name issuer_last_name,
        t1.signature_url issuer_signature_url, t2.signature_url second_signer_signature_url,
        (SELECT file_url FROM school_document_assets a WHERE a.school_id=c.school_id AND a.asset_type='STAMP' AND a.is_active=true AND a.effective_from<=CURRENT_DATE AND (a.effective_to IS NULL OR a.effective_to>=CURRENT_DATE) ORDER BY a.effective_from DESC, a.created_at DESC LIMIT 1) stamp_url
      FROM school_academic_certificates c
      JOIN learners l ON l.id = c.learner_id AND l.school_id = c.school_id
      LEFT JOIN classes cl ON cl.id = l.class_id AND cl.school_id = c.school_id
      LEFT JOIN academic_years ay ON ay.id = c.academic_year_id AND ay.school_id = c.school_id
      LEFT JOIN terms t ON t.id = c.term_id AND t.school_id = c.school_id
      JOIN schools s ON s.id = c.school_id LEFT JOIN school_identity si ON si.school_id = c.school_id
      LEFT JOIN users issuer ON issuer.id = COALESCE(c.signer_user_id, c.issued_by)
      LEFT JOIN teachers t1 ON t1.user_id = COALESCE(c.signer_user_id, c.issued_by) AND t1.school_id = c.school_id AND COALESCE(t1.is_active, true) = true
      LEFT JOIN teachers t2 ON t2.user_id = c.second_signer_user_id AND t2.school_id = c.school_id AND COALESCE(t2.is_active, true) = true
      WHERE c.school_id = $1 AND c.id = $2`, [req.params.schoolId, req.params.certificateId])).rows[0];
    if (!row) return res.status(404).json({ error: 'Certificate not found.' });
    let template = requestedTemplate || 'classic';
    if (row.snapshot && typeof row.snapshot === 'object' && Object.keys(row.snapshot).length > 0) {
      const snapshot = row.snapshot, tokenCiphertext = row.verification_token_ciphertext;
      row = { ...snapshot, status: row.status, issued_on: row.issued_on, revoked_at: row.revoked_at, revocation_reason: row.revocation_reason };
      template = documentTemplate(snapshot.template_id, 'CERTIFICATE') || template;
      if (tokenCiphertext) {
        const token = decryptDocumentToken(tokenCiphertext);
        row.qrBuffer = await QRCode.toBuffer(verificationUrl(req, '/certificate-verification.html', token), { errorCorrectionLevel: 'M', margin: 1, width: 180 });
      }
    }
    const assets = await hydrateRenderAssets(req.params.schoolId, row);
    const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: String(row.title || 'Certificate'), Author: String(row.school_name || '') } });
    const filename = `academic-certificate-${row.certificate_no}-${template}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
    pdf.pipe(res); renderCertificate(pdf, row, template, assets); pdf.end();
  } catch (error) {
    console.error('Generate academic certificate PDF failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate certificate PDF.' }); else res.end();
  }
});

router.get('/:schoolId/learners/:learnerId/id-card.pdf', schoolBoundary, roles(...VIEW), async (req, res) => {
  let client = null;
  try {
    if (!uuid.test(req.params.learnerId)) return res.status(400).json({ error: 'Invalid learner ID.' });
    const requestedTemplate = documentTemplate(req.query.template, 'ID_CARD');
    if (!requestedTemplate) return res.status(400).json({ error: 'Select a supported ID card design.' });
    const issue = req.query.issue === '1';
    if (issue && !ISSUE.includes(String(req.user.role || '').toUpperCase())) return res.status(403).json({ error: 'Only authorised school leaders can issue or reprint ID cards.' });
    const academicYearId = req.query.academic_year_id || null;
    if (academicYearId && !uuid.test(academicYearId)) return res.status(400).json({ error: 'Invalid academic year.' });
    const cardOptions = validateIdCardOptions(req.query || {});
    let yearLabel = null;
    if (academicYearId) {
      yearLabel = (await db.query('SELECT year_label FROM academic_years WHERE school_id = $1 AND id = $2', [req.params.schoolId, academicYearId])).rows[0]?.year_label;
      if (!yearLabel) return res.status(400).json({ error: 'Academic year does not belong to this school.' });
    }
    const learner = await loadLearnerForCard(req.params.schoolId, req.params.learnerId, academicYearId, yearLabel);
    if (!learner) return res.status(404).json({ error: 'Active learner not found in this school.' });
    const layoutOpts = await loadIdCardLayoutOptions(req.params.schoolId);
    if (issue) { client = await db.pool.connect(); await client.query('BEGIN'); }
    const issued = issue ? await issueOrReprintIdCard(req, learner, 'LEARNER', requestedTemplate, academicYearId, false, client, null, cardOptions) : null;
    const renderHolder = issued ? { ...issued.snapshot, card_type: 'LEARNER' } : { ...learner, ...cardOptions, card_type: 'LEARNER' };
    const template = issued ? issued.card.template_id : requestedTemplate;
    const cardReference = issued?.card.card_reference || 'PREVIEW';
    const qrBuffer = issued ? await QRCode.toBuffer(verificationUrl(req, '/verify-id-card.html', issued.token), { errorCorrectionLevel: 'M', margin: 1, width: 180 }) : null;
    const assets = await hydrateRenderAssets(req.params.schoolId, renderHolder);
    const side = req.query.side === 'both' ? 'both' : 'front';
    const pdfBuffer = await createIdCardPdf(renderHolder, template, { qrBuffer, cardReference }, side, assets, layoutOpts);
    const person = [renderHolder.first_name, renderHolder.middle_name, renderHolder.last_name].filter(Boolean).join('_').replace(/[^a-zA-Z0-9_-]/g, '-');
    const filename = `ZelimuCBC_ID_${clean(renderHolder.admission_no, 80).replace(/[^a-zA-Z0-9_-]/g, '-') || 'card'}_${person || 'learner'}_${template}.pdf`;
    if (client) { await client.query('COMMIT'); client.release(); client = null; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
    if (issued) res.setHeader('X-Card-Reference', cardReference);
    res.send(pdfBuffer);
  } catch (error) {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Generate learner ID card failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate learner ID card.' }); else res.end();
  }
});

router.get('/:schoolId/learners/:learnerId/id-card', schoolBoundary, roles(...VIEW), async (req, res) => {
  try {
    if (!uuid.test(req.params.learnerId)) return res.status(400).json({ error: 'Invalid learner ID.' });
    const record = (await db.query(`SELECT id, card_reference, card_type, status, template_id, valid_from, valid_until, issued_at FROM school_learner_cards WHERE school_id=$1 AND learner_id=$2 ORDER BY issued_at DESC LIMIT 1`, [req.params.schoolId, req.params.learnerId])).rows[0];
    res.json(record || null);
  } catch (error) { console.error('Load learner ID card status failed:', error); res.status(500).json({ error: 'Unable to load learner ID card status.' }); }
});

router.get('/:schoolId/staff/:teacherId/id-card.pdf', schoolBoundary, roles(...VIEW), async (req, res) => {
  let client = null;
  try {
    if (!uuid.test(req.params.teacherId)) return res.status(400).json({ error: 'Invalid staff ID.' });
    const requestedTemplate = documentTemplate(req.query.template, 'ID_CARD');
    if (!requestedTemplate) return res.status(400).json({ error: 'Select a supported ID card design.' });
    const issue = req.query.issue === '1';
    if (issue && !ISSUE.includes(String(req.user.role || '').toUpperCase())) return res.status(403).json({ error: 'Only authorised school leaders can issue or reprint staff ID cards.' });
    const academicYearId = req.query.academic_year_id || null;
    if (academicYearId && !uuid.test(academicYearId)) return res.status(400).json({ error: 'Invalid academic year.' });
    const cardOptions = validateIdCardOptions(req.query || {});
    let yearLabel = null;
    if (academicYearId) {
      yearLabel = (await db.query('SELECT year_label FROM academic_years WHERE school_id = $1 AND id = $2', [req.params.schoolId, academicYearId])).rows[0]?.year_label;
      if (!yearLabel) return res.status(400).json({ error: 'Academic year does not belong to this school.' });
    }
    const staff = await loadStaffForCard(req.params.schoolId, req.params.teacherId, yearLabel);
    if (!staff) return res.status(404).json({ error: 'Active staff member not found in this school.' });
    const layoutOpts = await loadIdCardLayoutOptions(req.params.schoolId);
    if (issue) { client = await db.pool.connect(); await client.query('BEGIN'); }
    const issued = issue ? await issueOrReprintIdCard(req, staff, 'STAFF', requestedTemplate, academicYearId, false, client, null, cardOptions) : null;
    const renderHolder = issued ? { ...issued.snapshot, card_type: 'STAFF' } : { ...staff, ...cardOptions, card_type: 'STAFF' };
    const template = issued ? issued.card.template_id : requestedTemplate;
    const cardReference = issued?.card.card_reference || 'PREVIEW';
    const qrBuffer = issued ? await QRCode.toBuffer(verificationUrl(req, '/verify-id-card.html', issued.token), { errorCorrectionLevel: 'M', margin: 1, width: 180 }) : null;
    const assets = await hydrateRenderAssets(req.params.schoolId, renderHolder);
    const side = req.query.side === 'both' ? 'both' : 'front';
    const pdfBuffer = await createIdCardPdf(renderHolder, template, { qrBuffer, cardReference }, side, assets, layoutOpts);
    const person = [renderHolder.first_name, renderHolder.middle_name, renderHolder.last_name].filter(Boolean).join('_').replace(/[^a-zA-Z0-9_-]/g, '-');
    const filename = `ZelimuCBC_StaffID_${clean(renderHolder.staff_no, 80).replace(/[^a-zA-Z0-9_-]/g, '-') || 'card'}_${person || 'staff'}_${template}.pdf`;
    if (client) { await client.query('COMMIT'); client.release(); client = null; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
    if (issued) res.setHeader('X-Card-Reference', cardReference);
    res.send(pdfBuffer);
  } catch (error) {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Generate staff ID card failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate staff ID card.' }); else res.end();
  }
});

router.get('/:schoolId/staff/:teacherId/id-card', schoolBoundary, roles(...VIEW), async (req, res) => {
  try {
    if (!uuid.test(req.params.teacherId)) return res.status(400).json({ error: 'Invalid staff ID.' });
    const record = (await db.query(`SELECT id, card_reference, card_type, status, template_id, valid_from, valid_until, issued_at FROM school_learner_cards WHERE school_id=$1 AND teacher_id=$2 ORDER BY issued_at DESC LIMIT 1`, [req.params.schoolId, req.params.teacherId])).rows[0];
    res.json(record || null);
  } catch (error) { console.error('Load staff ID card status failed:', error); res.status(500).json({ error: 'Unable to load staff ID card status.' }); }
});

router.post('/:schoolId/staff/:teacherId/id-card/replace', schoolBoundary, roles(...ISSUE), async (req, res) => {
  try {
    if (!uuid.test(req.params.teacherId)) return res.status(400).json({ error: 'Invalid staff ID.' });
    const reason = clean(req.body?.reason, 500);
    if (reason.length < 4) return res.status(400).json({ error: 'Enter a replacement reason of at least four characters.' });
    const template = documentTemplate(req.body?.template_id, 'ID_CARD');
    if (!template) return res.status(400).json({ error: 'Select a supported ID card design.' });
    const academicYearId = req.body?.academic_year_id || null;
    if (academicYearId && !uuid.test(academicYearId)) return res.status(400).json({ error: 'Invalid academic year.' });
    const cardOptions = validateIdCardOptions(req.body || {});
    let yearLabel = null;
    if (academicYearId) {
      yearLabel = (await db.query('SELECT year_label FROM academic_years WHERE school_id=$1 AND id=$2', [req.params.schoolId, academicYearId])).rows[0]?.year_label;
      if (!yearLabel) return res.status(400).json({ error: 'Academic year does not belong to this school.' });
    }
    const staff = await loadStaffForCard(req.params.schoolId, req.params.teacherId, yearLabel);
    if (!staff) return res.status(404).json({ error: 'Active staff member not found in this school.' });
    const { card } = await issueOrReprintIdCard(req, staff, 'STAFF', template, academicYearId, true, null, reason, cardOptions);
    res.status(201).json({ card_reference: card.card_reference, status: card.status });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Replace staff ID card failed:', error); res.status(500).json({ error: 'Unable to replace staff ID card.' });
  }
});

router.post('/:schoolId/id-cards/bulk.zip', schoolBoundary, roles(...ISSUE), async (req, res) => {
  try {
    const archiveBuffer = await buildBulkIdCards(req, 'zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="learner-id-cards-${new Date().toISOString().slice(0, 10)}.zip"`);
    res.setHeader('X-Card-Count', String(req.body.learner_ids.length));
    res.send(archiveBuffer);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Generate bulk learner ID cards failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate bulk learner ID cards.' }); else res.end();
  }
});

router.post('/:schoolId/id-cards/bulk.pdf', schoolBoundary, roles(...ISSUE), async (req, res) => {
  try {
    const pdf = await buildBulkIdCards(req, 'pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="learner-id-cards-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.setHeader('X-Card-Count', String(req.body.learner_ids.length));
    res.send(pdf);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Generate combined learner ID cards failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate combined learner ID cards.' }); else res.end();
  }
});

router.post('/:schoolId/learners/:learnerId/id-card/replace', schoolBoundary, roles(...ISSUE), async (req, res) => {
  try {
    if (!uuid.test(req.params.learnerId)) return res.status(400).json({ error: 'Invalid learner ID.' });
    const reason = clean(req.body?.reason, 500);
    if (reason.length < 4) return res.status(400).json({ error: 'Enter a replacement reason of at least four characters.' });
    const template = documentTemplate(req.body?.template_id, 'ID_CARD');
    if (!template) return res.status(400).json({ error: 'Select a supported ID card design.' });
    const academicYearId = req.body?.academic_year_id || null;
    if (academicYearId && !uuid.test(academicYearId)) return res.status(400).json({ error: 'Invalid academic year.' });
    const cardOptions = validateIdCardOptions(req.body || {});
    let yearLabel = null;
    if (academicYearId) {
      yearLabel = (await db.query('SELECT year_label FROM academic_years WHERE school_id=$1 AND id=$2', [req.params.schoolId, academicYearId])).rows[0]?.year_label;
      if (!yearLabel) return res.status(400).json({ error: 'Academic year does not belong to this school.' });
    }
    const learner = await loadLearnerForCard(req.params.schoolId, req.params.learnerId, academicYearId, yearLabel);
    if (!learner) return res.status(404).json({ error: 'Active learner not found in this school.' });
    const { card } = await issueOrReprintIdCard(req, learner, 'LEARNER', template, academicYearId, true, null, reason, cardOptions);
    res.status(201).json({ card_reference: card.card_reference, status: card.status });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Replace learner ID card failed:', error); res.status(500).json({ error: 'Unable to replace learner ID card.' });
  }
});

router.post('/:schoolId/id-cards/:cardId/revoke', schoolBoundary, roles(...ISSUE), async (req, res) => {
  const client = await db.pool.connect();
  try {
    if (!uuid.test(req.params.cardId)) return res.status(400).json({ error: 'Invalid ID card.' });
    const reason = clean(req.body?.reason, 500);
    if (reason.length < 4) return res.status(400).json({ error: 'Enter a revocation reason of at least four characters.' });
    await client.query('BEGIN');
    const result = await client.query(`UPDATE school_learner_cards SET status='REVOKED', revoked_by=$3, revoked_at=now(), revocation_reason=$4, updated_at=now() WHERE school_id=$1 AND id=$2 AND status='ACTIVE' RETURNING card_reference`, [req.params.schoolId, req.params.cardId, req.user.user_id, reason]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Active ID card not found.' }); }
    await client.query(`INSERT INTO audit_log(school_id, user_id, action, entity_type, entity_id, details) VALUES($1,$2,'LEARNER_ID_CARD_REVOKED','school_learner_card',$3,$4::jsonb)`, [req.params.schoolId, req.user.user_id, req.params.cardId, JSON.stringify({ card_reference: result.rows[0].card_reference, reason })]);
    await client.query('COMMIT'); res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Revoke ID card failed:', error); res.status(500).json({ error: 'Unable to revoke ID card.' });
  } finally { client.release(); }
});

module.exports = router;
