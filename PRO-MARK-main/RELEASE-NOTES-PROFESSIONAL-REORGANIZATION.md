# ZELIMU CBC — Professional navigation release

Baseline: uploaded ZELIMU-CBC-PHASE1-MODULE-REORGANIZATION.zip. The baseline is preserved separately.

## Implemented
- Added an accessible, responsive module finder with live search, clear control, and matching-module count.
- Removed the duplicate Staff/Access Roles shortcut from School Setup; role and teacher-assignment control remains under HR & Staff Services.
- Replaced the school-dashboard owner duplicate entries with a direct link to the separate owner portal.
- Kept guardian registration, school stamps/signatures, and school announcements in separate workspaces.
- Clearly marked transport, boarding and HR extensions as planned rather than operational.
- Added navigation integrity checks to the existing smoke check.
- Retained the existing academic, financial, school operations, report and merit implementations.

## Validation performed
- `npm run check` passes (30 JavaScript syntax checks and 27 menu target checks).
- No schema changes, destructive migration, data reset, or dependency changes were made.

## Before production deployment
1. Create a new private GitHub repository, upload this source, and configure Render's root, build and start commands.
2. Configure production environment variables in Render, not in Git. Do not commit real secrets.
3. Back up the production PostgreSQL database before running any migrations.
4. Test school admin, teacher, headteacher and owner logins in a staging deployment; verify role visibility and authorization.
5. Exercise guardian linking, official stamp upload, announcements, mark saving, report cards, merit PDF, and fee receipts against a staging database.
6. Check that external email, SMS, file persistence and billing settings are correctly configured.

This package has passed static checks but has NOT been end-to-end tested against Render or a live database. Planned features are not represented as completed implementations.
