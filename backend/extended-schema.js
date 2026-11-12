const db=require('./db');
module.exports=async()=>{
await db.query("-- Additive application workflow: drafts are NOT learners or enrollments.\nCREATE TABLE IF NOT EXISTS learner_admission_applications (\n id uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,\n status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_REVIEW','RETURNED','CONFIRMED')),\n payload jsonb NOT NULL DEFAULT '{}'::jsonb,\n learner_id uuid REFERENCES learners(id) ON DELETE SET NULL,\n review_note text,\n created_by uuid,\n created_at timestamptz NOT NULL DEFAULT now(),\n updated_at timestamptz NOT NULL DEFAULT now(),\n confirmed_at timestamptz\n);\nCREATE INDEX IF NOT EXISTS admission_applications_school_status_idx ON learner_admission_applications(school_id,status,updated_at DESC);\n");
// Additive Admissions metadata schema. No existing learner records are changed.
await db.query("-- Additive, school-scoped admission details; existing learners remain unchanged.\nCREATE TABLE IF NOT EXISTS learner_admission_profiles (\n learner_id uuid PRIMARY KEY REFERENCES learners(id) ON DELETE CASCADE,\n school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,\n admission_date date,\n admission_type text NOT NULL DEFAULT 'NEW',\n previous_school text,\n county text, sub_county text, home_address text,\n emergency_name text, emergency_phone text,\n allergies text, medical_notes text, learning_support text,\n residence_type text, transport_required boolean NOT NULL DEFAULT false,\n transport_route text, documents_pending text,\n guardian_relationship text, guardian_alt_phone text, guardian_occupation text,\n created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),\n CONSTRAINT learner_admission_type_chk CHECK(admission_type IN ('NEW','TRANSFER','READMISSION'))\n);");
await db.query(`CREATE TABLE IF NOT EXISTS school_module_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 record_type text NOT NULL,data jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_by uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
)`);await db.query('CREATE INDEX IF NOT EXISTS school_module_records_scope_idx ON school_module_records(school_id,record_type,created_at DESC)');
await db.query(`CREATE TABLE IF NOT EXISTS biometric_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 name varchar(100) NOT NULL, manufacturer varchar(100) NOT NULL DEFAULT '', model varchar(100) NOT NULL DEFAULT '',
 connection_type varchar(32) NOT NULL DEFAULT 'UNCONFIGURED', status varchar(32) NOT NULL DEFAULT 'PLANNED',
 last_seen_at timestamptz, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT biometric_device_status_chk CHECK(status IN ('PLANNED','CONFIGURING','CONNECTED','DISABLED'))
)`);
await db.query(`CREATE TABLE IF NOT EXISTS biometric_person_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 device_id uuid NOT NULL REFERENCES biometric_devices(id) ON DELETE CASCADE,
 person_type varchar(10) NOT NULL CHECK(person_type IN ('LEARNER','STAFF')), person_id uuid NOT NULL,
 external_reference varchar(128) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(school_id,device_id,external_reference), UNIQUE(school_id,device_id,person_type,person_id)
)`);
await db.query(`CREATE TABLE IF NOT EXISTS biometric_attendance_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 device_id uuid REFERENCES biometric_devices(id) ON DELETE SET NULL,
 person_type varchar(10) NOT NULL CHECK(person_type IN ('LEARNER','STAFF')), person_id uuid NOT NULL,
 event_type varchar(10) NOT NULL CHECK(event_type IN ('CHECK_IN','CHECK_OUT')),
 event_time timestamptz NOT NULL, source varchar(12) NOT NULL CHECK(source IN ('MANUAL','DEVICE')),
 verification_status varchar(20) NOT NULL CHECK(verification_status IN ('NOT_BIOMETRIC','PENDING','VERIFIED','REJECTED')),
 external_event_id varchar(128), recorded_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(school_id,device_id,external_event_id)
)`);
await db.query('CREATE INDEX IF NOT EXISTS biometric_events_school_time_idx ON biometric_attendance_events(school_id,event_time DESC)');
};
