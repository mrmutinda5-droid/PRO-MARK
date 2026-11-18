# ZELIMU CBC — initial source audit and safety change

Date: 2026-10-27
Source reviewed: uploaded `PRO-MARK-main.zip` (root directory `PRO-MARK-main/`).

## Completed in this working copy

- Reviewed the startup path in `backend/server.js` and database compatibility work in `backend/schema-compat.js`.
- Found a Term 3 repair written for a specific imported workbook that ran during normal server startup. Its SQL could update imported marks from `END_TERM` to `OPENER` and delete matching imported `END_TERM` mark rows.
- Changed the repair to run only when `ZELIMU_ENABLE_TERM3_IMPORT_REPAIR=true` is explicitly set for a deliberate maintenance run. Leave the variable unset during normal production operation.
- Added a smoke-check regression assertion so the repair cannot silently become automatic again.
- Ran `node --check backend/schema-compat.js` and `npm run check`; both passed. The smoke check syntax-checked 58 JavaScript files.

## Not yet verified

- No live database was contacted or modified.
- No end-to-end browser or role-permission tests have been run.
- This audit does not establish that every listed module is fully functional.
- Existing startup compatibility code still contains other automatic data changes (including duplicate-role cleanup and legacy admission-number normalization). Those require a careful follow-up review before changing them, because disabling them without a migration plan may prevent an older installation from starting.
- The project's database migrations have not been executed by this change.

## Next safe steps

1. Review every startup DDL/DML statement and classify additive schema changes versus data-destructive repairs.
2. Confirm the active project branch/commit and make a Git checkpoint before applying this working copy.
3. Verify tenant boundaries and role permissions for each backend route.
4. Build a feature matrix from the actual frontend controls, route handlers, and database tables.
5. Implement one module at a time, with regression tests and a backup before any production data migration.
