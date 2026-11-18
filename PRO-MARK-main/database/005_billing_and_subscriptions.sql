-- PRO-MARK 3.5 — billing/subscription foundation
-- Safe/idempotent migration. Does not touch academic data.

CREATE TABLE IF NOT EXISTS billing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  description text DEFAULT '',
  amount numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  billing_cycle text NOT NULL DEFAULT 'ANNUAL',
  grace_days int NOT NULL DEFAULT 7,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount >= 0),
  CHECK (billing_cycle IN ('MONTHLY','TERMLY','QUARTERLY','HALF_YEARLY','ANNUAL','CUSTOM')),
  CHECK (grace_days >= 0)
);

CREATE TABLE IF NOT EXISTS platform_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  instructions text DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS school_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES billing_plans(id) ON DELETE SET NULL,
  plan_name_snapshot text NOT NULL DEFAULT '',
  amount numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  billing_cycle text NOT NULL DEFAULT 'ANNUAL',
  starts_on date NOT NULL,
  next_due_on date,
  grace_days int NOT NULL DEFAULT 7,
  status text NOT NULL DEFAULT 'ACTIVE',
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount >= 0),
  CHECK (billing_cycle IN ('MONTHLY','TERMLY','QUARTERLY','HALF_YEARLY','ANNUAL','CUSTOM')),
  CHECK (status IN ('TRIAL','ACTIVE','PAUSED','CANCELLED','EXPIRED')),
  CHECK (grace_days >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_school_current_subscription
  ON school_subscriptions(school_id) WHERE status IN ('TRIAL','ACTIVE','PAUSED');
CREATE INDEX IF NOT EXISTS idx_school_subscriptions_due ON school_subscriptions(next_due_on,status);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES school_subscriptions(id) ON DELETE SET NULL,
  invoice_no text UNIQUE NOT NULL,
  description text DEFAULT '',
  amount numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  issued_on date NOT NULL DEFAULT CURRENT_DATE,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'DUE',
  amount_paid numeric(12,2) NOT NULL DEFAULT 0,
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount >= 0),
  CHECK (amount_paid >= 0),
  CHECK (status IN ('DUE','DUE_SOON','PENDING_VERIFICATION','PARTIALLY_PAID','PAID','OVERDUE','WAIVED','CANCELLED','FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_school ON billing_invoices(school_id,issued_on DESC);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_due ON billing_invoices(due_on,status);

CREATE TABLE IF NOT EXISTS billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  payment_method_id uuid REFERENCES platform_payment_methods(id) ON DELETE SET NULL,
  payment_method_name_snapshot text NOT NULL DEFAULT '',
  amount numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  reference text DEFAULT '',
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'PENDING_VERIFICATION',
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount > 0),
  CHECK (status IN ('PENDING_VERIFICATION','CONFIRMED','REJECTED','REFUNDED'))
);
CREATE INDEX IF NOT EXISTS idx_billing_payments_invoice ON billing_payments(invoice_id,created_at DESC);

CREATE TABLE IF NOT EXISTS billing_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES billing_invoices(id) ON DELETE SET NULL,
  recipient_role text DEFAULT 'SCHOOL_ADMIN',
  title text NOT NULL,
  message text NOT NULL,
  severity text NOT NULL DEFAULT 'INFO',
  status text NOT NULL DEFAULT 'UNREAD',
  sent_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CHECK (severity IN ('INFO','WARNING','URGENT')),
  CHECK (status IN ('UNREAD','READ','ARCHIVED'))
);
CREATE INDEX IF NOT EXISTS idx_billing_notifications_school ON billing_notifications(school_id,status,sent_at DESC);

INSERT INTO billing_plans(code,name,description,amount,currency,billing_cycle,grace_days)
VALUES ('ANNUAL_STANDARD','Annual Standard','PRO-MARK annual school subscription — configurable by Platform Owner',0,'KES','ANNUAL',7)
ON CONFLICT(code) DO NOTHING;

INSERT INTO platform_payment_methods(code,name,instructions,sort_order) VALUES
('MPESA','M-PESA','Configure Paybill/Till number and account instructions here.',1),
('BANK','Bank Transfer','Configure bank name, account number/name and branch instructions here.',2),
('CARD','Card','Use an approved card payment gateway when enabled.',3),
('MOBILE_MONEY','Mobile Money','Configure supported mobile-money instructions here.',4),
('MANUAL','Manual / Offline','Use for cash or other approved offline payments. Record the reference.',5)
ON CONFLICT(code) DO NOTHING;
