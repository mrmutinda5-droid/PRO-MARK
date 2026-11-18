BEGIN;
ALTER TABLE school_resource_documents
  ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES subjects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL;
ALTER TABLE school_resource_documents DROP CONSTRAINT IF EXISTS school_resource_documents_resource_type_check;
ALTER TABLE school_resource_documents ADD CONSTRAINT school_resource_documents_resource_type_check CHECK(resource_type IN ('SCHEME_OF_WORK','NOTES','REVISION_PAPER','TEACHER_GUIDE','OTHER','PDF'));
CREATE INDEX IF NOT EXISTS idx_school_resources_catalog ON school_resource_documents(school_id,is_active,resource_type,subject_id,class_id,academic_year_id,title);
COMMIT;
