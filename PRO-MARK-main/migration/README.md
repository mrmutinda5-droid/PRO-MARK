# Kauti controlled migration

The Kauti workbook is a **reference/snapshot**, not the new PRO-MARK master database.

## Safety

- The original Kauti database is never modified by this importer.
- Default mode is **DRY RUN**.
- Use `--commit` only after reviewing the dry-run counts.
- Kauti passkeys/passwords from the workbook are deliberately ignored.
- Imported learner admission numbers are generated `LEGACY-XXXXXXXXXX` because the workbook does not provide a reliable admission-number column.
- The importer targets a normal `JUNIOR` PRO-MARK tenant; Kauti is not a hard-coded special tenant in the application.

## Commands

```bash
npm install
psql "$DATABASE_URL" -f database/schema.sql
psql "$DATABASE_URL" -f database/001_hardening.sql
npm run migrate:kauti
npm run migrate:kauti -- --commit
npm run validate
```

Optional environment values:

```text
KAUTI_WORKBOOK=legacy_reference/KAUTI_JUNIOR_SCHOOL/KAUTI SCHOOL 2026 TERM 3 MARKS (SANITIZED).xlsx
KAUTI_SCHOOL_CODE=KAUTI
KAUTI_SCHOOL_NAME=KAUTI JUNIOR SCHOOL
KAUTI_YEAR=2026
```

The embedded Kauti workbook is the supplied Term 3 2026 snapshot. The importer reads `TEACHERS` and `MARK ENTRY`, creates Kauti as a `JUNIOR` school, creates its classes/subjects/teachers, creates subject and class-teacher assignments where the workbook supports them, seeds the Junior CBC grading reference, and imports valid Term 3 MID TERM and END TERM marks. It does not pretend that every historical workbook sheet is a canonical database record.


### Kauti teacher filtering
The importer excludes generic/template rows such as `TEACHER` and `ADMIN`; only named staff records are imported as teacher/staff profiles. Passkeys are never imported.
\n\n### Corrected Kauti importer\nThis package contains the complete corrected `import_kauti_workbook.js`. Assessment IDs are explicitly extracted as UUID strings and validated before marks are inserted. The migration rolls back on failure.\n