'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  bandFor,
  deviationOf,
  bandLabelOrder,
  countBands,
  buildSubjectAnalysis,
  buildClassBands,
  buildSubjectToppers,
  buildTeacherRows,
  buildAnalysisCsv
} = require('../backend/services/results-engine');

const BANDS = [
  { label: 'EE1', min_mark: 90, max_mark: 100 },
  { label: 'EE2', min_mark: 70, max_mark: 89 },
  { label: 'ME1', min_mark: 60, max_mark: 69 },
  { label: 'ME2', min_mark: 50, max_mark: 59 },
  { label: 'BE1', min_mark: 20, max_mark: 49 },
  { label: 'BE2', min_mark: 0, max_mark: 19 }
];
const LABELS = BANDS.map(b => b.label);

function subject(id, code, name, average, grade, teacher) {
  return { subject_id: id, subject_code: code, subject_name: name, average, grade, teacher: teacher || '' };
}

function learner(id, name, className, subjects) {
  const scored = subjects.filter(s => s.average != null);
  const average = scored.length ? scored.reduce((a, s) => a + s.average, 0) / scored.length : null;
  const band = average == null ? null : bandFor(average, BANDS);
  return {
    learner_id: id,
    name,
    admission_no: 'ADM-' + id,
    class_id: 'class-' + className,
    class_name: className,
    average: average == null ? null : Math.round(average * 100) / 100,
    grade: band ? band.label : '',
    subjects
  };
}

const currentRows = [
  learner('l1', 'Achieng One', 'Grade 6 East', [
    subject('math', 'MATH', 'Mathematics', 95, 'EE1', 'Mr. Otieno'),
    subject('eng', 'ENG', 'English', 74, 'EE2', 'Ms. Wanjiru')
  ]),
  learner('l2', 'Baraka Two', 'Grade 6 East', [
    subject('math', 'MATH', 'Mathematics', 66, 'ME1', 'Mr. Otieno'),
    subject('eng', 'ENG', 'English', 52, 'ME2', 'Ms. Wanjiru')
  ]),
  learner('l3', 'Chao Three', 'Grade 6 West', [
    subject('math', 'MATH', 'Mathematics', 30, 'BE1', 'Mr. Kip'),
    subject('eng', 'ENG', 'English', null, '', 'Ms. Wanjiru')
  ]),
  learner('l4', 'Dina Four', 'Grade 6 West', [
    subject('math', 'MATH', 'Mathematics', 12, 'BE2', 'Mr. Kip'),
    subject('eng', 'ENG', 'English', 88, 'EE2', 'Ms. Wanjiru')
  ])
];

const previousRows = [
  learner('l1', 'Achieng One', 'Grade 6 East', [
    subject('math', 'MATH', 'Mathematics', 85, 'EE2', 'Mr. Otieno'),
    subject('eng', 'ENG', 'English', 70, 'EE2', 'Ms. Wanjiru')
  ]),
  learner('l2', 'Baraka Two', 'Grade 6 East', [
    subject('math', 'MATH', 'Mathematics', 72, 'EE2', 'Mr. Otieno'),
    subject('eng', 'ENG', 'English', 58, 'ME2', 'Ms. Wanjiru')
  ])
];

test('deviationOf computes population sigma and tolerates gaps', () => {
  assert.equal(deviationOf([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  assert.equal(deviationOf([]), null);
  assert.equal(deviationOf(null), null);
  assert.equal(deviationOf([null, 10, undefined, 10]), 0);
});

test('bandFor rounds before matching the admin band ranges', () => {
  assert.equal(bandFor(89.6, BANDS).label, 'EE1');
  assert.equal(bandFor(89.4, BANDS).label, 'EE2');
  assert.equal(bandFor(0, BANDS).label, 'BE2');
  assert.equal(bandFor(undefined, BANDS), null);
});

test('bandLabelOrder keeps admin order and unions class systems without duplicates', () => {
  const alt = { bands: [{ label: 'A', min_mark: 80, max_mark: 100 }, { label: 'EE1', min_mark: 90, max_mark: 100 }] };
  const grading = {
    defaultSystem: { bands: BANDS },
    systems: new Map([['cbc', { bands: BANDS }], ['alt', alt]]),
    configs: [{ class_id: 'c9', grading_system_id: 'alt' }]
  };
  const labels = bandLabelOrder(grading, [{ id: 'c9' }]);
  assert.deepEqual(labels, ['EE1', 'EE2', 'ME1', 'ME2', 'BE1', 'BE2', 'A']);
  assert.deepEqual(bandLabelOrder(null, []), []);
});

test('countBands zero-fills every label and ignores blank grades', () => {
  const counts = countBands(['EE1', 'EE1', 'ME2', '', null], LABELS);
  assert.deepEqual(counts, { EE1: 2, EE2: 0, ME1: 0, ME2: 1, BE1: 0, BE2: 0 });
});

test('buildSubjectAnalysis grades every subject and compares with the previous term', () => {
  const analysis = buildSubjectAnalysis(currentRows, previousRows, LABELS, BANDS, 50);
  assert.equal(analysis.length, 2);
  const eng = analysis[0];
  const math = analysis[1];
  assert.equal(eng.subject_name, 'English');
  assert.equal(eng.mean, 71.33);
  assert.equal(eng.grade, 'EE2');
  assert.equal(eng.high, 88);
  assert.equal(eng.low, 52);
  assert.equal(eng.scored, 3);
  assert.equal(eng.pass, 100);
  assert.equal(eng.counts.EE2, 2);
  assert.equal(eng.counts.ME2, 1);
  assert.equal(eng.delta, 7.33);
  assert.equal(math.mean, 50.75);
  assert.equal(math.grade, 'ME2');
  assert.equal(math.counts.EE1, 1);
  assert.equal(math.counts.ME1, 1);
  assert.equal(math.counts.BE1, 1);
  assert.equal(math.counts.BE2, 1);
  assert.equal(math.delta, -27.75);
  const noPrior = buildSubjectAnalysis(currentRows, [], LABELS, BANDS, 50);
  assert.equal(noPrior[0].delta, null);
});

test('buildClassBands counts bands per class and subject plus the class average', () => {
  const classList = [
    { name: 'Grade 6 East', bands: BANDS },
    { name: 'Grade 6 West', bands: BANDS },
    { name: 'Grade 7 Empty', bands: BANDS }
  ];
  const classBands = buildClassBands(currentRows, classList, LABELS);
  assert.equal(classBands.length, 2);
  const east = classBands[0];
  assert.equal(east.class_name, 'Grade 6 East');
  assert.equal(east.scored, 2);
  assert.equal(east.average_counts.EE2, 1);
  assert.equal(east.average_counts.ME2, 1);
  const eastMath = east.subjects.find(s => s.subject_code === 'MATH');
  assert.equal(eastMath.counts.EE1, 1);
  assert.equal(eastMath.counts.ME1, 1);
  assert.equal(eastMath.scored, 2);
  assert.equal(eastMath.grade, 'EE2');
  const west = classBands[1];
  assert.equal(west.average_counts.BE1, 1);
  assert.equal(west.average_counts.ME2, 1);
});

test('buildSubjectToppers picks the highest mark per subject with its grade', () => {
  const toppers = buildSubjectToppers(currentRows);
  assert.equal(toppers.length, 2);
  assert.equal(toppers[0].subject_name, 'English');
  assert.equal(toppers[0].name, 'Dina Four');
  assert.equal(toppers[0].average, 88);
  assert.equal(toppers[0].grade, 'EE2');
  assert.equal(toppers[1].name, 'Achieng One');
  assert.equal(toppers[1].grade, 'EE1');
});

test('buildTeacherRows averages each teacher across their subjects', () => {
  const analysis = buildSubjectAnalysis(currentRows, [], LABELS, BANDS, 50);
  const teachers = buildTeacherRows(analysis);
  assert.equal(teachers.length, 2);
  assert.equal(teachers[0].teacher, 'Ms. Wanjiru');
  assert.equal(teachers[0].subjects, 1);
  assert.equal(teachers[0].mean, 71.33);
  assert.equal(teachers[1].teacher, 'Mr. Otieno');
  assert.equal(teachers[1].mean, 50.75);
  assert.deepEqual(buildTeacherRows([]), []);
});

test('buildAnalysisCsv carries subject grades, band counts and the full register', () => {
  const analytics = {
    context: { year_label: '2026', term_name: 'Term 1', class_name: '' },
    kpis: { mean: 60.5, mean_grade: 'ME1', deviation: 25.1, value_addition: -3.2, pass_rate: 50, pass_mark: 50, learners: 4 },
    band_labels: LABELS,
    subject_columns: [
      { subject_id: 'eng', subject_code: 'ENG', subject_name: 'English' },
      { subject_id: 'math', subject_code: 'MATH', subject_name: 'Mathematics' }
    ],
    subject_analysis: buildSubjectAnalysis(currentRows, previousRows, LABELS, BANDS, 50),
    class_bands: buildClassBands(currentRows, [
      { name: 'Grade 6 East', bands: BANDS },
      { name: 'Grade 6 West', bands: BANDS }
    ], LABELS),
    register: currentRows.map(row => ({
      name: row.name,
      admission_no: row.admission_no,
      class_name: row.class_name,
      average: row.average,
      grade: row.grade,
      stream_rank: null,
      subjects: row.subjects.map(s => ({ subject_id: s.subject_id, subject_code: s.subject_code, average: s.average, grade: s.grade }))
    })),
    movement_rows: [{ name: 'Chao Three', class_name: 'Grade 6 West', average: 30, previous: 44, delta: -14, grade: 'BE1', status: 'SUPPORT' }]
  };
  const csv = buildAnalysisCsv(analytics);
  assert.ok(csv.startsWith('OFFICIAL PERFORMANCE ANALYSIS'));
  assert.ok(csv.includes('\r\n'));
  assert.ok(csv.includes('SUBJECT,TEACHER,MEAN,GRADE,HIGH,LOW,PASS %,DEVIATION,DELTA PREV,EE1,EE2,ME1,ME2,BE1,BE2,SCORED'));
  assert.ok(csv.includes('CLASS,SUBJECT,EE1,EE2,ME1,ME2,BE1,BE2,SCORED,MEAN,GRADE'));
  assert.ok(csv.includes('Grade 6 East,AVERAGE,'));
  assert.ok(csv.includes('ENG MARK,ENG GRADE,MATH MARK,MATH GRADE'));
  assert.ok(csv.includes('LEARNER,CLASS,CURRENT,PREVIOUS,CHANGE,GRADE,STATUS'));
  assert.ok(csv.includes('Chao Three,Grade 6 West,30,44,-14,BE1,SUPPORT'));
  const registerLine = csv.split('\r\n').find(line => line.startsWith('1,Achieng One') || line.includes('Achieng One,ADM-l1'));
  assert.ok(registerLine.includes('74,EE2,95,EE1'));
  assert.equal(buildAnalysisCsv(null).includes('OFFICIAL PERFORMANCE ANALYSIS'), true);
});

test('buildAnalysisCsv quotes cells containing commas', () => {
  const csv = buildAnalysisCsv({
    context: { year_label: '2026', term_name: 'Term 1, Mid' },
    kpis: {},
    band_labels: [],
    subject_analysis: [],
    class_bands: [],
    register: [],
    movement_rows: []
  });
  assert.ok(csv.includes('"Term 1, Mid"'));
});