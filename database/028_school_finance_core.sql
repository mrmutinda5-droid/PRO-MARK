-- ZELIMU CBC school fee ledger (separate from platform subscription billing).
-- Apply manually after taking a database backup. This migration does not alter existing academic records.
BEGIN;
CREATE TABLE IF NOT EXISTS school_fee_structures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  academic_year_id uuid REFERENCES academic_years(id),
  class_id uuid REFERENCES classes(id),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'KES',
  due_on date,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX IF NOT EXISTS school_fee_structures_school_idx ON school_fee_structures(school_id,is_active);

CREATE TABLE IF NOT EXISTS school_fee_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id uuid NOT NULL REFERENCES learners(id),
  fee_structure_id uuid REFERENCES school_fee_structures(id),
  description text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  due_on date,
  academic_year_id uuid REFERENCES academic_years(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,learner_id,fee_structure_id)
);
CREATE INDEX IF NOT EXISTS school_fee_charges_learner_idx ON school_fee_charges(school_id,learner_id,due_on);

CREATE TABLE IF NOT EXISTS school_fee_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id uuid NOT NULL REFERENCES learners(id),
  receipt_no text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'KES',
  payment_method text NOT NULL DEFAULT 'CASH',
  reference text NOT NULL DEFAULT '',
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('CONFIRMED','VOIDED')),
  recorded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,receipt_no),
  CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX IF NOT EXISTS school_fee_payments_learner_idx ON school_fee_payments(school_id,learner_id,payment_date DESC);

CREATE TABLE IF NOT EXISTS school_fee_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES school_fee_payments(id) ON DELETE CASCADE,
  charge_id uuid NOT NULL REFERENCES school_fee_charges(id),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_id,charge_id)
);
CREATE INDEX IF NOT EXISTS school_fee_allocations_charge_idx ON school_fee_payment_allocations(charge_id);
COMMIT;
