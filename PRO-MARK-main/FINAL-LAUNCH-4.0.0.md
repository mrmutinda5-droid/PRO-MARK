# PRO-MARK 4.0.0 — FINAL LAUNCH BUILD

This package is the finalization build prepared from the latest PRO-MARK 4.0.0 source.

## Important changes
- All 24 numbered workflow buttons now open their real existing operational workspace directly instead of requiring a second hidden-workspace click.
- Term 3 assessment logic is restricted to **OPENER + END TERM** during workbook import. Term 1/2 retain OPENER + MID TERM + END TERM.
- Added `database/018_term3_integrity_final.sql` for a safe, idempotent Neon repair of accidental Term 3 MID_TERM records. It preserves END TERM marks, moves accidental Term 3 MID_TERM marks to OPENER where possible, removes duplicate MID_TERM marks when an OPENER already exists, and removes empty Term 3 MID_TERM assessment definitions.
- Fixed the report-engine PostgreSQL `42P10` DISTINCT/ORDER BY failure by selecting the ordered columns.
- Existing working APIs for people, learners, academics, assessments, mark entry, marks management, analytics, reports, merit, attendance, discipline, communication/documents, billing, inventory, timetable, examination control, administration, platform control, import/export and audit remain in the package.

## Neon finalization
Run the contents of `database/018_term3_integrity_final.sql` in the Neon SQL Editor **once** against the same database used by Render.

Do not run destructive SQL manually before taking a Neon backup/branch if you want a rollback point.

## Render
- Keep `npm start` as the Start Command.
- Keep the existing Neon `DATABASE_URL` and `JWT_SECRET` environment variables in Render.
- Do not upload `.env` to GitHub.
- Deploy the repository root so `package.json` and `backend/server.js` are at the repository root.
