'use strict';

// One authoritative results pipeline.
//
// Every results surface (command centre, merit list, report cards, analytics,
// publishing) reads the same context and the same scoring path, so a learner
// can never appear with one average on a report card and another on a merit
// list. Mark entry saves invalidate this cache through the existing report
// cache invalidation hook, and the TTL is deliberately short.

const db = require('../db');
const {
  computeRanks,
  averageOf,
  isCatAssessment
} = require('./term-score');

const CACHE_TTL_MS = 8000;
const cache = new Map();

function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = Promise.resolve().then(loader);
  const entry = { value, expires: Infinity };
  cache.set(key, entry);
  value.then(
    () => { if (cache.get(key) === entry) entry.expires = Date.now() + CACHE_TTL_MS; },
    () => { if (cache.get(key) === entry) cache.delete(key); }
  );
  return value;
}

function invalidateResultsCaches() {
  cache.clear();
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 1) {
  const n = finite(value);
  if (n === null) return null;
  const factor = 10 ** digits;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// CURRENT / HISTORICAL / UPCOMING is derived from dates, never from row order
// and never from the label alone. A "2026" year viewed in 2020 is UPCOMING.
function dateState(startDate, endDate, status, fallback = 'PLANNED', today = todayIso()) {
  if (startDate && startDate > today) return 'UPCOMING';
  if (endDate && endDate < today) return 'HISTORICAL';
  if (startDate || endDate) return 'CURRENT';
  const s = String(status || '').toUpperCase();
  if (s === 'ACTIVE') return 'CURRENT';
  if (s === 'CLOSED' || s === 'ARCHIVED') return 'HISTORICAL';
  if (s === 'PLANNED') return 'UPCOMING';
  return fallback;
}

function orderYears(a, b) {
  const na = parseInt(String(a.year_label || '').replace(/\D/g, ''), 10);
  const nb = parseInt(String(b.year_label || '').replace(/\D/g, ''), 10);
  const hasA = Number.isFinite(na);
  const hasB = Number.isFinite(nb);
  if (hasA && hasB && na !== nb) return nb - na;
  if (hasA !== hasB) return hasA ? -1 : 1;
  return String(b.year_label || '').localeCompare(String(a.year_label || ''));
}

async function loadCalendar(schoolId) {
  return cached(`calendar|${schoolId}`, async () => {
    const [yearRows, termRows] = await Promise.all([
      db.query(
        `SELECT id,year_label,to_char(start_date,'YYYY-MM-DD') start_date,
                to_char(end_date,'YYYY-MM-DD') end_date,status
         FROM academic_years WHERE school_id=$1`,
        [schoolId]
      ),
      db.query(
        `SELECT id,academic_year_id,term_no,name,
                to_char(start_date,'YYYY-MM-DD') start_date,
                to_char(end_date,'YYYY-MM-DD') end_date,
                to_char(reopening_date,'YYYY-MM-DD') reopening_date,status
         FROM terms WHERE school_id=$1 ORDER BY term_no`,
        [schoolId]
      )
    ]);
    const today = todayIso();
    const years = yearRows.rows
      .map(row => ({
        ...row,
        state: dateState(row.start_date, row.end_date, row.status, 'PLANNED', today),
        terms: []
      }))
      .sort(orderYears);
    const yearById = new Map(years.map(y => [String(y.id), y]));
    for (const term of termRows.rows) {
      const parent = yearById.get(String(term.academic_year_id));
      if (!parent) continue;
      term.state = dateState(
        term.start_date,
        term.end_date,
        term.status,
        parent.state === 'CURRENT' ? 'CURRENT' : parent.state,
        today
      );
      parent.terms.push(term);
    }
    for (const year of years) {
      year.terms.sort((a, b) => Number(a.term_no || 0) - Number(b.term_no || 0));
    }
    const currentYear =
      years.find(y => y.state === 'CURRENT') ||
      years.find(y => String(y.status).toUpperCase() === 'ACTIVE') ||
      years.find(y => y.state === 'HISTORICAL') ||
      years[0] || null;
    return { today, years, currentYear };
  });
}

function defaultTerm(terms, today) {
  if (!terms.length) return null;
  return (
    terms.find(t => t.state === 'CURRENT') ||
    terms.find(t => String(t.status).toUpperCase() === 'ACTIVE') ||
    [...terms].reverse().find(t => t.end_date && t.end_date < today && t.state === 'HISTORICAL') ||
    terms[0]
  );
}

async function resolveContext(schoolId, query = {}) {
  const calendar = await loadCalendar(schoolId);
  let year = null;
  if (query.academic_year_id) {
    year = calendar.years.find(y => String(y.id) === String(query.academic_year_id));
    if (!year) throw httpError('Selected academic year was not found for this school.', 404);
  }
  year = year || calendar.currentYear;
  if (!year) throw httpError('Create an academic year before using results.', 400);

  const terms = year.terms.slice();
  let term = null;
  if (query.term_id) {
    term = terms.find(t => String(t.id) === String(query.term_id));
    if (!term) throw httpError('Selected term does not belong to the selected academic year.', 400);
  }
  term = term || defaultTerm(terms, calendar.today);

  let previous = null;
  if (term) {
    const index = terms.findIndex(t => String(t.id) === String(term.id));
    if (index > 0) {
      previous = { year, term: terms[index - 1] };
    } else {
      const yearIndex = calendar.years.findIndex(y => String(y.id) === String(year.id));
      const priorYear = calendar.years[yearIndex + 1];
      if (priorYear && priorYear.terms.length) {
        previous = { year: priorYear, term: priorYear.terms[priorYear.terms.length - 1] };
      }
    }
  }

  return {
    schoolId,
    today: calendar.today,
    years: calendar.years,
    year,
    term,
    terms,
    previous,
    yearState: year.state,
    termState: term ? term.state : null,
    isCurrent: year.state === 'CURRENT'
  };
}

async function loadClasses(schoolId) {
  return cached(`classes|${schoolId}`, async () => {
    const rows = (await db.query(
      `SELECT c.id,c.name,c.stream,c.school_level_id,
              sl.name level_name,sl.code level_code,
              ss.name section_name
       FROM classes c
       LEFT JOIN school_levels sl ON sl.id=c.school_level_id
       LEFT JOIN school_sections ss ON ss.id=sl.school_section_id
       WHERE c.school_id=$1 AND COALESCE(c.is_active,true)=true
       ORDER BY sl.sort_order NULLS LAST,c.name,c.stream`,
      [schoolId]
    )).rows;
    return rows.map(row => ({
      ...row,
      label: [row.name, row.stream].filter(Boolean).join(' ')
    }));
  });
}

async function loadLearners(schoolId, yearId, options = {}) {
  const params = [schoolId, yearId, options.classId || null];
  let extra = '';
  if (options.classIds) {
    params.push(options.classIds);
    extra = ` AND COALESCE(le.class_id,l.class_id)=ANY($${params.length}::uuid[])`;
  }
  const rows = (await db.query(
    `SELECT l.id learner_id,l.admission_no,l.assessment_no,
            l.first_name,l.middle_name,l.last_name,l.gender,
            COALESCE(l.is_active,true) is_active,
            COALESCE(le.class_id,l.class_id) class_id
     FROM learners l
     LEFT JOIN LATERAL (
       SELECT e.class_id
       FROM learner_enrollments e
       WHERE e.school_id=l.school_id AND e.learner_id=l.id AND e.academic_year_id=$2
         AND COALESCE(e.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
       ORDER BY (COALESCE(e.status,'ACTIVE')='ACTIVE') DESC,e.enrolled_at DESC
       LIMIT 1
     ) le ON true
     WHERE l.school_id=$1 AND COALESCE(l.is_active,true)=true
       AND ($3::uuid IS NULL OR COALESCE(le.class_id,l.class_id)=$3)${extra}
     ORDER BY l.last_name NULLS LAST,l.first_name NULLS LAST,l.id`,
    params
  )).rows;
  return rows.map(row => ({
    ...row,
    name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ')
  }));
}

async function loadAssessments(schoolId, yearId, termId) {
  return cached(`assessments|${schoolId}|${yearId}|${termId}`, async () => (await db.query(
    `SELECT a.id,a.name,a.assessment_type,a.assessment_order,a.max_mark,a.weight,
            a.class_id,a.subject_id,COALESCE(a.include_in_final,true) include_in_final,
            a.created_at,
            (SELECT count(*)::int FROM marks mx
              WHERE mx.assessment_id=a.id AND mx.school_id=a.school_id) mark_count,
            COALESCE((SELECT ac.include_in_term_average
               FROM assessment_configurations ac
               WHERE ac.school_id=a.school_id AND ac.assessment_id=a.id
               ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.class_id IS NOT NULL) DESC,
                        (ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC
               LIMIT 1),true) include_in_term_average
     FROM assessments a
     WHERE a.school_id=$1 AND a.academic_year_id=$2 AND a.term_id=$3
     ORDER BY a.assessment_order,a.created_at,a.name`,
    [schoolId, yearId, termId]
  )).rows);
}

async function loadMarks(schoolId, yearId, termId, learnerIds) {
  const params = [schoolId, yearId, termId, learnerIds && learnerIds.length ? learnerIds : null];
  return (await db.query(
    `SELECT m.learner_id,m.subject_id,m.assessment_id,m.mark,m.remark,m.updated_at,
            a.name assessment_name,a.assessment_type,a.max_mark,a.weight,a.assessment_order,
            COALESCE((SELECT ac.include_in_term_average
               FROM assessment_configurations ac
               WHERE ac.school_id=m.school_id AND ac.assessment_id=m.assessment_id
                 AND (ac.subject_id=m.subject_id OR ac.subject_id IS NULL)
               ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.class_id IS NOT NULL) DESC,
                        (ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC
               LIMIT 1),true) include_in_term_average
     FROM marks m
     JOIN assessments a ON a.id=m.assessment_id
     WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
       AND m.mark IS NOT NULL
       AND ($4::uuid[] IS NULL OR m.learner_id=ANY($4::uuid[]))`,
    params
  )).rows;
}

async function loadProfiles(schoolId, yearId, termId) {
  try {
    const rows = (await db.query(
      `SELECT class_id,selected_assessment_ids,cat_group_mode,custom_weights
       FROM merit_flex_profiles
       WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3`,
      [schoolId, yearId, termId]
    )).rows;
    return new Map(rows.map(row => [String(row.class_id), row]));
  } catch (error) {
    if (error.code === '42P01' || error.code === '42703') return new Map();
    throw error;
  }
}

async function loadGrading(schoolId) {
  return cached(`grading|${schoolId}`, async () => {
    const bands = (await db.query(
      `SELECT gs.id system_id,gs.code system_code,gs.name system_name,
              gb.label,gb.min_mark,gb.max_mark,gb.points,gb.descriptor,gb.remark
       FROM grading_systems gs
       JOIN grading_bands gb ON gb.grading_system_id=gs.id
       WHERE gs.school_id=$1 AND COALESCE(gs.is_active,true)=true
       ORDER BY gs.id,gb.min_mark DESC`,
      [schoolId]
    )).rows;
    const configs = (await db.query(
      `SELECT class_id,level_id,section_id,grading_system_id
       FROM assessment_configurations
       WHERE school_id=$1 AND grading_system_id IS NOT NULL
       ORDER BY (subject_id IS NOT NULL) DESC,(assessment_id IS NOT NULL) DESC,
                (class_id IS NOT NULL) DESC,(level_id IS NOT NULL) DESC,(section_id IS NOT NULL) DESC`,
      [schoolId]
    )).rows;
    const systems = new Map();
    for (const row of bands) {
      if (!systems.has(String(row.system_id))) {
        systems.set(String(row.system_id), {
          id: row.system_id,
          code: row.system_code,
          name: row.system_name,
          bands: []
        });
      }
      systems.get(String(row.system_id)).bands.push({
        label: row.label,
        min_mark: finite(row.min_mark),
        max_mark: finite(row.max_mark),
        points: row.points,
        descriptor: row.descriptor,
        remark: row.remark
      });
    }
    const defaultSystem =
      [...systems.values()].find(s => String(s.code).toUpperCase() === 'CBC') ||
      [...systems.values()][0] ||
      null;
    return { systems, configs, defaultSystem };
  });
}

// Grades are looked up from the rounded whole-number average. Using the raw
// fractional average against integer bands (0–49, 50–59, …) silently produced
// blank grades for values such as 59.5, so every surface now rounds first.
function bandFor(average, bands) {
  const value = finite(average);
  if (value === null) return null;
  const n = Math.round(value + Number.EPSILON);
  return (bands || []).find(b => n >= Number(b.min_mark) && n <= Number(b.max_mark)) || null;
}

function systemForClass(grading, classRecord) {
  if (!grading) return null;
  const configs = grading.configs || [];
  const match = configs.find(c => c.class_id && String(c.class_id) === String(classRecord.id)) ||
    (classRecord.school_level_id
      ? configs.find(c => !c.class_id && c.level_id && String(c.level_id) === String(classRecord.school_level_id))
      : null) ||
    null;
  const id = match ? String(match.grading_system_id) : null;
  return (id && grading.systems.get(id)) || grading.defaultSystem;
}

async function loadSubjectMeta(schoolId) {
  return cached(`subjects|${schoolId}`, async () => {
    const rows = (await db.query(
      `SELECT id,code,name FROM subjects WHERE school_id=$1 ORDER BY name`,
      [schoolId]
    )).rows;
    return new Map(rows.map(row => [String(row.id), row]));
  });
}

function isPlaceholderTeacher(row) {
  const first = String(row && row.first_name || '').trim().toUpperCase();
  const last = String(row && row.last_name || '').trim().toUpperCase();
  const staff = String(row && row.staff_no || '').trim().toUpperCase();
  return (!first && !last) ||
    ['TEACHER', 'ADMIN'].includes(first) ||
    ['TEACHER', 'ADMIN'].includes(last) ||
    ['TEACHER', 'ADMIN', 'MR.TEACHER', 'MR. TEACHER'].includes(staff);
}

async function loadTeachers(schoolId, yearId, termId, classIds) {
  if (!classIds || !classIds.length) return new Map();
  const rows = (await db.query(
    `SELECT DISTINCT ON (tsa.class_id,tsa.subject_id)
            tsa.class_id,tsa.subject_id,th.first_name,th.last_name,th.staff_no
     FROM teacher_subject_assignments tsa
     JOIN teachers th ON th.id=tsa.teacher_id AND th.school_id=tsa.school_id
     WHERE tsa.school_id=$1 AND tsa.academic_year_id=$2
       AND tsa.class_id=ANY($3::uuid[])
       AND COALESCE(tsa.is_active,true)=true
       AND NOT (upper(trim(coalesce(th.first_name,''))) IN ('TEACHER','ADMIN')
             OR upper(trim(coalesce(th.last_name,''))) IN ('TEACHER','ADMIN')
             OR upper(trim(coalesce(th.staff_no,''))) IN ('TEACHER','ADMIN','MR.TEACHER','MR. TEACHER'))
     ORDER BY tsa.class_id,tsa.subject_id,
              CASE WHEN tsa.term_id=$4 THEN 0 WHEN tsa.term_id IS NULL THEN 1 ELSE 2 END,
              tsa.created_at DESC,tsa.id DESC`,
    [schoolId, yearId, classIds, termId || null]
  )).rows;
  const map = new Map();
  for (const row of rows) {
    if (isPlaceholderTeacher(row)) continue;
    map.set(`${row.class_id}|${row.subject_id}`, [row.first_name, row.last_name].filter(Boolean).join(' '));
  }
  return map;
}

function competitionRanks(items, valueOf) {
  const sorted = [...items].sort((a, b) => {
    const diff = valueOf(b) - valueOf(a);
    if (Math.abs(diff) > 1e-8) return diff;
    return String(a.learner_id).localeCompare(String(b.learner_id));
  });
  const ranks = new Map();
  let previous = null;
  let rank = 0;
  sorted.forEach((item, index) => {
    const value = valueOf(item);
    if (previous === null || Math.abs(value - previous) > 1e-8) {
      rank = index + 1;
      previous = value;
    }
    ranks.set(String(item.learner_id), rank);
  });
  return { sorted, ranks, total: sorted.length };
}

function deviationOf(values) {
  const nums = (values || []).filter(v => v != null && isFinite(Number(v))).map(Number);
  if (!nums.length) return null;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.sqrt(nums.reduce((a, v) => a + (v - mean) ** 2, 0) / nums.length);
}

// Band columns follow the admin-saved order (highest band first), unioning every
// system actually in scope so mixed-class counts never lose a label.
function bandLabelOrder(grading, classRecords) {
  const labels = [];
  const push = system => (system ? system.bands : []).forEach(b => {
    if (b.label && !labels.includes(b.label)) labels.push(b.label);
  });
  if (grading) {
    push(grading.defaultSystem);
    (classRecords || []).forEach(c => push(systemForClass(grading, c)));
    grading.systems.forEach(system => push(system));
  }
  return labels;
}

function countBands(grades, labels) {
  const counts = {};
  (labels || []).forEach(label => { counts[label] = 0; });
  (grades || []).forEach(grade => {
    if (!grade) return;
    counts[grade] = (counts[grade] || 0) + 1;
  });
  return counts;
}

function subjectBucketsOf(rows) {
  const buckets = new Map();
  for (const row of rows || []) {
    for (const subject of row.subjects || []) {
      if (subject.average == null) continue;
      const key = String(subject.subject_id);
      if (!buckets.has(key)) {
        buckets.set(key, {
          subject_id: subject.subject_id,
          subject_code: subject.subject_code || '',
          subject_name: subject.subject_name || 'Subject',
          teacher: '',
          values: [],
          grades: []
        });
      }
      const bucket = buckets.get(key);
      bucket.values.push(Number(subject.average));
      bucket.grades.push(subject.grade || '');
      if (!bucket.teacher && subject.teacher) bucket.teacher = subject.teacher;
    }
  }
  return buckets;
}

function buildSubjectAnalysis(currentRows, previousRows, labels, scopeBands, passMark) {
  const previous = subjectBucketsOf(previousRows);
  const pass = finite(passMark) ?? 50;
  return [...subjectBucketsOf(currentRows).values()].map(bucket => {
    const mean = averageOf(bucket.values);
    const band = bandFor(mean, scopeBands);
    const prior = previous.get(String(bucket.subject_id));
    const priorMean = prior ? averageOf(prior.values) : null;
    return {
      subject_id: bucket.subject_id,
      subject_code: bucket.subject_code,
      subject_name: bucket.subject_name,
      teacher: bucket.teacher,
      mean: round(mean, 2),
      grade: band ? band.label : '',
      high: round(Math.max(...bucket.values), 2),
      low: round(Math.min(...bucket.values), 2),
      pass: round((bucket.values.filter(v => v >= pass).length / bucket.values.length) * 100, 1),
      dev: round(deviationOf(bucket.values), 1),
      delta: priorMean == null ? null : round(mean - priorMean, 2),
      counts: countBands(bucket.grades, labels),
      scored: bucket.values.length
    };
  }).sort((a, b) => b.mean - a.mean || a.subject_name.localeCompare(b.subject_name));
}

function buildClassBands(currentRows, classList, labels) {
  return (classList || []).map(entry => {
    const rows = (currentRows || []).filter(r => (r.class_name || 'Unassigned') === entry.name);
    const graded = rows.filter(r => r.average != null);
    const mean = averageOf(graded.map(r => r.average));
    const band = mean == null ? null : bandFor(mean, entry.bands);
    const subjects = [...subjectBucketsOf(rows).values()].map(bucket => {
      const subjectMean = averageOf(bucket.values);
      const subjectBand = bandFor(subjectMean, entry.bands);
      return {
        subject_id: bucket.subject_id,
        subject_code: bucket.subject_code,
        subject_name: bucket.subject_name,
        counts: countBands(bucket.grades, labels),
        scored: bucket.values.length,
        mean: round(subjectMean, 2),
        grade: subjectBand ? subjectBand.label : ''
      };
    }).sort((a, b) => a.subject_name.localeCompare(b.subject_name));
    return {
      class_name: entry.name,
      subjects,
      average_counts: countBands(graded.map(r => r.grade), labels),
      scored: graded.length,
      mean: round(mean, 2),
      grade: band ? band.label : ''
    };
  }).filter(entry => entry.scored > 0 || entry.subjects.length);
}

function buildSubjectToppers(rows) {
  const tops = new Map();
  for (const row of rows || []) {
    for (const subject of row.subjects || []) {
      if (subject.average == null) continue;
      const key = String(subject.subject_id);
      const current = tops.get(key);
      if (!current || subject.average > current.average) {
        tops.set(key, {
          subject_id: subject.subject_id,
          subject_code: subject.subject_code || '',
          subject_name: subject.subject_name || 'Subject',
          name: row.name,
          class_name: row.class_name || '',
          average: round(subject.average, 2),
          grade: subject.grade || ''
        });
      }
    }
  }
  return [...tops.values()].sort((a, b) => a.subject_name.localeCompare(b.subject_name));
}

function buildTeacherRows(subjectAnalysis) {
  const byTeacher = new Map();
  (subjectAnalysis || []).forEach(subject => {
    if (!subject.teacher) return;
    if (!byTeacher.has(subject.teacher)) byTeacher.set(subject.teacher, []);
    byTeacher.get(subject.teacher).push(subject.mean);
  });
  return [...byTeacher.entries()]
    .map(([teacher, means]) => ({ teacher, mean: round(averageOf(means), 2), subjects: means.length }))
    .sort((a, b) => b.mean - a.mean || a.teacher.localeCompare(b.teacher));
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}


function pointsForBand(labelOrMark, bands) {
  if (labelOrMark == null || !bands || !bands.length) return null;
  if (typeof labelOrMark === 'string') {
    const found = bands.find(b => b.label && b.label.toLowerCase() === labelOrMark.toLowerCase());
    if (found && found.points != null && isFinite(Number(found.points))) {
      return Number(found.points);
    }
  }
  const num = Number(labelOrMark);
  if (isFinite(num)) {
    const band = bandFor(num, bands);
    if (band && band.points != null && isFinite(Number(band.points))) {
      return Number(band.points);
    }
  }
  return null;
}

function calculateMeanPoints(rows, bands) {
  const pts = (rows || []).map(r => {
    if (r.points != null && r.points !== '' && isFinite(Number(r.points))) {
      return Number(r.points);
    }
    return pointsForBand(r.grade || r.average, bands);
  }).filter(p => p != null && isFinite(p));
  return pts.length ? round(averageOf(pts), 2) : null;
}

function isHighMastery(row, bands) {
  const g = (row.grade || '').toUpperCase();
  if (g.startsWith('EE') || g === 'A' || g === 'A-') return true;
  const p = Number(row.points != null && row.points !== '' ? row.points : pointsForBand(row.grade || row.average, bands));
  return isFinite(p) && p >= 7;
}

function isCompetencyPass(row, bands, passMark = 50) {
  const g = (row.grade || '').toUpperCase();
  if (g.startsWith('EE') || g.startsWith('ME') || ['A', 'A-', 'B+', 'B', 'B-', 'C+'].includes(g)) return true;
  const p = Number(row.points != null && row.points !== '' ? row.points : pointsForBand(row.grade || row.average, bands));
  if (isFinite(p) && p >= 5) return true;
  return row.average != null && row.average >= passMark;
}

function calculateQualityIndices(rows, bands, passMark = 50) {
  const valid = (rows || []).filter(r => r.average != null);
  const total = valid.length;
  if (!total) {
    return {
      high_mastery_count: 0, high_mastery_pct: 0,
      quality_pass_count: 0, quality_pass_pct: 0,
      remediation_count: 0, remediation_pct: 0,
      total_candidates: 0
    };
  }
  let highMastery = 0;
  let qualityPass = 0;
  for (const r of valid) {
    if (isHighMastery(r, bands)) highMastery++;
    if (isCompetencyPass(r, bands, passMark)) qualityPass++;
  }
  const remediation = total - qualityPass;
  return {
    high_mastery_count: highMastery,
    high_mastery_pct: round((highMastery / total) * 100, 1),
    quality_pass_count: qualityPass,
    quality_pass_pct: round((qualityPass / total) * 100, 1),
    remediation_count: remediation,
    remediation_pct: round((remediation / total) * 100, 1),
    total_candidates: total
  };
}

function normalizeGender(g) {
  if (!g) return 'other';
  const val = String(g).trim().toLowerCase();
  if (val === 'm' || val === 'male' || val === 'boy') return 'male';
  if (val === 'f' || val === 'female' || val === 'girl') return 'female';
  return 'other';
}

function buildStreamComparison(currentRows, previousRows, classList, labels, defaultBands, passMark = 50) {
  const prevByClass = new Map();
  for (const r of (previousRows || []).filter(r => r.average != null)) {
    const k = r.class_name || 'Unassigned';
    if (!prevByClass.has(k)) prevByClass.set(k, []);
    prevByClass.get(k).push(r.average);
  }

  const streams = (classList || []).map(entry => {
    const cBands = (entry.bands && entry.bands.length) ? entry.bands : defaultBands;
    const rows = (currentRows || []).filter(r => (r.class_name || 'Unassigned') === entry.name);
    const graded = rows.filter(r => r.average != null);
    const mean = averageOf(graded.map(r => r.average));
    const meanPoints = calculateMeanPoints(graded, cBands);
    const band = mean == null ? null : bandFor(mean, cBands);
    const prevAverages = prevByClass.get(entry.name);
    const priorMean = prevAverages && prevAverages.length ? averageOf(prevAverages) : null;
    const quality = calculateQualityIndices(graded, cBands, passMark);

    const boys = graded.filter(r => normalizeGender(r.gender) === 'male');
    const girls = graded.filter(r => normalizeGender(r.gender) === 'female');

    const topLearners = [...graded]
      .sort((a, b) => b.average - a.average)
      .slice(0, 3)
      .map(r => ({ name: r.name, admission_no: r.admission_no, average: r.average, grade: r.grade }));

    const atRiskLearners = [...graded]
      .filter(r => r.average < (passMark || 50))
      .sort((a, b) => a.average - b.average)
      .slice(0, 3)
      .map(r => ({ name: r.name, admission_no: r.admission_no, average: r.average, grade: r.grade }));

    return {
      stream_name: entry.name,
      enrolled: rows.length,
      scored: graded.length,
      mean: round(mean, 2),
      mean_points: meanPoints,
      grade: band ? band.label : '',
      delta: priorMean == null || mean == null ? null : round(mean - priorMean, 2),
      deviation: round(deviationOf(graded.map(r => r.average)), 1),
      counts: countBands(graded.map(r => r.grade), labels),
      quality_pass_pct: quality.quality_pass_pct,
      high_mastery_pct: quality.high_mastery_pct,
      remediation_pct: quality.remediation_pct,
      gender: {
        boys: {
          count: boys.length,
          mean: boys.length ? round(averageOf(boys.map(r => r.average)), 2) : null,
          mean_points: calculateMeanPoints(boys, cBands)
        },
        girls: {
          count: girls.length,
          mean: girls.length ? round(averageOf(girls.map(r => r.average)), 2) : null,
          mean_points: calculateMeanPoints(girls, cBands)
        }
      },
      top_learners: topLearners,
      at_risk: atRiskLearners
    };
  }).filter(s => s.scored > 0 || s.enrolled > 0);

  return streams
    .sort((a, b) => (b.mean ?? -Infinity) - (a.mean ?? -Infinity) || a.stream_name.localeCompare(b.stream_name))
    .map((s, index) => ({ rank: index + 1, ...s }));
}

function buildGenderAnalysis(currentRows, labels, bands, passMark = 50) {
  const graded = (currentRows || []).filter(r => r.average != null);
  const boys = graded.filter(r => normalizeGender(r.gender) === 'male');
  const girls = graded.filter(r => normalizeGender(r.gender) === 'female');

  const boysMean = boys.length ? round(averageOf(boys.map(r => r.average)), 2) : null;
  const girlsMean = girls.length ? round(averageOf(girls.map(r => r.average)), 2) : null;
  const boysPoints = calculateMeanPoints(boys, bands);
  const girlsPoints = calculateMeanPoints(girls, bands);
  const boysQuality = calculateQualityIndices(boys, bands, passMark);
  const girlsQuality = calculateQualityIndices(girls, bands, passMark);

  const boysGrades = countBands(boys.map(r => r.grade), labels);
  const girlsGrades = countBands(girls.map(r => r.grade), labels);
  const bandDistribution = (labels || []).map(label => ({
    label,
    boys: boysGrades[label] || 0,
    girls: girlsGrades[label] || 0,
    total: (boysGrades[label] || 0) + (girlsGrades[label] || 0)
  }));

  const subjectMap = new Map();
  for (const row of currentRows || []) {
    const g = normalizeGender(row.gender);
    for (const s of row.subjects || []) {
      if (s.average == null) continue;
      const key = String(s.subject_id);
      if (!subjectMap.has(key)) {
        subjectMap.set(key, {
          subject_id: s.subject_id,
          subject_code: s.subject_code || '',
          subject_name: s.subject_name || 'Subject',
          boys: [],
          girls: []
        });
      }
      const item = subjectMap.get(key);
      if (g === 'male') item.boys.push(Number(s.average));
      else if (g === 'female') item.girls.push(Number(s.average));
    }
  }

  const subjects = [...subjectMap.values()].map(s => {
    const bMean = s.boys.length ? round(averageOf(s.boys), 2) : null;
    const gMean = s.girls.length ? round(averageOf(s.girls), 2) : null;
    const gap = bMean != null && gMean != null ? round(bMean - gMean, 2) : null;
    return {
      subject_id: s.subject_id,
      subject_code: s.subject_code,
      subject_name: s.subject_name,
      boys_count: s.boys.length,
      boys_mean: bMean,
      girls_count: s.girls.length,
      girls_mean: gMean,
      gap
    };
  }).sort((a, b) => a.subject_name.localeCompare(b.subject_name));

  return {
    summary: {
      boys: {
        count: boys.length,
        mean: boysMean,
        mean_points: boysPoints,
        quality_pass_pct: boysQuality.quality_pass_pct,
        high_mastery_pct: boysQuality.high_mastery_pct
      },
      girls: {
        count: girls.length,
        mean: girlsMean,
        mean_points: girlsPoints,
        quality_pass_pct: girlsQuality.quality_pass_pct,
        high_mastery_pct: girlsQuality.high_mastery_pct
      },
      gap: boysMean != null && girlsMean != null ? round(boysMean - girlsMean, 2) : null,
      points_gap: boysPoints != null && girlsPoints != null ? round(boysPoints - girlsPoints, 2) : null
    },
    bands: bandDistribution,
    subjects
  };
}

function buildInterventionQuadrants(currentRows, bands, passMark = 50) {
  const pm = passMark ?? 50;
  const highFlyers = [];
  const solidCore = [];
  const bottleneckStrugglers = [];
  const urgentIntervention = [];

  for (const r of (currentRows || [])) {
    if (r.average == null) continue;
    const subjects = (r.subjects || []).filter(s => s.average != null);
    const failedSubjects = subjects.filter(s => s.average < pm).map(s => ({
      subject_id: s.subject_id,
      subject_name: s.subject_name || s.subject_code,
      average: s.average,
      grade: s.grade
    }));

    const item = {
      learner_id: r.learner_id,
      name: r.name,
      admission_no: r.admission_no,
      class_name: r.class_name,
      average: r.average,
      grade: r.grade,
      failed_subjects_count: failedSubjects.length
    };

    if (isHighMastery(r, bands) && failedSubjects.length === 0) {
      highFlyers.push(item);
    } else if (r.average < 40 || failedSubjects.length >= 3) {
      urgentIntervention.push({ ...item, failing_subjects: failedSubjects });
    } else if (r.average >= pm && failedSubjects.length > 0) {
      bottleneckStrugglers.push({ ...item, bottlenecks: failedSubjects });
    } else {
      solidCore.push(item);
    }
  }

  return {
    counts: {
      high_flyers: highFlyers.length,
      solid_core: solidCore.length,
      bottleneck_strugglers: bottleneckStrugglers.length,
      urgent_intervention: urgentIntervention.length
    },
    high_flyers: highFlyers.sort((a, b) => b.average - a.average).slice(0, 15),
    solid_core: solidCore.sort((a, b) => b.average - a.average).slice(0, 15),
    bottleneck_strugglers: bottleneckStrugglers.sort((a, b) => b.average - a.average).slice(0, 15),
    urgent_intervention: urgentIntervention.sort((a, b) => a.average - b.average).slice(0, 15)
  };
}

function buildAnalysisCsv(analytics) {
  const a = analytics || {};
  const k = a.kpis || {};
  const ctx = a.context || {};
  const labels = a.band_labels || [];
  const subjects = a.subject_columns || a.subjects || [];
  const line = values => values.map(csvCell).join(',');
  const bandValues = counts => labels.map(label => (counts || {})[label] || 0);
  const out = [
    'OFFICIAL PERFORMANCE ANALYSIS',
    line(['Context', ctx.year_label || '', ctx.term_name || '', ctx.class_name || 'All classes']),
    line(['Mean', k.mean, 'Mean grade', k.mean_grade, 'Deviation', k.deviation,
      'Value addition', k.value_addition, 'Pass rate %', k.pass_rate, 'Pass mark', k.pass_mark, 'Ranked', k.learners]),
    '',
    line(['SUBJECT', 'TEACHER', 'MEAN', 'GRADE', 'HIGH', 'LOW', 'PASS %', 'DEVIATION', 'DELTA PREV', ...labels, 'SCORED']),
    ...(a.subject_analysis || []).map(s => line([
      s.subject_name, s.teacher, s.mean, s.grade, s.high, s.low, s.pass, s.dev, s.delta, ...bandValues(s.counts), s.scored
    ])),
    '',
    line(['CLASS', 'SUBJECT', ...labels, 'SCORED', 'MEAN', 'GRADE']),
    ...(a.class_bands || []).flatMap(c => [
      ...c.subjects.map(s => line([c.class_name, s.subject_name, ...bandValues(s.counts), s.scored, s.mean, s.grade])),
      line([c.class_name, 'AVERAGE', ...bandValues(c.average_counts), c.scored, c.mean, c.grade])
    ]),
    '',
    line(['RANK', 'LEARNER', 'ADM', 'CLASS',
      ...subjects.flatMap(s => [(s.subject_code || s.subject_name) + ' MARK', (s.subject_code || s.subject_name) + ' GRADE']),
      'AVERAGE', 'GRADE']),
    ...(a.register || []).map((row, index) => {
      const byId = new Map((row.subjects || []).map(s => [String(s.subject_id), s]));
      return line([
        row.stream_rank ?? (row.average == null ? '' : index + 1),
        row.name, row.admission_no || '', row.class_name || '',
        ...subjects.flatMap(s => {
          const found = byId.get(String(s.subject_id));
          return [found && found.average != null ? found.average : '', found && found.average != null ? found.grade || '' : ''];
        }),
        row.average ?? '', row.grade || ''
      ]);
    }),
    '',
    line(['LEARNER', 'CLASS', 'CURRENT', 'PREVIOUS', 'CHANGE', 'GRADE', 'STATUS']),
    ...(a.movement_rows || []).map(m => line([m.name, m.class_name || '', m.average, m.previous, m.delta, m.grade || '', m.status]))
  ];
  return out.join('\r\n');
}

async function buildMerit(schoolId, query = {}, options = {}) {
  const ctx = options.ctx || await resolveContext(schoolId, query);
  const { year, term } = ctx;
  if (!term) throw httpError('No term has been created for the selected academic year.', 400);
  const classId = query.class_id || null;
  const assessmentId = query.assessment_id || null;
  const assessmentType = query.assessment_type
    ? String(query.assessment_type).trim().toUpperCase()
    : null;
  const peers = options.peers !== false;
  const classes = await loadClasses(schoolId);

  let selectedClass = null;
  if (classId) {
    selectedClass = classes.find(c => String(c.id) === String(classId));
    if (!selectedClass) throw httpError('Selected class was not found.', 404);
  }

  if (assessmentId) {
    const exists = (await db.query(
      `SELECT 1 FROM assessments WHERE id=$1 AND school_id=$2 AND academic_year_id=$3 AND term_id=$4`,
      [assessmentId, schoolId, year.id, term.id]
    )).rows[0];
    if (!exists) throw httpError('Selected assessment was not found for this school, year and term.', 404);
  }

  // Overall position needs every learner in the same level, so a class merit
  // list loads its peer classes too. Analytics can opt out to stay fast.
  let learners;
  if (peers && selectedClass) {
    const peerClassIds = classes
      .filter(c => String(c.school_level_id || '') === String(selectedClass.school_level_id || ''))
      .map(c => c.id);
    learners = await loadLearners(schoolId, year.id, {
      classIds: peerClassIds.length ? peerClassIds : [selectedClass.id]
    });
  } else {
    learners = await loadLearners(schoolId, year.id, { classId });
  }

  const learnerIds = learners.map(l => l.learner_id);
  const [assessments, marks, profiles, grading, subjectMeta] = await Promise.all([
    loadAssessments(schoolId, year.id, term.id),
    loadMarks(schoolId, year.id, term.id, learnerIds),
    loadProfiles(schoolId, year.id, term.id),
    loadGrading(schoolId),
    loadSubjectMeta(schoolId)
  ]);

  const classById = new Map(classes.map(c => [String(c.id), c]));
  const teacherMap = await loadTeachers(
    schoolId, year.id, term.id,
    [...new Set(learners.map(l => l.class_id).filter(Boolean).map(String))]
  );

  // A single assessment or a whole assessment type can define the reproduction
  // basis. Selecting "CAT" groups every continuous assessment test, otherwise
  // the type is matched exactly (OPENER, MID_TERM, END_TERM, …).
  const scopedAssessments = assessmentId
    ? assessments.filter(a => String(a.id) === String(assessmentId))
    : assessmentType
      ? assessments.filter(a => assessmentType === 'CAT'
          ? isCatAssessment(a)
          : String(a.assessment_type || '').trim().toUpperCase() === assessmentType)
      : assessments;

  const ranked = computeRanks({
    learners: learners.map(l => ({
      learner_id: l.learner_id,
      class_id: l.class_id,
      class_name: classById.get(String(l.class_id))?.label || ''
    })),
    marks,
    assessments: scopedAssessments,
    profilesByClass: profiles,
    classes: classes.map(c => ({ id: c.id, name: c.label }))
  });

  const learnerById = new Map(learners.map(l => [String(l.learner_id), l]));
  const rows = [];
  for (const [learnerId, computed] of ranked) {
    const learner = learnerById.get(String(learnerId));
    if (!learner) continue;
    const classRecord = classById.get(String(computed.class_id)) || null;
    const system = systemForClass(grading, classRecord || { id: computed.class_id });
    const bands = system ? system.bands : [];
    const subjectRows = [];
    for (const subject of computed.subjects) {
      const meta = subjectMeta.get(String(subject.subject_id)) || {};
      const band = bandFor(subject.average, bands);
      const subjectRank = (computed.subject_ranks || {})[String(subject.subject_id)] || null;
      subjectRows.push({
        subject_id: subject.subject_id,
        subject_code: meta.code || '',
        subject_name: meta.name || 'Subject',
        average: round(subject.average, 2),
        grade: band ? band.label : '',
        points: band ? band.points : '',
        basis: subject.basis,
        rank: subjectRank ? subjectRank.rank : null,
        rank_total: subjectRank ? subjectRank.total : null,
        teacher: teacherMap.get(`${computed.class_id}|${subject.subject_id}`) || ''
      });
    }
    subjectRows.sort((a, b) =>
      b.average - a.average || a.subject_name.localeCompare(b.subject_name));
    const average = computed.overall_average;
    const band = bandFor(average, bands);
    rows.push({
      learner_id: learner.learner_id,
      admission_no: learner.admission_no,
      assessment_no: learner.assessment_no,
      name: learner.name,
      first_name: learner.first_name,
      last_name: learner.last_name,
      gender: learner.gender || '',
      is_active: learner.is_active,
      class_id: computed.class_id,
      class_name: classRecord ? classRecord.label : (computed.class_name || ''),
      level_id: classRecord ? classRecord.school_level_id : null,
      subjects: subjectRows,
      total: round(subjectRows.reduce((sum, s) => sum + Number(s.average || 0), 0), 2),
      average: round(average, 2),
      grade: band ? band.label : '',
      points: band ? band.points : '',
      stream_rank: computed.stream_rank ?? null,
      stream_rank_total: computed.stream_rank_total ?? null,
      overall_rank: null,
      overall_rank_total: null
    });
  }

  // Overall position is computed across the whole level (all streams), using
  // the same competition ranking the report card uses.
  const levelPools = new Map();
  for (const row of rows) {
    if (row.average === null) continue;
    const key = selectedClass ? String(row.level_id || '') : '__scope__';
    if (!levelPools.has(key)) levelPools.set(key, []);
    levelPools.get(key).push(row);
  }
  for (const pool of levelPools.values()) {
    const { ranks, total } = competitionRanks(pool, row => row.average);
    for (const row of pool) {
      row.overall_rank = ranks.get(String(row.learner_id)) ?? null;
      row.overall_rank_total = total;
    }
  }

  rows.sort((a, b) =>
    (b.average ?? -1) - (a.average ?? -1) ||
    String(a.name).localeCompare(String(b.name)));

  const displayRows = selectedClass
    ? rows.filter(row => String(row.class_id) === String(selectedClass.id))
    : rows;

  const scored = displayRows.filter(row => row.average !== null);
  const mean = averageOf(scored.map(row => row.average));
  const passMark = finite(query.pass_mark) ?? 50;
  const passCount = scored.filter(row => row.average >= passMark).length;
  const gradingSystem = selectedClass
    ? systemForClass(grading, selectedClass)
    : grading.defaultSystem;
  const meanBand = mean === null ? null : bandFor(mean, gradingSystem ? gradingSystem.bands : []);

  const subjectRankings = [];
  const subjectBuckets = new Map();
  for (const row of scored) {
    for (const subject of row.subjects) {
      if (!subjectBuckets.has(String(subject.subject_id))) {
        subjectBuckets.set(String(subject.subject_id), {
          subject_id: subject.subject_id,
          subject_code: subject.subject_code,
          subject_name: subject.subject_name,
          teacher: subject.teacher,
          values: []
        });
      }
      subjectBuckets.get(String(subject.subject_id)).values.push(subject);
    }
  }
  for (const bucket of subjectBuckets.values()) {
    const average = averageOf(bucket.values.map(v => v.average));
    const band = bandFor(average, gradingSystem ? gradingSystem.bands : []);
    subjectRankings.push({
      subject_id: bucket.subject_id,
      subject_code: bucket.subject_code,
      subject_name: bucket.subject_name,
      average: round(average, 2),
      grade: band ? band.label : '',
      points: band ? band.points : '',
      teacher: bucket.teacher || '',
      learners: bucket.values.length
    });
  }
  subjectRankings.sort((a, b) => b.average - a.average || a.subject_name.localeCompare(b.subject_name));

  const subjectColumns = [];
  const subjectColumnMap = new Map();
  for (const row of displayRows) {
    for (const subject of row.subjects) {
      if (!subjectColumnMap.has(String(subject.subject_id))) {
        const column = {
          subject_id: subject.subject_id,
          subject_code: subject.subject_code,
          subject_name: subject.subject_name
        };
        subjectColumnMap.set(String(subject.subject_id), column);
        subjectColumns.push(column);
      }
    }
  }
  subjectColumns.sort((a, b) => a.subject_name.localeCompare(b.subject_name));

  let diagnostics = null;
  if (!scored.length) {
    diagnostics = await diagnoseEmpty(schoolId, year.id, term.id, selectedClass, assessmentId, assessmentType);
  }

  const assessmentLabel = assessmentId
    ? (assessments.find(a => String(a.id) === String(assessmentId))?.name || 'Selected assessment')
    : assessmentType === 'CAT' ? 'All CATs'
      : assessmentType ? assessmentType.replace(/_/g, ' ')
        : 'All assessments (term score)';

  return {
    context: {
      school_id: schoolId,
      academic_year_id: year.id,
      year_label: year.year_label,
      year_state: year.state,
      term_id: term.id,
      term_name: term.name,
      term_no: term.term_no,
      term_state: term.state,
      class_id: selectedClass ? selectedClass.id : null,
      class_name: selectedClass ? selectedClass.label : '',
      assessment_id: assessmentId || null,
      assessment_type: assessmentType || null,
      assessment_label: assessmentLabel,
      is_current: year.state === 'CURRENT'
    },
    rows: displayRows,
    subjects: subjectColumns,
    subject_rankings: subjectRankings,
    subject_toppers: buildSubjectToppers(displayRows),
    stats: {
      learners: displayRows.length,
      ranked: scored.length,
      mean: round(mean, 2),
      mean_grade: meanBand ? meanBand.label : '',
      top: scored.length ? round(scored[0].average, 2) : null,
      lowest: scored.length ? round(scored[scored.length - 1].average, 2) : null,
      pass_mark: passMark,
      pass_rate: scored.length ? round((passCount / scored.length) * 100, 1) : null
    },
    diagnostics
  };
}

async function diagnoseEmpty(schoolId, yearId, termId, classRecord, assessmentId, assessmentType) {
  try {
    if (!classRecord) return 'No learner in this school has a usable mark for the selected year and term.';
    const classId = classRecord.id;
    const raw = (await db.query(
      `SELECT count(*)::int n
       FROM marks m JOIN learners l ON l.id=m.learner_id
       WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
         AND COALESCE(m.class_id,l.class_id)=$4 AND m.mark IS NOT NULL`,
      [schoolId, yearId, termId, classId]
    )).rows[0].n;
    if (!raw) {
      const inactive = (await db.query(
        `SELECT count(DISTINCT l.id)::int n
         FROM marks m JOIN learners l ON l.id=m.learner_id
         WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
           AND COALESCE(m.class_id,l.class_id)=$4 AND m.mark IS NOT NULL
           AND COALESCE(l.is_active,true)=false`,
        [schoolId, yearId, termId, classId]
      )).rows[0].n;
      if (inactive) {
        return `${inactive} learner(s) in this class have marks but are marked inactive. Results and report cards only read active learners. Reactivate them under Learner Enrollment to include them.`;
      }
      const other = (await db.query(
        `SELECT DISTINCT ay.year_label,t.name term_name,t.term_no
         FROM marks m
         JOIN academic_years ay ON ay.id=m.academic_year_id
         JOIN terms t ON t.id=m.term_id
         WHERE m.school_id=$1 AND m.class_id=$2
         ORDER BY ay.year_label,t.term_no LIMIT 12`,
        [schoolId, classId]
      )).rows;
      if (other.length) {
        return `No marks exist for this class in the selected year/term. Marks are recorded for: ${other.map(o => `${o.year_label} ${o.term_name}`).join(', ')}. Pick that period above.`;
      }
      return 'No marks have ever been recorded against this class. Check that marks were entered under this exact class record rather than a duplicate class.';
    }
    if (assessmentId) {
      return 'Marks exist for this class, but not for the selected assessment. Choose "All assessments" or a different assessment type.';
    }
    if (assessmentType) {
      return `Marks exist for this class, but none for the selected assessment type (${assessmentType === 'CAT' ? 'CATs' : assessmentType}). Choose "All assessments" above.`;
    }
    return 'Marks exist for this class, but none produced a usable average. Check that every assessment used has a max mark greater than zero and that it is not excluded from the term average.';
  } catch {
    return null;
  }
}

async function buildCompleteness(schoolId, query = {}) {
  const ctx = await resolveContext(schoolId, query);
  const { year, term } = ctx;
  if (!term) throw httpError('No term has been created for the selected academic year.', 400);
  const classId = query.class_id || null;
  const assessmentId = query.assessment_id || null;
  const assessmentType = query.assessment_type
    ? String(query.assessment_type).trim().toUpperCase()
    : null;
  const classes = await loadClasses(schoolId);
  const scopeClasses = classId
    ? classes.filter(c => String(c.id) === String(classId))
    : classes;
  if (!scopeClasses.length) throw httpError('Selected class was not found.', 404);

  const learners = await loadLearners(schoolId, year.id, { classId: classId || null });
  const learnerCounts = new Map();
  for (const learner of learners) {
    const key = String(learner.class_id || '');
    learnerCounts.set(key, (learnerCounts.get(key) || 0) + 1);
  }

  // Configured subjects per class: assignments, assessments and actual marks
  // all count, so a class is never shown as "0 subjects" while holding marks.
  const configured = (await db.query(
    `SELECT DISTINCT x.class_id,x.subject_id
     FROM (
       SELECT tsa.class_id,tsa.subject_id
       FROM teacher_subject_assignments tsa
       WHERE tsa.school_id=$1 AND tsa.academic_year_id=$2
         AND COALESCE(tsa.is_active,true)=true
         AND (tsa.term_id=$3 OR tsa.term_id IS NULL)
         AND tsa.class_id IS NOT NULL AND tsa.subject_id IS NOT NULL
       UNION
       SELECT a.class_id,a.subject_id
       FROM assessments a
       WHERE a.school_id=$1 AND a.academic_year_id=$2 AND a.term_id=$3
         AND a.class_id IS NOT NULL AND a.subject_id IS NOT NULL
       UNION
       SELECT m.class_id,m.subject_id
       FROM marks m
       WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
         AND m.class_id IS NOT NULL AND m.subject_id IS NOT NULL
     ) x`,
    [schoolId, year.id, term.id]
  )).rows;

  const subjectMeta = await loadSubjectMeta(schoolId);
  const subjectsByClass = new Map();
  for (const row of configured) {
    const key = String(row.class_id);
    if (!subjectsByClass.has(key)) subjectsByClass.set(key, new Set());
    subjectsByClass.get(key).add(String(row.subject_id));
  }

  const enteredRows = (await db.query(
    `SELECT COALESCE(le.class_id,l.class_id) class_id,m.subject_id,
            count(DISTINCT m.learner_id)::int entered
     FROM marks m
     JOIN assessments ax ON ax.id=m.assessment_id
     JOIN learners l ON l.id=m.learner_id AND l.school_id=m.school_id
     LEFT JOIN learner_enrollments le
       ON le.school_id=m.school_id AND le.learner_id=m.learner_id AND le.academic_year_id=m.academic_year_id
     WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
       AND m.mark IS NOT NULL AND COALESCE(l.is_active,true)=true
       AND ($4::uuid IS NULL OR m.assessment_id=$4)
       AND ($5::uuid IS NULL OR COALESCE(le.class_id,l.class_id)=$5)
       AND ($6::text IS NULL OR
            ($6='CAT' AND (upper(coalesce(ax.assessment_type,'')) LIKE 'CAT%'
                        OR upper(coalesce(ax.name,'')) LIKE '%CAT%'
                        OR upper(coalesce(ax.name,'')) LIKE '%CONTINUOUS%'))
            OR upper(coalesce(ax.assessment_type,''))=$6)
     GROUP BY 1,2`,
    [schoolId, year.id, term.id, assessmentId, classId || null, assessmentType]
  )).rows;
  const enteredMap = new Map();
  for (const row of enteredRows) {
    enteredMap.set(`${row.class_id}|${row.subject_id}`, Number(row.entered || 0));
  }

  const perLearner = (await db.query(
    `SELECT COALESCE(le.class_id,l.class_id) class_id,m.learner_id,
            count(DISTINCT m.subject_id)::int subjects
     FROM marks m
     JOIN assessments ax ON ax.id=m.assessment_id
     JOIN learners l ON l.id=m.learner_id AND l.school_id=m.school_id
     LEFT JOIN learner_enrollments le
       ON le.school_id=m.school_id AND le.learner_id=m.learner_id AND le.academic_year_id=m.academic_year_id
     WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
       AND m.mark IS NOT NULL AND COALESCE(l.is_active,true)=true
       AND ($4::uuid IS NULL OR m.assessment_id=$4)
       AND ($5::uuid IS NULL OR COALESCE(le.class_id,l.class_id)=$5)
       AND ($6::text IS NULL OR
            ($6='CAT' AND (upper(coalesce(ax.assessment_type,'')) LIKE 'CAT%'
                        OR upper(coalesce(ax.name,'')) LIKE '%CAT%'
                        OR upper(coalesce(ax.name,'')) LIKE '%CONTINUOUS%'))
            OR upper(coalesce(ax.assessment_type,''))=$6)
     GROUP BY 1,2`,
    [schoolId, year.id, term.id, assessmentId, classId || null, assessmentType]
  )).rows;

  const subjectColumns = [...subjectMeta.values()]
    .filter(subject => scopeClasses.some(c => subjectsByClass.get(String(c.id))?.has(String(subject.id))))
    .sort((a, b) => a.name.localeCompare(b.name));

  let totalExpected = 0;
  let totalEntered = 0;
  const matrixRows = [];
  for (const classRecord of scopeClasses) {
    const classKey = String(classRecord.id);
    const learnersInClass = learnerCounts.get(classKey) || 0;
    const subjectIds = subjectsByClass.get(classKey) || new Set();
    const cells = subjectColumns
      .filter(subject => subjectIds.has(String(subject.id)))
      .map(subject => {
        const expected = learnersInClass;
        if (!expected) return null;
        const entered = Math.min(enteredMap.get(`${classKey}|${subject.id}`) || 0, expected);
        totalExpected += expected;
        totalEntered += entered;
        return {
          subject_id: subject.id,
          subject_code: subject.code,
          subject_name: subject.name,
          entered,
          expected,
          percent: Math.round((entered / expected) * 100)
        };
      })
      .filter(Boolean);
    matrixRows.push({
      class_id: classRecord.id,
      class_name: classRecord.label,
      learners: learnersInClass,
      subjects: cells.length,
      cells
    });
  }

  const learnersReady = new Map();
  for (const row of perLearner) {
    const key = String(row.class_id);
    const required = (subjectsByClass.get(key) || new Set()).size;
    if (!required) continue;
    if (Number(row.subjects || 0) >= required) {
      learnersReady.set(key, (learnersReady.get(key) || 0) + 1);
    }
  }

  const totalLearners = learners.length;
  const reportReady = [...learnersReady.values()].reduce((sum, n) => sum + n, 0);
  const completeClasses = matrixRows.filter(row =>
    row.cells.length && row.cells.every(cell => cell.percent >= 95)).length;
  const marksPercent = totalExpected ? Math.round((totalEntered / totalExpected) * 100) : 0;

  const publication = (await db.query(
    `SELECT id,created_at,learner_count FROM result_publications
     WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3
     ORDER BY created_at DESC LIMIT 1`,
    [schoolId, year.id, term.id]
  ).catch(error => {
    if (error.code === '42P01' || error.code === '42703') return { rows: [] };
    throw error;
  })).rows[0] || null;

  const lastMark = (await db.query(
    `SELECT max(m.updated_at) last_at
     FROM marks m
     JOIN assessments ax ON ax.id=m.assessment_id
     WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
       AND ($4::uuid IS NULL OR m.assessment_id=$4)
       AND ($5::uuid IS NULL OR m.class_id=$5)
       AND ($6::text IS NULL OR
            ($6='CAT' AND (upper(coalesce(ax.assessment_type,'')) LIKE 'CAT%'
                        OR upper(coalesce(ax.name,'')) LIKE '%CAT%'
                        OR upper(coalesce(ax.name,'')) LIKE '%CONTINUOUS%'))
            OR upper(coalesce(ax.assessment_type,''))=$6)`,
    [schoolId, year.id, term.id, assessmentId, classId || null, assessmentType]
  )).rows[0] || {};

  const pendingCells = [];
  for (const row of matrixRows) {
    for (const cell of row.cells) {
      if (cell.percent < 95) {
        pendingCells.push({ class_name: row.class_name, ...cell });
      }
    }
  }
  pendingCells.sort((a, b) => a.percent - b.percent);

  const marksComplete = marksPercent >= 95;
  const reportComplete = totalLearners > 0 && reportReady >= totalLearners;
  return {
    context: {
      academic_year_id: year.id,
      year_label: year.year_label,
      year_state: year.state,
      term_id: term.id,
      term_name: term.name,
      class_id: classId,
      assessment_id: assessmentId,
      assessment_type: assessmentType,
      is_current: year.state === 'CURRENT'
    },
    kpis: {
      marks_entered: totalEntered,
      marks_expected: totalExpected,
      marks_percent: marksPercent,
      classes_complete: completeClasses,
      classes_total: matrixRows.length,
      learners: totalLearners,
      report_cards_ready: reportReady,
      merit_ready: totalEntered > 0,
      published: Boolean(publication),
      published_at: publication ? publication.created_at : null,
      last_mark_at: lastMark.last_at || null
    },
    subject_columns: subjectColumns.map(s => ({
      id: s.id, code: s.code, name: s.name
    })),
    rows: matrixRows,
    pending: pendingCells.slice(0, 12),
    pipeline: [
      {
        key: 'marks',
        label: 'Enter Marks',
        status: marksComplete ? 'complete' : totalEntered > 0 ? 'progress' : 'pending',
        detail: `${totalEntered} of ${totalExpected} marks captured`
      },
      {
        key: 'review',
        label: 'Review',
        status: marksComplete ? 'complete' : 'pending',
        detail: marksComplete
          ? 'Every class has at least 95% of its marks'
          : `${pendingCells.length} class/subject cell(s) still below 95%`
      },
      {
        key: 'reports',
        label: 'Generate Report Cards',
        status: reportComplete ? 'complete' : reportReady > 0 ? 'progress' : 'pending',
        detail: `${reportReady} of ${totalLearners} learners have a mark in every subject`
      },
      {
        key: 'publish',
        label: 'Publish & SMS',
        status: publication ? 'complete' : 'pending',
        detail: publication
          ? `Published to ${publication.learner_count || 0} learners`
          : 'Not published yet'
      }
    ]
  };
}

async function buildAnalytics(schoolId, query = {}) {
  const ctx = await resolveContext(schoolId, query);
  const current = await buildMerit(schoolId, query, { ctx, peers: false });
  let previous = null;
  if (ctx.previous) {
    try {
      previous = await buildMerit(schoolId, {
        ...query,
        academic_year_id: ctx.previous.year.id,
        term_id: ctx.previous.term.id
      }, { peers: false });
    } catch {
      previous = null;
    }
  }

  const summarise = merit => {
    const rows = (merit.rows || []).filter(row => row.average !== null);
    const byClass = new Map();
    const bySubject = new Map();
    const byGender = new Map();
    for (const row of rows) {
      const classKey = row.class_name || 'Unassigned';
      if (!byClass.has(classKey)) byClass.set(classKey, []);
      byClass.get(classKey).push(row.average);
      const genderKey = row.gender || 'Not specified';
      if (!byGender.has(genderKey)) byGender.set(genderKey, []);
      byGender.get(genderKey).push(row.average);
      for (const subject of row.subjects) {
        if (!bySubject.has(subject.subject_id)) {
          bySubject.set(subject.subject_id, {
            subject_id: subject.subject_id,
            name: subject.subject_name,
            values: []
          });
        }
        bySubject.get(subject.subject_id).values.push(subject.average);
      }
    }
    return {
      rows,
      byClass: new Map([...byClass.entries()].map(([k, v]) => [k, round(averageOf(v), 2)])),
      bySubject: [...bySubject.values()].map(item => ({
        subject_id: item.subject_id,
        name: item.name,
        mean: round(averageOf(item.values), 2)
      })).sort((a, b) => b.mean - a.mean),
      byGender: new Map([...byGender.entries()].map(([k, v]) => [k, round(averageOf(v), 2)])),
      grades: rows.reduce((acc, row) => {
        const label = row.grade || 'No grade';
        acc[label] = (acc[label] || 0) + 1;
        return acc;
      }, {}),
      mean: merit.stats.mean,
      meanGrade: merit.stats.mean_grade,
      passRate: merit.stats.pass_rate,
      passMark: merit.stats.pass_mark,
      learners: merit.stats.ranked
    };
  };

  const currentStats = summarise(current);
  const previousStats = previous ? summarise(previous) : null;
  const [grading, classRecords] = await Promise.all([loadGrading(schoolId), loadClasses(schoolId)]);
  const scopeClasses = query.class_id
    ? classRecords.filter(c => String(c.id) === String(query.class_id))
    : classRecords;
  const scopeSystem = query.class_id
    ? systemForClass(grading, scopeClasses[0] || { id: query.class_id })
    : grading.defaultSystem;
  const scopeBands = scopeSystem ? scopeSystem.bands : [];
  const bandLabels = bandLabelOrder(grading, scopeClasses);
  const classNames = [...new Set([
    ...currentStats.byClass.keys(),
    ...(previousStats ? previousStats.byClass.keys() : [])
  ])].sort((a, b) => a.localeCompare(b));

  const trend = [];
  for (const term of ctx.terms) {
    try {
      const result = term.id === ctx.term.id
        ? current
        : await buildMerit(schoolId, { ...query, term_id: term.id }, { ctx: { ...ctx, term }, peers: false });
      if (result.stats.ranked) {
        trend.push({
          term_id: term.id,
          label: term.name,
          mean: result.stats.mean,
          learners: result.stats.ranked
        });
      }
    } catch {
      // A term with no usable marks simply has no point on the trend line.
    }
  }

  const previousByLearner = new Map(
    (previous ? previous.rows : []).map(row => [String(row.learner_id), row.average])
  );
  const movers = [];
  for (const row of currentStats.rows) {
    const prior = previousByLearner.get(String(row.learner_id));
    if (prior == null || row.average == null) continue;
    movers.push({
      learner_id: row.learner_id,
      name: row.name,
      class_name: row.class_name,
      grade: row.grade || '',
      average: row.average,
      previous: prior,
      delta: round(row.average - prior, 2)
    });
  }
  movers.sort((a, b) => b.delta - a.delta);

  const heatRows = [...currentStats.byClass.keys()].sort((a, b) => a.localeCompare(b));
  const heatSubjects = [...new Map(currentStats.rows.flatMap(row =>
    row.subjects.map(s => [String(s.subject_id), s.subject_name]))).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const heatValues = heatRows.map(className => heatSubjects.map(subject => {
    const values = currentStats.rows
      .filter(row => (row.class_name || 'Unassigned') === className)
      .flatMap(row => row.subjects)
      .filter(subjectRow => String(subjectRow.subject_id) === String(subject.id))
      .map(subjectRow => subjectRow.average);
    return values.length ? round(averageOf(values), 1) : null;
  }));

  const multiYear = (await db.query(
    `SELECT ay.year_label,round(avg(x.avg)::numeric,1) mean,count(*)::int learners
     FROM (
       SELECT m.learner_id,m.academic_year_id,
              avg((m.mark/NULLIF(a.max_mark,0))*100) avg
       FROM marks m JOIN assessments a ON a.id=m.assessment_id
       WHERE m.school_id=$1 AND m.mark IS NOT NULL AND COALESCE(a.max_mark,0)>0
         AND ($2::uuid IS NULL OR m.class_id=$2)
       GROUP BY 1,2
     ) x JOIN academic_years ay ON ay.id=x.academic_year_id
     GROUP BY ay.year_label ORDER BY ay.year_label`,
    [schoolId, query.class_id || null]
  )).rows;

  const progression = (await db.query(
    `SELECT a.assessment_type type,min(a.name) name,
            round(avg((m.mark/NULLIF(a.max_mark,0))*100)::numeric,1) mean,
            count(DISTINCT m.learner_id)::int learners
     FROM marks m JOIN assessments a ON a.id=m.assessment_id
     WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3
       AND m.mark IS NOT NULL AND COALESCE(a.max_mark,0)>0
       AND ($4::uuid IS NULL OR m.class_id=$4)
     GROUP BY a.assessment_type
     ORDER BY min(a.assessment_order)`,
    [schoolId, ctx.year.id, ctx.term.id, query.class_id || null]
  )).rows;

  const gradeLabels = [...new Set([
    ...Object.keys(currentStats.grades),
    ...(previousStats ? Object.keys(previousStats.grades) : [])
  ])].filter(label => label && label !== 'No grade');

  const atRisk = currentStats.rows
    .map(row => {
      const prior = previousByLearner.get(String(row.learner_id));
      return {
        learner_id: row.learner_id,
        name: row.name,
        class_name: row.class_name,
        grade: row.grade || '',
        average: row.average,
        previous: prior ?? null,
        delta: prior == null || row.average == null ? null : round(row.average - prior, 2)
      };
    })
    .filter(row => row.average < 40 || (row.delta !== null && row.delta <= -5))
    .sort((a, b) => a.average - b.average)
    .slice(0, 12);

  const supportRows = atRisk.slice(0, 4).map(row => ({ ...row, status: 'SUPPORT' }));
  const usedIds = new Set(supportRows.map(row => String(row.learner_id)));
  const decliners = movers
    .filter(m => !usedIds.has(String(m.learner_id)) && m.delta <= -0.5)
    .reverse().slice(0, 3)
    .map(m => { usedIds.add(String(m.learner_id)); return { ...m, status: 'DECLINING' }; });
  const improvers = movers
    .filter(m => !usedIds.has(String(m.learner_id)) && m.delta >= 0.5)
    .slice(0, 2)
    .map(m => ({ ...m, status: 'IMPROVED' }));
  const movementRows = [...supportRows, ...decliners, ...improvers];

  const subjectAnalysis = buildSubjectAnalysis(
    currentStats.rows, previousStats ? previousStats.rows : [],
    bandLabels, scopeBands, currentStats.passMark
  );
  const classList = [...new Set(currentStats.rows.map(r => r.class_name || 'Unassigned'))]
    .sort((a, b) => a.localeCompare(b))
    .map(name => {
      const record = classRecords.find(c => c.label === name);
      const system = record ? systemForClass(grading, record) : grading.defaultSystem;
      return { name, bands: system ? system.bands : [] };
    });
  const classBands = buildClassBands(currentStats.rows, classList, bandLabels);

  const currentPoints = calculateMeanPoints(currentStats.rows, scopeBands);
  const previousPoints = previousStats ? calculateMeanPoints(previousStats.rows, scopeBands) : null;
  const qualityIndices = calculateQualityIndices(currentStats.rows, scopeBands, currentStats.passMark);
  const streamComparison = buildStreamComparison(
    currentStats.rows, previousStats ? previousStats.rows : [],
    classList, bandLabels, scopeBands, currentStats.passMark
  );
  const genderAnalysis = buildGenderAnalysis(
    currentStats.rows, bandLabels, scopeBands, currentStats.passMark
  );
  const interventionQuadrants = buildInterventionQuadrants(
    currentStats.rows, scopeBands, currentStats.passMark
  );

  const delta = (curr, prev) =>
    curr == null || prev == null ? null : round(curr - prev, 2);

  return {
    context: current.context,
    kpis: {
      mean: currentStats.mean,
      mean_grade: currentStats.meanGrade,
      mean_points: currentPoints,
      previous_mean_points: previousPoints,
      points_delta: delta(currentPoints, previousPoints),
      quality_pass_rate: qualityIndices.quality_pass_pct,
      high_mastery_rate: qualityIndices.high_mastery_pct,
      remediation_rate: qualityIndices.remediation_pct,
      pass_rate: currentStats.passRate,
      pass_mark: currentStats.passMark,
      learners: currentStats.learners,
      previous_mean: previousStats ? previousStats.mean : null,
      previous_pass_rate: previousStats ? previousStats.passRate : null,
      mean_delta: delta(currentStats.mean, previousStats ? previousStats.mean : null),
      pass_delta: delta(currentStats.passRate, previousStats ? previousStats.passRate : null),
      deviation: round(deviationOf(currentStats.rows.map(row => row.average)), 1),
      value_addition: delta(currentStats.mean, previousStats ? previousStats.mean : null)
    },
    by_class: {
      categories: classNames,
      series: [
        {
          name: current.context.term_name,
          values: classNames.map(name => currentStats.byClass.get(name) ?? null)
        },
        ...(previousStats ? [{
          name: previousStats.rows.length ? (ctx.previous ? ctx.previous.term.name : 'Previous term') : 'Previous term',
          values: classNames.map(name => previousStats.byClass.get(name) ?? null)
        }] : [])
      ]
    },
    grade_distribution: [
      ...bandLabels.filter(label => gradeLabels.includes(label)),
      ...gradeLabels.filter(label => !bandLabels.includes(label))
    ].map(label => ({ label, count: currentStats.grades[label] || 0 })),
    trend,
    subjects: currentStats.bySubject,
    subject_columns: current.subjects,
    band_labels: bandLabels,
    subject_analysis: subjectAnalysis,
    class_bands: classBands,
    quality_indices: qualityIndices,
    stream_comparison: streamComparison,
    gender_analysis: genderAnalysis,
    intervention_quadrants: interventionQuadrants,
    subject_toppers: buildSubjectToppers(current.rows),
    teachers: buildTeacherRows(subjectAnalysis),
    top_performers: currentStats.rows.slice(0, 5).map(row => ({
      name: row.name, class_name: row.class_name, average: row.average, grade: row.grade
    })),
    movement_rows: movementRows,
    register: current.rows.map(row => ({
      name: row.name,
      admission_no: row.admission_no,
      class_name: row.class_name,
      average: row.average,
      grade: row.grade,
      stream_rank: row.stream_rank,
      subjects: (row.subjects || []).map(s => ({
        subject_id: s.subject_id, subject_code: s.subject_code, average: s.average, grade: s.grade
      }))
    })),
    heatmap: { rows: heatRows, cols: heatSubjects, values: heatValues },
    gender: [...currentStats.byGender.entries()].map(([name, mean]) => ({ name, mean })),
    movement: {
      improved: movers.filter(m => m.delta > 0.5).length,
      declined: movers.filter(m => m.delta < -0.5).length,
      stable: movers.filter(m => Math.abs(m.delta) <= 0.5).length,
      top: movers.slice(0, 8),
      bottom: movers.slice(-8).reverse()
    },
    at_risk: atRisk,
    multi_year: multiYear,
    progression
  };
}

async function getOptions(schoolId, query = {}) {
  const ctx = await resolveContext(schoolId, query);
  const classes = await loadClasses(schoolId);
  const learners = await loadLearners(schoolId, ctx.year.id, {});
  const counts = new Map();
  for (const learner of learners) {
    const key = String(learner.class_id || '');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const assessments = ctx.term
    ? await loadAssessments(schoolId, ctx.year.id, ctx.term.id)
    : [];
  return {
    today: ctx.today,
    years: ctx.years.map(year => ({
      id: year.id,
      label: year.year_label,
      state: year.state,
      status: year.status,
      start_date: year.start_date,
      end_date: year.end_date,
      is_current: year.state === 'CURRENT',
      terms: year.terms.map(term => ({
        id: term.id,
        name: term.name,
        term_no: term.term_no,
        state: term.state,
        start_date: term.start_date,
        end_date: term.end_date
      }))
    })),
    current_year_id: ctx.year.id,
    current_term_id: ctx.term ? ctx.term.id : null,
    year: {
      id: ctx.year.id, label: ctx.year.year_label, state: ctx.year.state
    },
    term: ctx.term ? {
      id: ctx.term.id, name: ctx.term.name, term_no: ctx.term.term_no, state: ctx.term.state
    } : null,
    previous: ctx.previous ? {
      year_id: ctx.previous.year.id,
      year_label: ctx.previous.year.year_label,
      term_id: ctx.previous.term.id,
      term_name: ctx.previous.term.name
    } : null,
    classes: classes.map(c => ({
      id: c.id,
      name: c.name,
      stream: c.stream,
      label: c.label,
      level_id: c.school_level_id,
      level_name: c.level_name,
      learners: counts.get(String(c.id)) || 0
    })),
    assessments: assessments.map(a => ({
      id: a.id,
      name: a.name,
      type: a.assessment_type,
      class_id: a.class_id,
      subject_id: a.subject_id,
      max_mark: a.max_mark,
      assessment_order: a.assessment_order
    }))
  };
}

module.exports = {
  pointsForBand,
  calculateMeanPoints,
  calculateQualityIndices,
  buildStreamComparison,
  buildGenderAnalysis,
  buildInterventionQuadrants,
  getOptions,
  buildMerit,
  buildCompleteness,
  buildAnalytics,
  resolveContext,
  loadCalendar,
  invalidateResultsCaches,
  yearState: dateState,
  bandFor,
  deviationOf,
  bandLabelOrder,
  countBands,
  buildSubjectAnalysis,
  buildClassBands,
  buildSubjectToppers,
  buildTeacherRows,
  buildAnalysisCsv
};
