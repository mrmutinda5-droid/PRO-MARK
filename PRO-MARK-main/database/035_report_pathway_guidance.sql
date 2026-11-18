-- Add term-scoped learner pathway guidance without changing existing learner or mark records.
CREATE TABLE IF NOT EXISTS report_pathway_guidance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  selected_pathway text,
  track_specialisation text,
  pathway_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  strengths text,
  competency_development text,
  development_area text,
  career_exploration text,
  teacher_guidance text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_pathway_guidance_context_unique UNIQUE (school_id, learner_id, academic_year_id, term_id),
  CONSTRAINT report_pathway_guidance_evidence_object CHECK (jsonb_typeof(pathway_evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS report_pathway_guidance_context_idx
  ON report_pathway_guidance(school_id, academic_year_id, term_id, learner_id);
