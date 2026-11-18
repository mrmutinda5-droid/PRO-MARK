-- Additive, school-scoped admission details; existing learners remain unchanged.
CREATE TABLE IF NOT EXISTS learner_admission_profiles (
 learner_id uuid PRIMARY KEY REFERENCES learners(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 admission_date date,
 admission_type text NOT NULL DEFAULT 'NEW',
 previous_school text,
 county text, sub_county text, home_address text,
 emergency_name text, emergency_phone text,
 allergies text, medical_notes text, learning_support text,
 residence_type text, transport_required boolean NOT NULL DEFAULT false,
 transport_route text, documents_pending text,
 guardian_relationship text, guardian_alt_phone text, guardian_occupation text,
 created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT learner_admission_type_chk CHECK(admission_type IN ('NEW','TRANSFER','READMISSION'))
);
CREATE INDEX IF NOT EXISTS learner_admission_school_idx ON learner_admission_profiles(school_id,created_at DESC);
