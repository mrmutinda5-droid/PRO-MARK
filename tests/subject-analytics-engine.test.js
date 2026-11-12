'use strict';

const assert = require('node:assert/strict');
const {analyzeSubjectPerformance, gradeFor} = require('../backend/services/subject-analytics-engine');

assert.equal(gradeFor(84, [{label: 'ME1', min_mark: 70, max_mark: 84}]), 'ME1');
assert.equal(gradeFor(85, [{label: 'ME1', min_mark: 70, max_mark: 84}]), null);

const result = analyzeSubjectPerformance({
  classes: [{
    id: 'class-1',
    name: 'Grade 6 East',
    stream: 'East',
    school_level_id: 'level-6',
    section_id: 'section-primary'
  }, {
    id: 'class-2',
    name: 'Grade 6 West',
    stream: 'West',
    school_level_id: 'level-6',
    section_id: 'section-primary'
  }],
  roster: [
    {id: 'learner-1', class_id: 'class-1', learner_name: 'A Learner', admission_no: 'A1', roster_source: 'MARKS_FALLBACK'},
    {id: 'learner-2', class_id: 'class-1', learner_name: 'B Learner', admission_no: 'B1'}
  ],
  assignments: [
    {class_id: 'class-1', subject_id: 'math', subject_name: 'Mathematics'},
    {class_id: 'class-1', subject_id: 'english', subject_name: 'English'},
    {class_id: 'class-2', subject_id: 'math', subject_name: 'Mathematics'}
  ],
  marks: [
    {learner_id: 'learner-1', class_id: 'class-1', subject_id: 'math', subject_name: 'Mathematics', assessment_id: 'exam-1', assessment_name: 'End Term', mark: 18, max_mark: 20},
    {learner_id: 'learner-1', class_id: 'class-1', subject_id: 'english', subject_name: 'English', assessment_id: 'exam-1', assessment_name: 'End Term', mark: 14, max_mark: 20}
  ],
  configs: [{
    class_id: 'class-1',
    subject_id: 'math',
    assessment_id: null,
    target_mark: 85,
    bands: [{label: 'EE1', min_mark: 85, max_mark: 100}]
  }, {
    class_id: 'class-2',
    subject_id: 'math',
    assessment_id: null,
    target_mark: 75,
    grading_system_id: 'grade-system-west',
    bands: [{label: 'ME1', min_mark: 70, max_mark: 84}]
  }],
  trends: [{
    academic_year_id: 'year-1',
    year_label: '2027',
    term_id: 'term-1',
    term_name: 'Term 1',
    term_no: 1,
    subject_id: 'math',
    subject_name: 'Mathematics',
    average: 75,
    assessed: 2
  }, {
    academic_year_id: 'year-1',
    year_label: '2027',
    term_id: 'term-2',
    term_name: 'Term 2',
    term_no: 2,
    subject_id: 'math',
    subject_name: 'Mathematics',
    average: 80,
    assessed: 1
  }]
});

assert.equal(result.overall.subjects, 2);
assert.equal(result.overall.assessed_learners, 1);
assert.equal(result.overall.expected_subject_learners, 4);
assert.equal(result.overall.coverage, 50);
assert.equal(result.overall.mean, 80);
assert.equal(result.enrollment_fallback_count, 1);

const math = result.subjects.find(subject => subject.id === 'math');
assert.equal(math.average, 90);
assert.equal(math.highest, 90);
assert.equal(math.lowest, 90);
assert.equal(math.assessed, 1);
assert.equal(math.expected, 2);
assert.equal(math.not_assessed, 1);
assert.equal(math.coverage, 50);
assert.equal(math.grade_counts.EE1, 1);
assert.deepEqual(math.grade_bands.map(band => band.label).sort(), ['EE1', 'ME1']);
assert.equal(math.target_variance, 5);
assert.ok(result.interventions.some(flag => flag.type === 'SMALL_SAMPLE'));
assert.ok(result.interventions.some(flag => flag.type === 'MISSING_MARKS'));

assert.equal(result.trends[0].average, 75);
assert.equal(result.trends[0].assessed, 2);
assert.equal(result.trends[1].term_no, 2);
assert.equal(result.trends[1].average, 80);
console.log('Subject analytics tests passed');
