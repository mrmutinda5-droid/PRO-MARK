-- PRO-MARK 4.0.0 FINAL Term 3 integrity repair
-- Safe, idempotent: keeps END TERM marks, moves accidental Term-3 MID_TERM marks to OPENER,
-- removes empty MID_TERM assessments, and ensures each active class/subject has OPENER + END TERM.
BEGIN;

-- 1) For Term 3, ensure the two official assessments exist for every active class/subject
-- represented by a teacher assignment. Existing records are preserved.
WITH pairs AS (
  SELECT DISTINCT tsa.school_id, tsa.academic_year_id, tsa.term_id, tsa.class_id, tsa.subject_id
  FROM teacher_subject_assignments tsa
  JOIN terms t ON t.id=tsa.term_id AND t.term_no=3
  JOIN classes c ON c.id=tsa.class_id AND c.is_active=true
  JOIN subjects s ON s.id=tsa.subject_id AND s.is_active=true
  WHERE tsa.academic_year_id=t.academic_year_id
), wanted AS (
  SELECT p.*, x.name, x.assessment_type, x.assessment_order
  FROM pairs p CROSS JOIN (VALUES ('Opener','OPENER',1),('End Term','END_TERM',2)) x(name,assessment_type,assessment_order)
)
INSERT INTO assessments(school_id,academic_year_id,term_id,name,assessment_type,max_mark,weight,include_in_final,assessment_order,status,class_id,subject_id)
SELECT w.school_id,w.academic_year_id,w.term_id,w.name,w.assessment_type,100,0,true,w.assessment_order,'OPEN',w.class_id,w.subject_id
FROM wanted w
WHERE NOT EXISTS (
  SELECT 1 FROM assessments a
  WHERE a.school_id=w.school_id AND a.academic_year_id=w.academic_year_id AND a.term_id=w.term_id
    AND a.class_id=w.class_id AND a.subject_id=w.subject_id AND a.assessment_type=w.assessment_type
);

-- 2) Move accidental Term-3 MID_TERM marks to the matching OPENER assessment.
-- Prefer the class+subject-specific OPENER; otherwise use a school/term-wide OPENER.
WITH candidates AS (
  SELECT m.id AS mark_id, m.learner_id, m.subject_id,
         COALESCE(spec.id, global_a.id) AS opener_id
  FROM marks m
  JOIN assessments old_a ON old_a.id=m.assessment_id AND old_a.assessment_type='MID_TERM'
  JOIN terms t ON t.id=m.term_id AND t.term_no=3
  LEFT JOIN LATERAL (
    SELECT a.id FROM assessments a
    WHERE a.school_id=m.school_id AND a.academic_year_id=m.academic_year_id AND a.term_id=m.term_id
      AND a.assessment_type='OPENER' AND a.class_id=m.class_id AND a.subject_id=m.subject_id
    ORDER BY a.created_at,a.id LIMIT 1
  ) spec ON true
  LEFT JOIN LATERAL (
    SELECT a.id FROM assessments a
    WHERE a.school_id=m.school_id AND a.academic_year_id=m.academic_year_id AND a.term_id=m.term_id
      AND a.assessment_type='OPENER' AND a.class_id IS NULL AND a.subject_id IS NULL
    ORDER BY a.created_at,a.id LIMIT 1
  ) global_a ON true
  WHERE COALESCE(spec.id,global_a.id) IS NOT NULL
), conflicts AS (
  SELECT c.* FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1 FROM marks om
    WHERE om.learner_id=c.learner_id AND om.subject_id=c.subject_id AND om.assessment_id=c.opener_id
  )
)
UPDATE marks m
SET assessment_id=c.opener_id, term_id=(SELECT term_id FROM assessments WHERE id=c.opener_id),
    remark=CASE WHEN COALESCE(m.remark,'')='' THEN 'Term 3 Opener · repaired during finalization' ELSE m.remark||' · repaired to Term 3 Opener' END,
    updated_at=now()
FROM conflicts c
WHERE m.id=c.mark_id;

-- 3) Where an Opener mark already exists, preserve it and remove only the duplicate MID_TERM mark.
DELETE FROM marks m
USING assessments a, terms t
WHERE a.id=m.assessment_id AND a.assessment_type='MID_TERM' AND t.id=m.term_id AND t.term_no=3
  AND EXISTS (
    SELECT 1 FROM assessments oa
    WHERE oa.school_id=m.school_id AND oa.academic_year_id=m.academic_year_id AND oa.term_id=m.term_id
      AND oa.assessment_type='OPENER' AND (oa.class_id=m.class_id OR oa.class_id IS NULL)
      AND (oa.subject_id=m.subject_id OR oa.subject_id IS NULL)
      AND EXISTS (SELECT 1 FROM marks om WHERE om.learner_id=m.learner_id AND om.subject_id=m.subject_id AND om.assessment_id=oa.id)
  );

-- 4) Empty Term-3 MID_TERM assessment definitions are no longer valid.
DELETE FROM assessments a
WHERE a.assessment_type='MID_TERM'
  AND EXISTS (SELECT 1 FROM terms t WHERE t.id=a.term_id AND t.term_no=3)
  AND NOT EXISTS (SELECT 1 FROM marks m WHERE m.assessment_id=a.id);

COMMIT;
