-- PRO-MARK 3.9.7 — Unified platform-user Mark Entry and role control
-- Safe/idempotent migration. Run after 3.9.6. Preserves academic data.
BEGIN;

ALTER TABLE user_school_roles
  ADD COLUMN IF NOT EXISTS mark_entry_enabled boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_user_school_roles_mark_entry
  ON user_school_roles(school_id, mark_entry_enabled);

-- The school model now uses exactly one role per person per school.
-- If legacy data has multiple roles for one person, keep the highest
-- administrative role and remove only the duplicate role rows.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id,school_id
           ORDER BY CASE role
             WHEN 'SCHOOL_ADMIN' THEN 1
             WHEN 'ADMIN' THEN 2
             WHEN 'HEADTEACHER' THEN 3
             WHEN 'DEPUTY_HEADTEACHER' THEN 4
             WHEN 'SENIOR_TEACHER' THEN 5
             WHEN 'CLASS_TEACHER' THEN 6
             WHEN 'TEACHER' THEN 7
             ELSE 99 END,
             created_at,id
         ) rn
  FROM user_school_roles
  WHERE school_id IS NOT NULL
)
DELETE FROM user_school_roles r
USING ranked x
WHERE r.id=x.id AND x.rn>1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_school_role_per_user
  ON user_school_roles(user_id,school_id);

-- If duplicate holders of a leadership role exist in old data, keep the
-- oldest active holder. The API blocks any new duplicate assignment.
WITH ranked AS (
  SELECT r.id,
         ROW_NUMBER() OVER (
           PARTITION BY r.school_id,r.role
           ORDER BY u.is_active DESC,r.created_at,r.id
         ) rn
  FROM user_school_roles r
  JOIN users u ON u.id=r.user_id
  WHERE r.role IN ('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER')
)
DELETE FROM user_school_roles r
USING ranked x
WHERE r.id=x.id AND x.rn>1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_leadership_role_per_school
  ON user_school_roles(school_id,role)
  WHERE role IN ('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER');

COMMIT;
