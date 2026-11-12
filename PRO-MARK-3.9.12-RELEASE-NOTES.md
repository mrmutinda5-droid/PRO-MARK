# PRO-MARK 3.9.12 — Controlled Final Candidate

## Purpose
This release is a controlled application-code revision based on the working 3.9.11 source. It does **not** require a Neon schema migration.

## Root fixes
- Merit generation no longer requires a teacher-assignment row to exist before marks can be calculated. Recorded marks remain visible; teacher attribution is resolved separately.
- Merit subject teacher labels use the actual assigned teacher name and suppress placeholder values such as `TEACHER`/`ADMIN`.
- Merit PDF uses A4 landscape for normal subject counts and A4 landscape for more than 10 subjects so wide school subject sets do not overflow the page.
- Merit PDF retains exactly one intentional cover page, then the register; page creation is content-driven.
- Class List screen and PDF use deterministic A–Z ordering by the learner's displayed full name.
- Class List PDF uses page-scaled column widths and renders fully before the HTTP response is sent.
- Report-card subject rows expand when a learner has only a few subjects, preventing data from being squeezed into a small strip while leaving large unused space.
- Legacy default document colours are upgraded in rendering to a stronger blue/green professional palette while preserving each school's saved custom colours.
- Analytics subject breakdown now shows the teacher assigned to each subject; combined level/class filters use the correct parameter.
- Dashboard navigation icons are clean inline SVG icons rather than emoji.
- Dashboard GET requests retry transient network failures and use no-store for fresh data.
- School logos remain stored as database data URLs and are not dependent on Render's ephemeral filesystem.

## Admission numbers
The Excel importer continues to leave admission numbers blank when the workbook does not provide official admission numbers. It does not manufacture `IMPORT-*` or `LEGACY-*` identifiers.

## Database
No new SQL is required for these fixes. Keep the working Neon database unchanged.

## Validation
- All backend JavaScript syntax checks passed.
- Dashboard inline JavaScript syntax check passed.
- PRO-MARK smoke check passed: 28 JavaScript files checked.

## Deployment discipline
This ZIP is the complete application source. Do not upload selected files from it into an older repository. Replace/synchronize the entire GitHub application tree from this one release so GitHub and Render cannot contain mixed PRO-MARK versions.

## Candidate status
Do not deploy until the repository has been backed up and the complete source tree has been synchronized as one release.
