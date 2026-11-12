# PRO-MARK 4.0.9 — Corrections 2026-09-26

This build is based on the uploaded `PRO-MARK--main (4).zip` source. No `.env` or Git metadata is included.

## Corrections applied

- Teacher Mark Entry: assignment selection is now resolved by year/term/class/subject before assessment validation. Legacy/global Opener, Mid Term and End Term assessment IDs are resolved to the exact class + subject roster when available, preventing the selected assessment from disappearing and preventing cross-subject assessment errors on existing schools.
- Existing-school compatibility: the assessment resolver works at request time against existing database records; it does not require schools to be recreated.
- Learner editing: the learner profile now has one complete edit form for stored learner details, including class, admission number, assessment number, names, gender, date of birth and parent/guardian phone.
- Learner passport: the edit profile includes a working upload/replace passport-photo control. Duplicate photo forms were removed.
- Learner Excel workflow: the existing paste-from-Excel bulk import and class CSV export paths are retained.
- Merit subject marks: individual subject percentages expose a rounded whole-number display value while the underlying subject average and overall average retain their decimals.
- Merit PDF: subject performance marks use the rounded display value; totals and averages remain based on the unrounded values.
- Report-card remarks: recorded teacher remarks are respected; when none exists, subject-specific performance comments are generated so identical grades across different subjects do not force one identical generic remark.
- School identity/report card: the existing school contact phone is retained directly below the motto; logo and active school stamp assets remain connected to report-card generation.
- Report-card total marks/average fields remain calculated from the subject performance data and are not rounded into the overall average.

The build contains the source tree only; the nested duplicate `promark-fix` tree and nested ZIP from the uploaded archive were excluded to avoid deploying duplicate copies of the application.
