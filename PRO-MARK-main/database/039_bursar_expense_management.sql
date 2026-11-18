-- Dedicated bursar access and auditable school expenditure management.
-- Apply manually after backing up the database.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'BURSAR';

BEGIN;

CREATE TABLE IF NOT EXISTS school_finance_expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name),
  UNIQUE (school_id, id)
);

CREATE TABLE IF NOT EXISTS school_finance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  expense_no text NOT NULL,
  category_id uuid NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('CASH','MPESA','BANK','CHEQUE','OTHER')),
  payment_reference text NOT NULL DEFAULT '',
  supplier text NOT NULL DEFAULT '',
  transaction_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'RECORDED'
    CHECK (status IN ('RECORDED','SUBMITTED','APPROVED','REJECTED','PAID','CANCELLED')),
  recorded_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approval_note text NOT NULL DEFAULT '',
  approved_at timestamptz,
  paid_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, expense_no),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, category_id)
    REFERENCES school_finance_expense_categories(school_id, id)
);

CREATE TABLE IF NOT EXISTS school_finance_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  previous_values jsonb,
  new_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS school_finance_expenses_date_idx
  ON school_finance_expenses(school_id, transaction_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS school_finance_expenses_status_idx
  ON school_finance_expenses(school_id, status, transaction_date DESC);
CREATE INDEX IF NOT EXISTS school_finance_expenses_category_idx
  ON school_finance_expenses(school_id, category_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS school_finance_audit_events_entity_idx
  ON school_finance_audit_events(school_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS school_finance_audit_events_school_idx
  ON school_finance_audit_events(school_id, created_at DESC);

INSERT INTO school_finance_expense_categories(school_id, name)
SELECT s.id, category.name
FROM schools s
CROSS JOIN (VALUES
  ('Salaries'), ('Utilities'), ('Food and catering'), ('Transport'),
  ('Fuel'), ('Learning materials'), ('Stationery'), ('Maintenance'),
  ('Repairs'), ('Administration'), ('Other approved expenses')
) AS category(name)
ON CONFLICT (school_id, name) DO NOTHING;

COMMIT;
