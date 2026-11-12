-- Store each school's independently selected ID-card and certificate designs.
BEGIN;

CREATE TABLE IF NOT EXISTS school_document_template_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('ID_CARD','CERTIFICATE')),
  category text NOT NULL DEFAULT 'DEFAULT',
  template_id text NOT NULL,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, document_type, category),
  CHECK (
    (document_type='ID_CARD' AND category='DEFAULT')
    OR (document_type='CERTIFICATE' AND category IN (
      'ACADEMIC_ACHIEVEMENT','SUBJECT_PERFORMANCE','MOST_IMPROVED',
      'COMPLETION','CO_CURRICULAR','SPORTS','SCHOOL_RECOGNITION','DEFAULT'
    ))
  )
);

CREATE INDEX IF NOT EXISTS school_document_template_preferences_scope_idx
  ON school_document_template_preferences(school_id,document_type,category);

COMMIT;
