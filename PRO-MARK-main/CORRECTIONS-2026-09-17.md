# PRO-MARK — Corrections from handwritten review — 17 Sep 2026

1. **Academic Performance** — retained and tightened the live analysis model: learner averages, class/stream comparison, subject performance, grade distribution, assessment summary and term-over-term progress remain data-driven rather than static UI.
2. **Marks Management / Term 3** — Term 3 is enforced as **OPENER + END TERM**. Imported Kauti workbook marks accidentally stored against END TERM are repaired to OPENER when the server initializes the schema compatibility layer. Duplicate imported END TERM rows are removed only when a matching OPENER row already exists.
3. **Report Card assessment columns** — report cards use the correct Term 3 columns and therefore show imported marks under **OPENER**, leaving **END TERM** available for later entry.
4. **Report Card layout/data** — subject comments are calculated from the subject average; subject teacher full name and initials are shown; annual/summary points were removed from the report-card layout; the A4 report uses a strong double black/primary frame to avoid visual overlap and keep the grade/teacher/comment areas distinct.
5. **Report Card speed/feedback** — class report generation now builds learner reports in bounded concurrent batches (4 at a time) instead of strictly one-by-one; the dashboard reports progress while a preview/class PDF is being prepared.

No local database is recreated by these changes. The online Render version continues to use Neon through `DATABASE_URL`.
