'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExamColumns,
  subjectEntries,
  scoreSubject,
  computeRanks
} = require('../backend/services/term-score');

const CLASS_A = 'class-a';
const CLASS_B = 'class-b';
const MATH = 'subject-math';
const ENGLISH = 'subject-english';

function assessment(overrides) {
  return {
    id: 'assessment',
    name: 'Assessment',
    assessment_type: 'OPENER',
    max_mark: 100,
    weight: 0,
    include_in_final: true,
    include_in_term_average: true,
    assessment_order: 1,
    class_id: CLASS_A,
    subject_id: null,
    mark_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

const assessments = [
  assessment({ id: 'opener-math', name: 'Mathematics Opener', assessment_type: 'OPENER', subject_id: MATH, assessment_order: 1 }),
  assessment({ id: 'opener-english', name: 'English Opener', assessment_type: 'OPENER', subject_id: ENGLISH, assessment_order: 1 }),
  assessment({ id: 'cat1-math', name: 'CAT 1', assessment_type: 'CAT', subject_id: MATH, max_mark: 30, assessment_order: 2, include_in_final: false }),
  assessment({ id: 'cat1-english', name: 'CAT 1', assessment_type: 'CAT', subject_id: ENGLISH, max_mark: 30, assessment_order: 2, include_in_final: false }),
  assessment({ id: 'end-all', name: 'End Term', assessment_type: 'END_TERM', subject_id: null, assessment_order: 3 }),
  assessment({ id: 'opener-math-b', name: 'Mathematics Opener', assessment_type: 'OPENER', subject_id: MATH, assessment_order: 1, class_id: CLASS_B }),
  assessment({ id: 'end-all-b', name: 'End Term', assessment_type: 'END_TERM', subject_id: null, assessment_order: 3, class_id: CLASS_B })
];

const columns = buildExamColumns(assessments, CLASS_A);

test('exam columns include every configured exam and CAT once', () => {
  assert.deepEqual(columns.map(column => column.name), ['Opener', 'CAT 1', 'End Term']);
  assert.deepEqual(columns.map(column => column.cat), [false, true, false]);
});

test('subject entries resolve per-subject and class-wide assessments', () => {
  const marks = [
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'opener-math', mark: 50, max_mark: 100 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'cat1-math', mark: 15, max_mark: 30 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'end-all', mark: 80, max_mark: 100 }
  ];
  const entries = subjectEntries(marks, assessments, CLASS_A, MATH, columns);
  assert.equal(entries.length, 3);
  assert.equal(entries[1].assessment_id, 'cat1-math');
  assert.equal(entries[1].percent, 50);
  assert.equal(entries[2].assessment_id, 'end-all');
  assert.equal(entries[2].percent, 80);
});

test('default term average includes exactly assessments enabled by the admin', () => {
  const marks = [
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'opener-math', mark: 50, max_mark: 100 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'cat1-math', mark: 15, max_mark: 30 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'end-all', mark: 80, max_mark: 100 }
  ];
  const configuredAssessments = assessments.map(item =>
    item.id === 'cat1-math' ? { ...item, include_in_term_average: false } : item
  );
  const entries = subjectEntries(marks, configuredAssessments, CLASS_A, MATH, columns);
  const result = scoreSubject({ entries, profile: null });
  assert.equal(result.average, 65);
  assert.equal(result.basis, 'INCLUDED_ASSESSMENTS');
  assert.deepEqual(result.counted_keys, ['EXAM:OPENER', 'EXAM:END_TERM']);
});

test('a saved admin selection does not fall back to unselected exam marks', () => {
  const marks = [
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'opener-math', mark: 70, max_mark: 100 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'end-all', mark: 90, max_mark: 100 }
  ];
  const entries = subjectEntries(marks, assessments, CLASS_A, MATH, columns);
  const result = scoreSubject({
    entries,
    profile: { selected_assessment_ids: ['opener-english'], cat_group_mode: 'INDIVIDUAL' }
  });
  assert.equal(result.average, null);
  assert.equal(result.basis, 'NO_APPROVED_MARKS');
  assert.deepEqual(result.counted_keys, []);
  const selectedExam = scoreSubject({
    entries,
    profile: { selected_assessment_ids: ['opener-math'], cat_group_mode: 'INDIVIDUAL' }
  });
  assert.equal(selectedExam.average, 70);
  assert.deepEqual(selectedExam.counted_keys, ['EXAM:OPENER']);
});

test('admin-included CATs contribute to term average even when not final exams', () => {
  const marks = [
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'opener-math', mark: 50, max_mark: 100 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'cat1-math', mark: 15, max_mark: 30 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'end-all', mark: 80, max_mark: 100 }
  ];
  const entries = subjectEntries(marks, assessments, CLASS_A, MATH, columns);
  const result = scoreSubject({ entries, profile: null });
  assert.equal(result.average, 60);
  assert.equal(result.basis, 'INCLUDED_ASSESSMENTS');
  assert.deepEqual(result.counted_keys, ['EXAM:OPENER', 'CAT:CAT 1', 'EXAM:END_TERM']);
});

test('mark-specific inclusion overrides broader assessment inclusion', () => {
  const configuredAssessments = assessments.map(item =>
    item.id === 'opener-math' ? { ...item, include_in_term_average: false } : item
  );
  const entries = subjectEntries([{
    learner_id: 'l1',
    subject_id: MATH,
    assessment_id: 'opener-math',
    mark: 70,
    max_mark: 100,
    include_in_term_average: true
  }], configuredAssessments, CLASS_A, MATH, columns);
  assert.equal(scoreSubject({ entries, profile: null }).average, 70);
});

test('Merit includes marks by include_in_merit without changing term-average eligibility', () => {
  const marks = [
    {
      learner_id: 'l1', subject_id: MATH, assessment_id: 'opener-math',
      mark: 86, max_mark: 100, include_in_term_average: false, include_in_merit: true
    },
    {
      learner_id: 'l1', subject_id: ENGLISH, assessment_id: 'opener-english',
      mark: 78, max_mark: 100, include_in_term_average: true, include_in_merit: false
    }
  ];
  const ranks = computeRanks({
    learners: [{ learner_id: 'l1', class_id: CLASS_A }],
    marks,
    assessments,
    profilesByClass: new Map(),
    classes: [{ id: CLASS_A, name: 'Grade 7' }],
    inclusionField: 'include_in_merit'
  });
  assert.deepEqual(ranks.get('l1').subjects, [
    { subject_id: MATH, average: 86, basis: 'INCLUDED_ASSESSMENTS' }
  ]);
  const reportRanks = computeRanks({
    learners: [{ learner_id: 'l1', class_id: CLASS_A }],
    marks,
    assessments,
    profilesByClass: new Map(),
    classes: [{ id: CLASS_A, name: 'Grade 7' }]
  });
  assert.deepEqual(reportRanks.get('l1').subjects, [
    { subject_id: ENGLISH, average: 78, basis: 'INCLUDED_ASSESSMENTS' }
  ]);
});

test('CAT group averages all selected CATs as one contribution', () => {
  const marks = [
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'opener-math', mark: 50, max_mark: 100 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'cat1-math', mark: 15, max_mark: 30 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'end-all', mark: 80, max_mark: 100 }
  ];
  const entries = subjectEntries(marks, assessments, CLASS_A, MATH, columns);
  const result = scoreSubject({
    entries,
    profile: {
      selected_assessment_ids: ['opener-math', 'cat1-math', 'end-all'],
      cat_group_mode: 'CAT_GROUP'
    }
  });
  assert.equal(result.average, 60);
  assert.equal(result.basis, 'CAT_GROUP_AVERAGE');
});

test('custom weights produce a weighted term average', () => {
  const marks = [
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'opener-math', mark: 50, max_mark: 100 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'cat1-math', mark: 15, max_mark: 30 },
    { learner_id: 'l1', subject_id: MATH, assessment_id: 'end-all', mark: 80, max_mark: 100 }
  ];
  const entries = subjectEntries(marks, assessments, CLASS_A, MATH, columns);
  const result = scoreSubject({
    entries,
    profile: {
      selected_assessment_ids: ['opener-math', 'cat1-math', 'end-all'],
      cat_group_mode: 'CUSTOM',
      custom_weights: { 'opener-math': 40, 'cat1-math': 20, 'end-all': 40 }
    }
  });
  assert.equal(result.average, 62);
  assert.equal(result.basis, 'CUSTOM_WEIGHTS');
});

test('ranks use the same scoring as the report subjects', () => {
  const marks = [
    { learner_id: 'l1', class_id: CLASS_A, subject_id: MATH, assessment_id: 'opener-math', mark: 50, max_mark: 100 },
    { learner_id: 'l1', class_id: CLASS_A, subject_id: MATH, assessment_id: 'end-all', mark: 80, max_mark: 100 },
    { learner_id: 'l2', class_id: CLASS_A, subject_id: MATH, assessment_id: 'opener-math', mark: 90, max_mark: 100 },
    { learner_id: 'l2', class_id: CLASS_A, subject_id: MATH, assessment_id: 'end-all', mark: 100, max_mark: 100 },
    { learner_id: 'l3', class_id: CLASS_B, subject_id: MATH, assessment_id: 'opener-math-b', mark: 70, max_mark: 100 },
    { learner_id: 'l3', class_id: CLASS_B, subject_id: MATH, assessment_id: 'end-all-b', mark: 60, max_mark: 100 }
  ];
  const ranks = computeRanks({
    learners: [
      { learner_id: 'l1', class_id: CLASS_A },
      { learner_id: 'l2', class_id: CLASS_A },
      { learner_id: 'l3', class_id: CLASS_B }
    ],
    marks,
    assessments,
    profilesByClass: new Map(),
    classes: [
      { id: CLASS_A, name: 'Grade 7' },
      { id: CLASS_B, name: 'Grade 7' }
    ]
  });
  assert.equal(ranks.get('l1').overall_average, 65);
  assert.equal(ranks.get('l1').stream_rank, 2);
  assert.equal(ranks.get('l1').class_rank, 2);
  assert.equal(ranks.get('l3').class_rank, 2);
  assert.equal(ranks.get('l1').subject_ranks[MATH].rank, 2);
  assert.equal(ranks.get('l1').subject_ranks[MATH].total, 2);
});

test('one learner retains subject marks under a single opener column', () => {
  const ranks = computeRanks({
    learners: [{ learner_id: 'l1', class_id: CLASS_A }],
    marks: [
      { learner_id: 'l1', class_id: CLASS_A, subject_id: MATH, assessment_id: 'opener-math', mark: 95, max_mark: 100 },
      { learner_id: 'l1', class_id: CLASS_A, subject_id: ENGLISH, assessment_id: 'opener-english', mark: 91, max_mark: 100 }
    ],
    assessments,
    profilesByClass: new Map(),
    classes: [{ id: CLASS_A, name: 'Grade 7' }]
  });
  assert.deepEqual(
    ranks.get('l1').subjects.map(subject => subject.subject_id).sort(),
    [ENGLISH, MATH].sort()
  );
  assert.equal(ranks.get('l1').subjects.length, 2);
  assert.equal(columns.filter(column => column.key === 'EXAM:OPENER').length, 1);
  assert.deepEqual(columns.find(column => column.key === 'EXAM:OPENER').ids.slice().sort(), [
    'opener-english',
    'opener-math'
  ]);
});

test('standard End Term records across subjects use one canonical exam column', () => {
  const subjectAssessments = [
    assessment({ id: 'end-math', name: 'End Term Mathematics', assessment_type: 'END_TERM', subject_id: MATH }),
    assessment({ id: 'end-english', name: 'English Final', assessment_type: 'END_TERM', subject_id: ENGLISH })
  ];
  const endColumns = buildExamColumns(subjectAssessments, CLASS_A);
  assert.equal(endColumns.length, 1);
  assert.equal(endColumns[0].name, 'End Term');

  const entries = subjectEntries(
    [{ subject_id: ENGLISH, assessment_id: 'end-english', mark: 82, max_mark: 100 }],
    subjectAssessments,
    CLASS_A,
    ENGLISH,
    endColumns
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].assessment_id, 'end-english');
  assert.equal(entries[0].name, 'End Term');
});

test('saved marks remain attached to their subject when assessment setup is scoped elsewhere', () => {
  const offScopeAssessment = assessment({
    id: 'legacy-math-assessment',
    class_id: CLASS_B,
    subject_id: MATH,
    name: 'Legacy Exam'
  });
  const ranks = computeRanks({
    learners: [{ learner_id: 'l1', class_id: CLASS_A }],
    marks: [{
      learner_id: 'l1',
      class_id: CLASS_A,
      subject_id: ENGLISH,
      assessment_id: offScopeAssessment.id,
      mark: 72,
      max_mark: 100
    }],
    assessments: [offScopeAssessment],
    profilesByClass: new Map(),
    classes: [{ id: CLASS_A, name: 'Grade 7' }]
  });
  assert.deepEqual(ranks.get('l1').subjects, [
    { subject_id: ENGLISH, average: 72, basis: 'INCLUDED_ASSESSMENTS' }
  ]);
});
