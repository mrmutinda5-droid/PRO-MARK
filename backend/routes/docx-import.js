const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { schoolBoundary, roles } = require('../middleware/auth');
const { extractLearnersFromDocx } = require('../services/docx-roster-parser');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

router.post(
  '/:schoolId/preview',
  schoolBoundary,
  roles('SCHOOL_ADMIN', 'ADMIN', 'CLASS_TEACHER', 'SENIOR_TEACHER'),
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Please select a Microsoft Word (.docx) document.' });
      const { schoolId } = req.params;
      const { class_id } = req.body;

      let isSenior = false;
      let className = 'Selected Class';

      if (class_id) {
        const clsRes = await db.query(
          `SELECT cl.id, cl.name, cl.stream, sl.name AS level_name, ss.name AS section_name
           FROM classes cl
           LEFT JOIN school_levels sl ON sl.id = cl.school_level_id
           LEFT JOIN school_sections ss ON ss.id = sl.school_section_id
           WHERE cl.id = $1 AND cl.school_id = $2 LIMIT 1`,
          [class_id, schoolId]
        );
        if (clsRes.rows.length) {
          const row = clsRes.rows[0];
          className = `${row.name} ${row.stream || ''}`.trim();
          const lvl = String(row.level_name || '').toUpperCase();
          const sec = String(row.section_name || '').toUpperCase();
          isSenior = /SENIOR|GRADE_10|GRADE_11|GRADE_12|FORM_3|FORM_4|10|11|12/.test(lvl) || /SENIOR/.test(sec);
        }
      }

      const parsed = extractLearnersFromDocx(req.file.buffer, isSenior);

      const existingRes = await db.query(
        `SELECT id, admission_no, assessment_no, first_name, last_name
         FROM learners
         WHERE school_id = $1`,
        [schoolId]
      );
      const existingAdms = new Map();
      const existingAss = new Map();
      for (const row of existingRes.rows) {
        if (row.admission_no) existingAdms.set(row.admission_no.toLowerCase().trim(), row);
        if (row.assessment_no) existingAss.set(row.assessment_no.toLowerCase().trim(), row);
      }

      const learnersWithStatus = parsed.learners.map(l => {
        const dupAdm = l.admission_no ? existingAdms.get(l.admission_no.toLowerCase().trim()) : null;
        const dupAss = l.assessment_no ? existingAss.get(l.assessment_no.toLowerCase().trim()) : null;
        return {
          ...l,
          photo_buffer: undefined,
          is_duplicate: Boolean(dupAdm || dupAss),
          duplicate_reason: dupAdm
            ? `Admission no. ${l.admission_no} already exists (${dupAdm.first_name} ${dupAdm.last_name})`
            : dupAss
            ? `Assessment no. ${l.assessment_no} already exists (${dupAss.first_name} ${dupAss.last_name})`
            : null
        };
      });

      res.json({
        success: true,
        class_name: className,
        is_senior_school: isSenior,
        total_found: parsed.total_found,
        photos_matched: parsed.photos_matched,
        duplicates_count: learnersWithStatus.filter(l => l.is_duplicate).length,
        learners: learnersWithStatus
      });
    } catch (err) {
      console.error('Word document preview error:', err);
      res.status(400).json({ error: err.message || 'Unable to parse Word document.' });
    }
  }
);

router.post(
  '/:schoolId/commit',
  schoolBoundary,
  roles('SCHOOL_ADMIN', 'ADMIN', 'CLASS_TEACHER', 'SENIOR_TEACHER'),
  upload.single('file'),
  async (req, res) => {
    const client = await db.pool.connect();
    try {
      if (!req.file) return res.status(400).json({ error: 'Please select a Microsoft Word (.docx) document.' });
      const { schoolId } = req.params;
      const { class_id, academic_year_id } = req.body;

      if (!class_id || !academic_year_id) {
        return res.status(400).json({ error: 'Target Class and Academic Year are required.' });
      }

      const clsRes = await client.query(
        `SELECT cl.id, cl.name, cl.stream, sl.name AS level_name, ss.name AS section_name
         FROM classes cl
         LEFT JOIN school_levels sl ON sl.id = cl.school_level_id
         LEFT JOIN school_sections ss ON ss.id = sl.school_section_id
         WHERE cl.id = $1 AND cl.school_id = $2 LIMIT 1`,
        [class_id, schoolId]
      );
      if (!clsRes.rows.length) return res.status(404).json({ error: 'Class not found.' });

      const isSenior = /SENIOR|GRADE_10|GRADE_11|GRADE_12|FORM_3|FORM_4|10|11|12/.test(String(clsRes.rows[0].level_name || '').toUpperCase());
      const parsed = extractLearnersFromDocx(req.file.buffer, isSenior);

      if (!parsed.learners.length) return res.status(400).json({ error: 'No valid learner records found.' });

      const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads', schoolId);
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      await client.query('BEGIN');
      const enrolled = [];
      const skipped = [];

      for (const l of parsed.learners) {
        const dup = await client.query(
          `SELECT id FROM learners WHERE school_id = $1 AND (
             (NULLIF(trim($2::text),'') IS NOT NULL AND lower(trim(admission_no))=lower(trim($2::text))) OR
             (NULLIF(trim($3::text),'') IS NOT NULL AND lower(trim(assessment_no))=lower(trim($3::text)))
           ) LIMIT 1`,
          [schoolId, l.admission_no || '', l.assessment_no || '']
        );

        if (dup.rows.length) {
          skipped.push({ admission_no: l.admission_no, reason: 'Already registered' });
          continue;
        }

        let photoUrl = null;
        if (l.photo_buffer) {
          const safeAdm = String(l.admission_no).replace(/[^a-zA-Z0-9_-]/g, '_');
          const photoFilename = `passport_${safeAdm}_${Date.now()}.${l.photo_ext}`;
          const photoPath = path.join(uploadDir, photoFilename);
          fs.writeFileSync(photoPath, l.photo_buffer);
          photoUrl = `/uploads/${schoolId}/${photoFilename}`;
        }

        const learnerRes = await client.query(
          `INSERT INTO learners (
             school_id, admission_no, assessment_no, first_name, middle_name, last_name,
             date_of_birth, gender, class_id, parent_phone, passport_photo_url
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id, admission_no, first_name, last_name`,
          [
            schoolId,
            l.admission_no || null,
            l.assessment_no || null,
            l.first_name,
            l.middle_name || null,
            l.last_name,
            l.date_of_birth || null,
            l.gender || null,
            class_id,
            l.parent_phone || null,
            photoUrl
          ]
        );

        const newLearner = learnerRes.rows[0];

        await client.query(
          `INSERT INTO learner_enrollments (school_id, learner_id, academic_year_id, class_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (learner_id, academic_year_id) DO UPDATE SET class_id = EXCLUDED.class_id`,
          [schoolId, newLearner.id, academic_year_id, class_id]
        );

        if (isSenior && l.cbc_pathway) {
          try {
            await client.query(
              `INSERT INTO report_pathway_guidance (
                 school_id, learner_id, academic_year_id, selected_pathway, track_specialisation
               ) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (school_id, learner_id, academic_year_id, term_id)
               DO UPDATE SET selected_pathway = EXCLUDED.selected_pathway, track_specialisation = EXCLUDED.track_specialisation`,
              [schoolId, newLearner.id, academic_year_id, l.cbc_pathway, l.pathway_track || 'General']
            );
          } catch (_) {}
        }

        if (l.parent_name && l.parent_phone) {
          try {
            const pRes = await client.query(
              `INSERT INTO parents (school_id, first_name, last_name, phone)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING RETURNING id`,
              [schoolId, l.parent_name, 'Parent', l.parent_phone]
            );
            const parentId = pRes.rows[0]?.id;
            if (parentId) {
              await client.query(
                `INSERT INTO parent_learners (school_id, parent_id, learner_id, relationship)
                 VALUES ($1, $2, $3, 'Parent')
                 ON CONFLICT DO NOTHING`,
                [schoolId, parentId, newLearner.id]
              );
            }
          } catch (_) {}
        }

        enrolled.push({
          id: newLearner.id,
          admission_no: newLearner.admission_no,
          name: `${newLearner.first_name} ${newLearner.last_name}`,
          photo_saved: Boolean(photoUrl),
          pathway: l.cbc_pathway
        });
      }

      await client.query('COMMIT');
      res.json({
        success: true,
        message: `Successfully enrolled ${enrolled.length} learner(s) with photos and records.`,
        enrolled_count: enrolled.length,
        skipped_count: skipped.length,
        enrolled,
        skipped
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Word document commit error:', err);
      res.status(500).json({ error: err.message || 'Unable to complete learner enrollment.' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
