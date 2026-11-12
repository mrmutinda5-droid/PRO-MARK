'use strict';

const express = require('express');
const db = require('../db');
const { authenticate, roles, schoolBoundary } = require('../middleware/auth');
const {
  getOptions,
  buildMerit,
  buildCompleteness,
  buildAnalytics,
  buildAnalysisCsv,
  invalidateResultsCaches
} = require('../services/results-engine');
const { buildMeritPdf } = require('../services/merit-pdf');

const router = express.Router();
router.use(authenticate);

const ALLOWED = [
  'SCHOOL_ADMIN', 'ADMIN', 'HEADTEACHER', 'DEPUTY_HEADTEACHER',
  'SENIOR_TEACHER', 'CLASS_TEACHER', 'TEACHER'
];

function canSeeAll(req) {
  return !['CLASS_TEACHER', 'TEACHER'].includes(req.user.role);
}

async function assignedClassIds(sid, userId) {
  const queries = [
    `SELECT DISTINCT cta.class_id
     FROM class_teacher_assignments cta
     JOIN teachers th ON th.id=cta.teacher_id AND th.school_id=cta.school_id
     WHERE cta.school_id=$1 AND th.user_id=$2 AND COALESCE(th.is_active,true)=true`,
    `SELECT DISTINCT tsa.class_id
     FROM teacher_subject_assignments tsa
     JOIN teachers th ON th.id=tsa.teacher_id AND th.school_id=tsa.school_id
     WHERE tsa.school_id=$1 AND th.user_id=$2 AND COALESCE(th.is_active,true)=true
       AND COALESCE(tsa.is_active,true)=true`
  ];
  const ids = new Set();
  for (const sql of queries) {
    try {
      const rows = (await db.query(sql, [sid, userId])).rows;
      for (const row of rows) {
        if (row.class_id) ids.add(String(row.class_id));
      }
    } catch (error) {
      if (error.code !== '42P01' && error.code !== '42703') throw error;
    }
  }
  return [...ids];
}

async function enforceScope(req, classId) {
  if (canSeeAll(req)) return;
  if (!classId) {
    throw Object.assign(new Error('Select one of your assigned classes.'), { status: 400 });
  }
  const allowed = await assignedClassIds(req.params.schoolId, req.user.user_id);
  if (!allowed.includes(String(classId))) {
    throw Object.assign(new Error('You can only view results for classes you are assigned to.'), { status: 403 });
  }
}

function fail(res, error) {
  const status = error.status || 400;
  res.status(status).json({ error: error.message || 'Unable to load results.' });
}

router.get('/:schoolId/options', schoolBoundary, roles(...ALLOWED), async (req, res) => {
  try {
    const options = await getOptions(req.params.schoolId, req.query);
    if (!canSeeAll(req)) {
      const allowed = await assignedClassIds(req.params.schoolId, req.user.user_id);
      options.classes = options.classes.filter(c => allowed.includes(String(c.id)));
    }
    options.can_see_all = canSeeAll(req);
    res.json(options);
  } catch (error) { fail(res, error); }
});

router.get('/:schoolId/completeness', schoolBoundary, roles(...ALLOWED), async (req, res) => {
  try {
    await enforceScope(req, req.query.class_id);
    res.json(await buildCompleteness(req.params.schoolId, req.query));
  } catch (error) { fail(res, error); }
});

router.get('/:schoolId/merit', schoolBoundary, roles(...ALLOWED), async (req, res) => {
  try {
    await enforceScope(req, req.query.class_id);
    res.json(await buildMerit(req.params.schoolId, req.query));
  } catch (error) { fail(res, error); }
});

router.get('/:schoolId/analytics', schoolBoundary, roles(...ALLOWED), async (req, res) => {
  try {
    await enforceScope(req, req.query.class_id);
    res.json(await buildAnalytics(req.params.schoolId, req.query));
  } catch (error) { fail(res, error); }
});

router.post('/:schoolId/refresh', schoolBoundary, roles(...ALLOWED), (req, res) => {
  invalidateResultsCaches();
  res.json({ ok: true });
});

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

router.get('/:schoolId/merit.csv', schoolBoundary, roles(...ALLOWED), async (req, res) => {
  try {
    await enforceScope(req, req.query.class_id);
    const merit = await buildMerit(req.params.schoolId, req.query);
    const subjects = merit.subjects || [];
    const header = [
      'Rank', 'Admission No', 'Assessment No', 'Learner', 'Class',
      ...subjects.map(s => s.subject_name),
      'Total', 'Average', 'Grade', 'Class Position', 'Overall Position'
    ];
    const lines = [header.map(csvCell).join(',')];
    merit.rows.forEach((row, index) => {
      const bySubject = new Map(row.subjects.map(s => [String(s.subject_id), s]));
      const values = [
        row.overall_rank ?? (row.average == null ? '' : index + 1),
        row.admission_no || '',
        row.assessment_no || '',
        row.name || '',
        row.class_name || '',
        ...subjects.map(s => {
          const found = bySubject.get(String(s.subject_id));
          return found && found.average != null ? found.average : '';
        }),
        row.total ?? '',
        row.average ?? '',
        row.grade || '',
        row.stream_rank ?? '',
        row.overall_rank ?? ''
      ];
      lines.push(values.map(csvCell).join(','));
    });
    const context = merit.context || {};
    const filename = `merit-${String(context.year_label || 'year').replace(/\W+/g, '-')}-${String(context.term_name || 'term').replace(/\W+/g, '-')}${context.class_name ? '-' + String(context.class_name).replace(/\W+/g, '-') : ''}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\ufeff' + lines.join('\r\n'));
  } catch (error) { fail(res, error); }
});

router.get('/:schoolId/analysis.csv', schoolBoundary, roles(...ALLOWED), async (req, res) => {
  try {
    await enforceScope(req, req.query.class_id);
    const analytics = await buildAnalytics(req.params.schoolId, req.query);
    const ctx = analytics.context || {};
    const filename = `analysis-${String(ctx.year_label || 'year').replace(/\W+/g, '-')}-${String(ctx.term_name || 'term').replace(/\W+/g, '-')}${ctx.class_name ? '-' + String(ctx.class_name).replace(/\W+/g, '-') : ''}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\ufeff' + buildAnalysisCsv(analytics));
  } catch (error) { fail(res, error); }
});

router.get('/:schoolId/merit.pdf', schoolBoundary, roles(...ALLOWED), async (req, res) => {
  try {
    await enforceScope(req, req.query.class_id);
    const sid = req.params.schoolId;
    const merit = await buildMerit(sid, req.query);
    const meta = (await db.query(
      `SELECT s.name school_name,si.logo_url,si.motto,si.address,si.contact_phone,si.contact_email,
              si.primary_color,si.secondary_color,si.watermark_enabled
       FROM schools s LEFT JOIN school_identity si ON si.school_id=s.id
       WHERE s.id=$1`,
      [sid]
    )).rows[0] || {};

    try {
      meta.stamp_url = ((await db.query(
        `SELECT file_url FROM school_document_assets
         WHERE school_id=$1 AND asset_type='STAMP' AND is_active=true
           AND (effective_to IS NULL OR effective_to>=CURRENT_DATE)
         ORDER BY effective_from DESC NULLS LAST,created_at DESC LIMIT 1`,
        [sid]
      )).rows[0] || {}).file_url || null;
    } catch (error) { meta.stamp_url = null; }

    const ctx = merit.context || {};
    const teacherName = row => row ? [row.first_name, row.last_name].filter(Boolean).join(' ').trim() : '';
    try {
      if (ctx.class_id) {
        const ct = (await db.query(
          `SELECT tr.first_name,tr.last_name,tr.signature_url
           FROM class_teacher_assignments cta JOIN teachers tr ON tr.id=cta.teacher_id
           WHERE cta.school_id=$1 AND cta.class_id=$2 AND cta.academic_year_id=$3
             AND (cta.term_id=$4 OR cta.term_id IS NULL) AND tr.is_active=true
           ORDER BY (cta.term_id IS NOT NULL) DESC,cta.created_at DESC LIMIT 1`,
          [sid, ctx.class_id, ctx.academic_year_id, ctx.term_id]
        )).rows[0];
        if (ct) meta.class_teacher = { name: teacherName(ct), signature_url: ct.signature_url };
      }
      const ht = (await db.query(
        `SELECT tr.first_name,tr.last_name,tr.signature_url
         FROM teachers tr LEFT JOIN user_school_roles usr ON usr.user_id=tr.user_id AND usr.school_id=tr.school_id
         WHERE tr.school_id=$1 AND (usr.role='HEADTEACHER' OR tr.imported_role='HEADTEACHER') AND tr.is_active=true
         ORDER BY tr.last_name,tr.first_name LIMIT 1`,
        [sid]
      )).rows[0];
      if (ht) meta.head_teacher = { name: teacherName(ht), signature_url: ht.signature_url };
    } catch (error) { /* certification strip falls back to blank signature lines */ }

    const buffer = await buildMeritPdf(merit, meta);
    const filename = `merit-${String(ctx.year_label || 'year').replace(/\W+/g, '-')}-${String(ctx.term_name || 'term').replace(/\W+/g, '-')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.end(buffer);
  } catch (error) {
    console.error('[results-centre merit pdf]', error);
    if (!res.headersSent) fail(res, error);
  }
});

module.exports = router;
