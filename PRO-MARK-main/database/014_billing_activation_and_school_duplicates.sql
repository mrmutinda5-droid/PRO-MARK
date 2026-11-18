-- PRO-MARK 3.9.7: billing activation + duplicate school-name support
-- Safe/idempotent. School names are intentionally NOT unique; school codes remain unique identifiers.

UPDATE billing_plans SET is_active=true, updated_at=now() WHERE code='ANNUAL_STANDARD';
UPDATE platform_payment_methods SET is_active=true, updated_at=now();

INSERT INTO billing_plans(code,name,description,amount,currency,billing_cycle,grace_days,is_active)
VALUES ('ANNUAL_STANDARD','Annual Standard','PRO-MARK annual school subscription — configurable by Platform Owner',0,'KES','ANNUAL',7,true)
ON CONFLICT(code) DO UPDATE SET is_active=true;

INSERT INTO school_subscriptions(school_id,plan_id,plan_name_snapshot,amount,currency,billing_cycle,starts_on,next_due_on,grace_days,status,notes)
SELECT s.id,p.id,p.name,p.amount,p.currency,p.billing_cycle,CURRENT_DATE,
       CASE p.billing_cycle WHEN 'MONTHLY' THEN CURRENT_DATE + INTERVAL '1 month'
         WHEN 'TERMLY' THEN CURRENT_DATE + INTERVAL '4 months'
         WHEN 'QUARTERLY' THEN CURRENT_DATE + INTERVAL '3 months'
         WHEN 'HALF_YEARLY' THEN CURRENT_DATE + INTERVAL '6 months'
         WHEN 'ANNUAL' THEN CURRENT_DATE + INTERVAL '1 year'
         ELSE CURRENT_DATE + INTERVAL '30 days' END,
       p.grace_days,'ACTIVE','Auto-activated by PRO-MARK 3.9.7 billing migration'
FROM schools s CROSS JOIN billing_plans p
WHERE p.code='ANNUAL_STANDARD' AND p.is_active=true
  AND NOT EXISTS (SELECT 1 FROM school_subscriptions ss WHERE ss.school_id=s.id AND ss.status IN ('ACTIVE','TRIAL','PAUSED'));

-- School names may repeat. The existing schema's school code remains the unique key.
