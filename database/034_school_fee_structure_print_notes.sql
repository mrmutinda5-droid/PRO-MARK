-- Editable text printed on school fee structures and learner fee statements.
BEGIN;

ALTER TABLE school_fee_structures
  ADD COLUMN IF NOT EXISTS print_notes text NOT NULL DEFAULT '';

COMMIT;
