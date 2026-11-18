BEGIN;

-- Ensure every existing academic year has the complete three-term structure.
INSERT INTO terms(school_id, academic_year_id, term_no, name)
SELECT ay.school_id, ay.id, v.term_no, 'Term ' || v.term_no
FROM academic_years ay
CROSS JOIN (VALUES (1),(2),(3)) AS v(term_no)
WHERE NOT EXISTS (
  SELECT 1 FROM terms t
  WHERE t.academic_year_id = ay.id AND t.term_no = v.term_no
);

-- Backfill the current/latest academic enrollment only where a learner already has
-- a current class and no enrollment row exists. This never invents historical years.
INSERT INTO learner_enrollments(school_id, learner_id, academic_year_id, class_id, status)
SELECT l.school_id, l.id, ay.id, l.class_id, 'ACTIVE'
FROM learners l
JOIN LATERAL (
  SELECT id FROM academic_years
  WHERE school_id = l.school_id
  ORDER BY start_date DESC NULLS LAST, year_label DESC
  LIMIT 1
) ay ON true
WHERE l.class_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM learner_enrollments e
    WHERE e.learner_id = l.id AND e.academic_year_id = ay.id
  );

CREATE INDEX IF NOT EXISTS idx_learner_enrollments_year_class
  ON learner_enrollments(school_id, academic_year_id, class_id, learner_id);

COMMIT;
