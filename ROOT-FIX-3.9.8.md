# PRO-MARK 3.9.8 — Root/Systematic Fix

This build addresses the Platform Owner reliability problems as one system rather than by isolated patches.

## Fixed

- Fast XLSX/XLSM detection: reads only workbook XML, shared strings, TEACHERS and MARK ENTRY sheets; avoids a full ExcelJS workbook parse during preview.
- Correct assessment-column detection from workbook headers instead of hard-coded column positions.
- Term 3 imports use END TERM when present; if END TERM is completely empty and an AVERAGE column contains numeric values, the importer explicitly falls back to the average values as End Term so an otherwise populated workbook is not silently imported as zero marks.
- School import is now an asynchronous job with progress polling, preventing long database work from being tied to the browser HTTP request timeout.
- Import database writes remain transactional and are batched/chunked.
- Import errors are stored in the job status and returned to the Platform Owner UI.
- API error middleware always returns JSON for `/api/*`, eliminating HTML/empty-response parsing surprises.
- Database pool has bounded connection and statement timeouts.
- Billing schema compatibility is checked during startup; if the billing foundation is missing, the existing idempotent migration 005 is applied automatically.
- Platform school status controls provide busy-state feedback and prevent duplicate clicks.
- Permanent school deletion is transactional and skips tables that are not present in an older database instead of failing on a missing optional table.
- Platform user role changes no longer delete/recreate role rows unnecessarily and correctly respect the unique leadership-role constraint.
- Platform Owner UI loads schools, users and billing independently so one failed panel does not disable the others.
- Dashboard already exposes `General / Identity`; no separate hidden General page is required.

## Deployment

Deploy this build as a single GitHub commit to the Render service. Do not recreate the Neon database.

After deployment, test workbook detection once, then import once. The import screen should show a progress bar and a clear success/failure result.
