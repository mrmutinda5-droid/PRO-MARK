-- PRO-MARK 4.0.7
-- Preserve the role written in imported Excel teacher rows even before a login account exists.
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS imported_role text;
UPDATE teachers SET imported_role='TEACHER' WHERE imported_role IS NULL OR btrim(imported_role)='';
