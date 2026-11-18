-- Categorize certificates and allow an authorised draft PDF preview.
BEGIN;

ALTER TABLE school_academic_certificates
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'ACADEMIC_ACHIEVEMENT';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'school_academic_certificates_category_check'
      AND conrelid = 'school_academic_certificates'::regclass
  ) THEN
    ALTER TABLE school_academic_certificates
      ADD CONSTRAINT school_academic_certificates_category_check
      CHECK (category IN (
        'ACADEMIC_ACHIEVEMENT',
        'SUBJECT_PERFORMANCE',
        'MOST_IMPROVED',
        'COMPLETION',
        'CO_CURRICULAR',
        'SPORTS',
        'SCHOOL_RECOGNITION'
      ));
  END IF;
END $$;

COMMIT;
