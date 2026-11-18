'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pointsForBand,
  calculateMeanPoints,
  calculateQualityIndices,
  buildStreamComparison,
  buildGenderAnalysis,
  buildInterventionQuadrants
} = require('../backend/services/results-engine');

const BANDS_8 = [
  { label: 'EE1', min_mark: 90, max_mark: 100, points: 8 },
  { label: 'EE2', min_mark: 80, max_mark: 89,  points: 7 },
  { label: 'ME1', min_mark: 70, max_mark: 79,  points: 6 },
  { label: 'ME2', min_mark: 50, max_mark: 69,  points: 5 },
  { label: 'AE1', min_mark: 40, max_mark: 49,  points: 4 },
  { label: 'AE2', min_mark: 30, max_mark: 39,  points: 3 },
  { label: 'BE1', min_mark: 20, max_mark: 29,  points: 2 },
  { label: 'BE2', min_mark: 0,  max_mark: 19,  points: 1 }
];
const LABELS_8 = BANDS_8.map(b => b.label);

test('pointsForBand resolves numeric marks and band labels to GPA points', () => {
  assert.equal(pointsForBand('EE1', BANDS_8), 8);
  assert.equal(pointsForBand('me2', BANDS_8), 5);
  assert.equal(pointsForBand(92, BANDS_8), 8);
  assert.equal(pointsForBand(74.5, BANDS_8), 6);
  assert.equal(pointsForBand(15, BANDS_8), 1);
  assert.equal(pointsForBand(null, BANDS_8), null);
});

test('calculateMeanPoints computes average GPA across learners', () => {
  const learners = [
    { grade: 'EE1', points: 8 },
    { grade: 'ME1', points: 6 }
  ];
  assert.equal(calculateMeanPoints(learners, BANDS_8), 7.0);
  assert.equal(calculateMeanPoints([], BANDS_8), null);
});

test('calculateQualityIndices computes mastery, quality pass, and remediation', () => {
  const learners = [
    { average: 92, grade: 'EE1' },
    { average: 81, grade: 'EE2' },
    { average: 65, grade: 'ME2' },
    { average: 35, grade: 'AE2' }
  ];
  const qi = calculateQualityIndices(learners, BANDS_8, 50);
  assert.equal(qi.total_candidates, 4);
  assert.equal(qi.high_mastery_count, 2);
  assert.equal(qi.high_mastery_pct, 50);
  assert.equal(qi.quality_pass_count, 3);
  assert.equal(qi.quality_pass_pct, 75);
  assert.equal(qi.remediation_count, 1);
  assert.equal(qi.remediation_pct, 25);
});

test('buildStreamComparison ranks streams and computes gender disaggregation', () => {
  const current = [
    { learner_id: '1', name: 'Dan', admission_no: 'A1', class_name: '7 East', gender: 'male', average: 85, grade: 'EE2', points: 7, subjects: [] },
    { learner_id: '2', name: 'Eve', admission_no: 'A2', class_name: '7 East', gender: 'female', average: 75, grade: 'ME1', points: 6, subjects: [] },
    { learner_id: '3', name: 'Sam', admission_no: 'B1', class_name: '7 West', gender: 'male', average: 45, grade: 'AE1', points: 4, subjects: [] }
  ];
  const classes = [
    { name: '7 East', bands: BANDS_8 },
    { name: '7 West', bands: BANDS_8 }
  ];
  const streams = buildStreamComparison(current, [], classes, LABELS_8, BANDS_8, 50);
  assert.equal(streams.length, 2);
  assert.equal(streams[0].stream_name, '7 East');
  assert.equal(streams[0].rank, 1);
  assert.equal(streams[0].mean, 80);
  assert.equal(streams[0].mean_points, 6.5);
  assert.equal(streams[0].gender.boys.mean, 85);
  assert.equal(streams[0].gender.girls.mean, 75);
  assert.equal(streams[1].stream_name, '7 West');
  assert.equal(streams[1].rank, 2);
});

test('buildGenderAnalysis computes boys vs girls parity and subject gap', () => {
  const current = [
    {
      learner_id: '1', name: 'Achieng', gender: 'female', average: 80, grade: 'EE2',
      subjects: [{ subject_id: 'math', subject_code: 'MATH', subject_name: 'Maths', average: 70 }]
    },
    {
      learner_id: '2', name: 'Baraka', gender: 'male', average: 60, grade: 'ME2',
      subjects: [{ subject_id: 'math', subject_code: 'MATH', subject_name: 'Maths', average: 80 }]
    }
  ];
  const ga = buildGenderAnalysis(current, LABELS_8, BANDS_8, 50);
  assert.equal(ga.summary.boys.mean, 60);
  assert.equal(ga.summary.girls.mean, 80);
  assert.equal(ga.summary.gap, -20);
  assert.equal(ga.subjects.length, 1);
  assert.equal(ga.subjects[0].subject_name, 'Maths');
  assert.equal(ga.subjects[0].gap, 10); // boys ahead by 10 in Maths
});

test('buildInterventionQuadrants segments learners into actionable categories', () => {
  const current = [
    { learner_id: '1', name: 'Top Star', average: 92, grade: 'EE1', subjects: [{ average: 92 }] },
    { learner_id: '2', name: 'Solid', average: 65, grade: 'ME2', subjects: [{ average: 65 }] },
    { learner_id: '3', name: 'Struggler', average: 60, grade: 'ME2', subjects: [{ subject_id: 'sci', subject_name: 'Science', average: 32 }] },
    { learner_id: '4', name: 'At Risk', average: 35, grade: 'AE2', subjects: [{ subject_id: 'all', average: 35 }] }
  ];
  const q = buildInterventionQuadrants(current, BANDS_8, 50);
  assert.equal(q.counts.high_flyers, 1);
  assert.equal(q.counts.solid_core, 1);
  assert.equal(q.counts.bottleneck_strugglers, 1);
  assert.equal(q.counts.urgent_intervention, 1);
  assert.equal(q.bottleneck_strugglers[0].bottlenecks[0].subject_name, 'Science');
});
