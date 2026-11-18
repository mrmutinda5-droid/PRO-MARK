-- School fees ledger safeguards. Apply after 028_school_finance_core.sql.
-- Existing receipts remain unchanged; legacy duplicate references are preserved.
BEGIN;

ALTER TABLE school_fee_payments
  ADD COLUMN IF NOT EXISTS reference_fingerprint text;

WITH unique_references AS (
  SELECT school_id,lower(btrim(reference)) fingerprint
  FROM school_fee_payments
  WHERE NULLIF(btrim(reference),'') IS NOT NULL
  GROUP BY school_id,lower(btrim(reference))
  HAVING count(*)=1
)
UPDATE school_fee_payments p
SET reference_fingerprint=u.fingerprint
FROM unique_references u
WHERE p.school_id=u.school_id
  AND lower(btrim(p.reference))=u.fingerprint
  AND p.reference_fingerprint IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS school_fee_payment_reference_unique
  ON school_fee_payments(school_id,reference_fingerprint)
  WHERE reference_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS school_fee_payment_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES school_fee_payments(id) ON DELETE CASCADE,
  credit_note_no text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  recorded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,payment_id),
  UNIQUE(school_id,credit_note_no)
);
CREATE INDEX IF NOT EXISTS school_fee_payment_reversals_school_idx
  ON school_fee_payment_reversals(school_id,created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS classes_school_id_id_unique
  ON classes(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS learners_school_id_id_unique
  ON learners(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS school_fee_structures_school_id_id_unique
  ON school_fee_structures(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS school_fee_charges_school_id_id_unique
  ON school_fee_charges(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS school_fee_payments_school_id_id_unique
  ON school_fee_payments(school_id,id);

ALTER TABLE school_fee_structures
  ADD CONSTRAINT school_fee_structures_class_school_fk
  FOREIGN KEY(school_id,class_id) REFERENCES classes(school_id,id);
ALTER TABLE school_fee_charges
  ADD CONSTRAINT school_fee_charges_learner_school_fk
  FOREIGN KEY(school_id,learner_id) REFERENCES learners(school_id,id),
  ADD CONSTRAINT school_fee_charges_structure_school_fk
  FOREIGN KEY(school_id,fee_structure_id) REFERENCES school_fee_structures(school_id,id);
ALTER TABLE school_fee_payments
  ADD CONSTRAINT school_fee_payments_learner_school_fk
  FOREIGN KEY(school_id,learner_id) REFERENCES learners(school_id,id);
ALTER TABLE school_fee_payment_allocations
  ADD CONSTRAINT school_fee_allocations_payment_school_fk
  FOREIGN KEY(school_id,payment_id) REFERENCES school_fee_payments(school_id,id) ON DELETE CASCADE,
  ADD CONSTRAINT school_fee_allocations_charge_school_fk
  FOREIGN KEY(school_id,charge_id) REFERENCES school_fee_charges(school_id,id);
ALTER TABLE school_fee_payment_reversals
  ADD CONSTRAINT school_fee_reversals_payment_school_fk
  FOREIGN KEY(school_id,payment_id) REFERENCES school_fee_payments(school_id,id) ON DELETE CASCADE;

WITH payment_totals AS (
  SELECT p.id payment_id,p.school_id,p.learner_id,p.payment_date,p.created_at,
    GREATEST(p.amount-COALESCE(sum(a.amount),0),0) remaining
  FROM school_fee_payments p
  LEFT JOIN school_fee_payment_allocations a
    ON a.school_id=p.school_id AND a.payment_id=p.id
  WHERE p.status='CONFIRMED'
    AND NOT EXISTS(
      SELECT 1 FROM school_fee_payment_reversals r
      WHERE r.school_id=p.school_id AND r.payment_id=p.id
    )
  GROUP BY p.id,p.school_id,p.learner_id,p.payment_date,p.created_at,p.amount
),
payment_ranges AS (
  SELECT payment_id,school_id,learner_id,remaining,
    COALESCE(sum(remaining) OVER(
      PARTITION BY school_id,learner_id
      ORDER BY payment_date,created_at,payment_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),0) range_start,
    sum(remaining) OVER(
      PARTITION BY school_id,learner_id
      ORDER BY payment_date,created_at,payment_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) range_end
  FROM payment_totals
  WHERE remaining>0
),
charge_totals AS (
  SELECT ch.id charge_id,ch.school_id,ch.learner_id,ch.due_on,ch.created_at,
    GREATEST(ch.amount-COALESCE(sum(a.amount),0),0) remaining
  FROM school_fee_charges ch
  LEFT JOIN (
    SELECT a.school_id,a.charge_id,a.amount
    FROM school_fee_payment_allocations a
    JOIN school_fee_payments p
      ON p.school_id=a.school_id AND p.id=a.payment_id AND p.status='CONFIRMED'
    WHERE NOT EXISTS(
      SELECT 1 FROM school_fee_payment_reversals r
      WHERE r.school_id=p.school_id AND r.payment_id=p.id
    )
  ) a ON a.school_id=ch.school_id AND a.charge_id=ch.id
  GROUP BY ch.id,ch.school_id,ch.learner_id,ch.due_on,ch.created_at,ch.amount
),
charge_ranges AS (
  SELECT charge_id,school_id,learner_id,remaining,
    COALESCE(sum(remaining) OVER(
      PARTITION BY school_id,learner_id
      ORDER BY due_on NULLS LAST,created_at,charge_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),0) range_start,
    sum(remaining) OVER(
      PARTITION BY school_id,learner_id
      ORDER BY due_on NULLS LAST,created_at,charge_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) range_end
  FROM charge_totals
  WHERE remaining>0
)
INSERT INTO school_fee_payment_allocations(school_id,payment_id,charge_id,amount)
SELECT p.school_id,p.payment_id,ch.charge_id,
  LEAST(p.range_end,ch.range_end)-GREATEST(p.range_start,ch.range_start)
FROM payment_ranges p
JOIN charge_ranges ch
  ON ch.school_id=p.school_id AND ch.learner_id=p.learner_id
  AND p.range_start<ch.range_end AND ch.range_start<p.range_end
WHERE LEAST(p.range_end,ch.range_end)>GREATEST(p.range_start,ch.range_start)
ON CONFLICT(payment_id,charge_id) DO UPDATE
SET amount=school_fee_payment_allocations.amount+EXCLUDED.amount;

CREATE OR REPLACE FUNCTION prevent_school_fee_payment_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'School fee receipts are immutable; issue an audited credit note instead.'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS school_fee_payments_immutable ON school_fee_payments;
CREATE TRIGGER school_fee_payments_immutable
  BEFORE UPDATE ON school_fee_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_school_fee_payment_mutation();

COMMIT;
