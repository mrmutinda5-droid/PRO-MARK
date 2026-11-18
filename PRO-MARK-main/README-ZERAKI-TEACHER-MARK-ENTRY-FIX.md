# PRO-MARK 3.9.7 — Zeraki-style Teacher Mark Entry

This build uses a simple database-driven teacher capture flow inspired by the requested Zeraki-style sequence.

## Teacher flow
1. **Academic Year** — choose the school year.
2. **Term** — terms are loaded dynamically for that year; missing Term 1–3 rows are created idempotently.
3. **Assessment** — assessments come from the database for the selected year/term and are de-duplicated for display.
4. **Class** — only the logged-in teacher's assigned classes are shown for the selected period.
5. **Subject** — only subjects that teacher teaches in the selected class are shown.
6. **Learners** — the learner roster loads automatically.
7. **Enter marks** — existing marks reload from the `marks` table.
8. **Auto-save + Save all marks** — both remain available.

## Important behavior fixes
- Year changes now reload Terms and Assessments.
- Term changes now reload Assessments.
- Assessment changes now reload the teacher's eligible Classes.
- Class changes now reload eligible Subjects.
- Subject changes now resolve the teacher assignment and load the roster.
- Teacher users open directly on Mark Entry.
- Navigation buttons for unauthorized administrator modules are hidden rather than appearing as inactive tabs.
- No teacher, learner, class, subject or mark values are hard-coded into the portal.

## Workbook reference
The supplied Kauti workbook was inspected using its `TEACHERS` and `MARK ENTRY` sheets. The migration script reads those sheets at runtime. Passwords/passkeys are not imported.

## Mark destination
Saved rows use:
`school_id, learner_id, subject_id, class_id, academic_year_id, term_id, assessment_id, mark, entered_by, remark`.

## Start
```powershell
npm.cmd start
```

Hard-refresh the browser after replacing the project files:
`Ctrl + F5`
