'use strict';

const express = require('express');
const db = require('../db');
const { authenticate, schoolBoundary, roles } = require('../middleware/auth');
const { calculateDeviation } = require('../services/subject-deviation-engine');

const router = express.Router();
router.use(authenticate);

const view = roles(
  'SCHOOL_ADMIN','ADMIN','HEADTEACHER',
  'DEPUTY_HEADTEACHER','SENIOR_TEACHER'
);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get('/:schoolId', schoolBoundary, view, async (req,res) => {
  try {
    const sid = req.params.schoolId;
    const {
      academic_year_id, term_id, class_id, subject_id,
      previous_assessment_id, current_assessment_id
    } = req.query;

    const ids = [
      sid,academic_year_id,term_id,class_id,subject_id,
      previous_assessment_id,current_assessment_id
    ];

    if (!ids.every(v => uuid.test(String(v||'')))) {
      return res.status(400).json({error:'Select valid comparison filters.'});
    }

    if (previous_assessment_id === current_assessment_id) {
      return res.status(400).json({error:'Select two different assessments.'});
    }

    const assessments = (await db.query(`
      SELECT id,name,subject_id,max_mark
      FROM assessments
      WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3
        AND (class_id=$4 OR class_id IS NULL)
        AND (subject_id=$5 OR subject_id IS NULL)
        AND id=ANY($6::uuid[])
    `,[
      sid,academic_year_id,term_id,class_id,subject_id,
      [previous_assessment_id,current_assessment_id]
    ])).rows;

    if (assessments.length !== 2) {
      return res.status(400).json({
        error:'Selected assessments do not match the subject and class.'
      });
    }

    const learners = (await db.query(`
      SELECT DISTINCT l.id,l.admission_no,l.first_name,l.last_name
      FROM learners l
      JOIN learner_enrollments le
        ON le.learner_id=l.id AND le.school_id=l.school_id
      WHERE l.school_id=$1
        AND le.academic_year_id=$2
        AND le.class_id=$3
        AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
      ORDER BY l.first_name,l.last_name
    `,[sid,academic_year_id,class_id])).rows;

    const marks = (await db.query(`
      SELECT m.learner_id,m.assessment_id,
             m.mark*100.0/NULLIF(a.max_mark,0) AS percent
      FROM marks m
      JOIN assessments a
        ON a.id=m.assessment_id AND a.school_id=m.school_id
      WHERE m.school_id=$1
        AND m.academic_year_id=$2
        AND m.term_id=$3
        AND m.subject_id=$4
        AND m.assessment_id=ANY($5::uuid[])
        AND m.learner_id=ANY($6::uuid[])
    `,[
      sid,academic_year_id,term_id,subject_id,
      [previous_assessment_id,current_assessment_id],
      learners.map(l=>l.id)
    ])).rows;

    const result = calculateDeviation(
      learners,
      marks.filter(m=>String(m.assessment_id)===previous_assessment_id),
      marks.filter(m=>String(m.assessment_id)===current_assessment_id)
    );

    res.json({
      ...result,
      previous_assessment: assessments.find(a=>String(a.id)===previous_assessment_id)?.name,
      current_assessment: assessments.find(a=>String(a.id)===current_assessment_id)?.name
    });
  } catch(e) {
    console.error('[SUBJECT DEVIATION]',e);
    res.status(500).json({error:'Unable to calculate subject deviation.'});
  }
});

module.exports = router;
