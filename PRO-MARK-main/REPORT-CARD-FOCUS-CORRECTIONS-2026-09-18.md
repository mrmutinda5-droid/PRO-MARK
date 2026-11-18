# PRO-MARK — Report Card Focus Corrections — 2026-09-18

## Implemented

- Term 3 report cards use only OPENER and END TERM columns.
- When Term 3 has only OPENER marks, the subject average is the OPENER percentage rather than blank.
- Report-card columns were rebalanced so AVERAGE, GRADE, RANK, TEACHER, INITIALS and COMMENT have separate physical cells.
- Every report-card column boundary is explicitly drawn to prevent overlap.
- Teacher name and teacher initials have dedicated space; COMMENT is widened for subject-teacher feedback.
- Added an explicit **TEACHERS & ASSIGNED CLASSES / SUBJECTS** manager under Teacher Assignments.
- Added direct controls to assign a selected teacher to a class + subject and to make the teacher the Class Teacher for a selected class.
- Added a **CLASS LISTS** button to the People/Learner area so class registers are directly reachable from the school tabs.
- Class-list PDF generation now disables PDFKit's automatic first page and explicitly creates exactly the first page, preventing an unintended blank page before the register.

## Validation

- Dashboard inline JavaScript: `node --check` passed.
- Report engine: `node --check` passed.
- Report PDF service: `node --check` passed.
- Class-list route: `node --check` passed.
- Server: `node --check` passed.

No database schema change is required for these UI/PDF/report calculation corrections.
