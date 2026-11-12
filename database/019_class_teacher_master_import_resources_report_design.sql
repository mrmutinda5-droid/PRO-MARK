BEGIN;
ALTER TABLE learners ADD COLUMN IF NOT EXISTS parent_phone text;
ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS config jsonb DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS school_resource_documents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 title text NOT NULL, resource_type text NOT NULL CHECK(resource_type IN ('SCHEME_OF_WORK','NOTES','REVISION_PAPER','TEACHER_GUIDE','OTHER','PDF')),
 file_url text NOT NULL, original_name text, description text DEFAULT '', subject_id uuid REFERENCES subjects(id) ON DELETE SET NULL, class_id uuid REFERENCES classes(id) ON DELETE SET NULL, academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL, uploaded_by uuid REFERENCES users(id), is_active boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_school_resources ON school_resource_documents(school_id,is_active,resource_type,created_at DESC);
COMMIT;
