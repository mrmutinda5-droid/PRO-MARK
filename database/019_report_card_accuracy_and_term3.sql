-- PRO-MARK 4.0.0 report-card accuracy patch
-- Term 3 = OPENER + END TERM. The current Kauti workbook marks are OPENER marks.
-- This file documents the same idempotent repair executed by backend/schema-compat.js.
BEGIN;

-- Ensure the two official Term 3 assessments exist for active teacher assignments.
WITH pairs AS (
  SELECT DISTINCT tsa.school_id,tsa.academic_year_id,tsa.term_id,tsa.class_id,tsa.subject_id
  FROM teacher_subject_assignments tsa
  JOIN terms t ON t.id=tsa.term_id AND t.term_no=3 AND t.academic_year_id=tsa.academic_year_id
  WHERE COALESCE(tsa.is_active,true)=true
), wanted AS (
  SELECT p.*,v.name,v.assessment_type,v.assessment_order FROM pairs p
  CROSS JOIN (VALUES ('Opener','OPENER',1),('End Term','END_TERM',2)) v(name,assessment_type,assessment_order)
)
INSERT INTO assessments(school_id,academic_year_id,term_id,name,assessment_type,max_mark,weight,include_in_final,assessment_order,status,class_id,subject_id)
SELECT w.school_id,w.academic_year_id,w.term_id,w.name,w.assessment_type,100,0,true,w.assessment_order,'OPEN',w.class_id,w.subject_id
FROM wanted w
WHERE NOT EXISTS (
 SELECT 1 FROM assessments a WHERE a.school_id=w.school_id AND a.academic_year_id=w.academic_year_id
 AND a.term_id=w.term_id AND a.class_id=w.class_id AND a.subject_id=w.subject_id
 AND a.assessment_type=w.assessment_type
);

-- Move the imported Term 3 workbook values from accidental END TERM to OPENER.
WITH candidates AS (
 SELECT m.id,op.id opener_id
 FROM marks m
 JOIN assessments ea ON ea.id=m.assessment_id AND ea.assessment_type='END_TERM'
 JOIN terms et ON et.id=m.term_id AND et.term_no=3
 JOIN LATERAL (
   SELECT oa.id FROM assessments oa
   WHERE oa.school_id=m.school_id AND oa.academic_year_id=m.academic_year_id AND oa.term_id=m.term_id
     AND oa.assessment_type='OPENER'
     AND (oa.class_id=m.class_id OR oa.class_id IS NULL)
     AND (oa.subject_id=m.subject_id OR oa.subject_id IS NULL)
   ORDER BY (oa.class_id IS NOT NULL) DESC,(oa.subject_id IS NOT NULL) DESC,oa.created_at,oa.id
   LIMIT 1
 ) op ON true
 WHERE COALESCE(m.remark,'') ILIKE 'Imported from%workbook%'
   AND NOT EXISTS (
     SELECT 1 FROM marks om WHERE om.learner_id=m.learner_id AND om.subject_id=m.subject_id AND om.assessment_id=op.id
   )
)
UPDATE marks m
SET assessment_id=c.opener_id,term_id=(SELECT term_id FROM assessments WHERE id=c.opener_id),
    updated_at=now(),remark='Imported from Kauti workbook · repaired as Term 3 Opener'
FROM candidates c WHERE m.id=c.id;

-- If an Opener row already exists, remove only the duplicate imported END TERM row.
DELETE FROM marks m USING assessments a,terms t
WHERE a.id=m.assessment_id AND a.assessment_type='END_TERM' AND t.id=m.term_id AND t.term_no=3
  AND COALESCE(m.remark,'') ILIKE 'Imported from%workbook%'
  AND EXISTS (
    SELECT 1 FROM marks om JOIN assessments oa ON oa.id=om.assessment_id
    WHERE om.learner_id=m.learner_id AND om.subject_id=m.subject_id
      AND om.academic_year_id=m.academic_year_id AND om.school_id=m.school_id
      AND oa.assessment_type='OPENER'
  );

COMMIT;
