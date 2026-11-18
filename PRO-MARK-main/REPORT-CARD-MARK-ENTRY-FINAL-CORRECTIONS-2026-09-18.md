# PRO-MARK 4.0.0 — Report Card + Mark Entry + Teacher Class Lists Corrections

Implemented in this build:

- Report-card Term 3 uses OPENER + END TERM only; OPENER-only marks calculate the subject average.
- Report-card table order is SUBJECT → OPENER → END TERM → AVERAGE → GRADE → TEACHER → COMMENT.
- GRADE, TEACHER and COMMENT have separate physical cells and wider A4-safe spacing.
- Teacher name is resolved from the active teacher assigned to the class/subject for the academic year/term; placeholder teacher records are ignored.
- Merit subject teacher lookup uses the same active assignment rule and Term 3 excludes MID_TERM.
- Teacher portal now visibly shows MY ASSIGNED CLASSES & SUBJECTS.
- Teacher portal now visibly shows MY CLASS LISTS for classes in which the teacher has subject assignments, with view and PDF actions.
- Assessment selection is preserved while choosing class and subject.
- Changing assessment reloads the selected assignment roster so previously saved marks for that assessment appear immediately.
- Teacher mark-sheet PDF includes the full class roster and the saved mark column, including blank learners awaiting entry.
- Report-engine assignment and grading configuration queries use short-lived caches to speed up class report generation without requiring a restart after changes.
- Class report generation is bounded at six concurrent learner reports.
- Class-list PDF uses PDFKit with autoFirstPage:false and an explicit first page, preventing an unwanted empty first page.
