'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLearnerPaste } = require('../public/js/learner-import-parser');

test('parses quoted CSV, flexible headers, names, phone and day-first dates', () => {
  const result = parseLearnerPaste([
    'Parent/Guardian Phone,Learner Name,Date of Birth,ADM No,Sex',
    '0712345678,"Amina, Njeri",13/08/2010,ADM-12,F'
  ].join('\n'));

  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], {
    parent_phone: '0712345678',
    full_name: 'Amina, Njeri',
    date_of_birth: '2010-08-13',
    admission_no: 'ADM-12',
    gender: 'Female',
    first_name: 'Amina',
    middle_name: '',
    last_name: 'Njeri'
  });
});

test('parses tab-separated first, middle and surname columns in any order', () => {
  const result = parseLearnerPaste([
    'Surname\tAdmission Number\tLearner First Name\tGender\tMiddle Name',
    'Mutinda\t0012\tBrian\tmale\tKip'
  ].join('\n'));

  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].first_name, 'Brian');
  assert.equal(result.rows[0].middle_name, 'Kip');
  assert.equal(result.rows[0].last_name, 'Mutinda');
  assert.equal(result.rows[0].admission_no, '0012');
  assert.equal(result.rows[0].gender, 'Male');
});

test('parses the standard no-header layout when the optional photo column is blank', () => {
  const result = parseLearnerPaste([
    '\tUPI-1\tADM-1\tWanjiku Njeri\t2012-04-03\tFemale\tSTEM\tMary Njeri\t0712345678'
  ].join('\n'));

  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].assessment_no, 'UPI-1');
  assert.equal(result.rows[0].admission_no, 'ADM-1');
  assert.equal(result.rows[0].first_name, 'Wanjiku');
  assert.equal(result.rows[0].last_name, 'Njeri');
  assert.equal(result.rows[0].parent_name, 'Mary Njeri');
  assert.equal(result.rows[0].parent_phone, '0712345678');
});

test('reports pasted rows where learner names cannot be identified', () => {
  const result = parseLearnerPaste('Admission No,Full Name\nADM-1,');

  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.errors, ['Row 2: could not identify both learner first and last names.']);
});
