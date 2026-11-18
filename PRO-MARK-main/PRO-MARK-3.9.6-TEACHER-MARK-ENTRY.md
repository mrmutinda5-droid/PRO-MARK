# PRO-MARK 3.9.6 — Simple Teacher Mark Entry

This release rebuilds the teacher mark-entry experience around the actual workflow:

1. Choose Assessment
2. Choose Class (only classes assigned to the teacher and compatible with the assessment)
3. Choose Subject (only subjects the teacher teaches in that class)
4. Learners load automatically
5. Marks auto-save as entered, with Enter/keyboard navigation and progress
6. Administrator-controlled assessment deadlines remain the only teacher-entry lock
7. Teacher submission is removed from the workflow; there is no lock caused by pressing Submit
8. `SAVE MARK SHEET PDF` produces a teacher mark-entry sheet with PRO-MARK, school, term, class, subject, teacher and learner marks

The underlying data path remains:
Teacher → Academic Year → Term → Assessment → Teacher Class/Subject Assignment → Learners → Marks → Results/Grading → Merit.

The existing administrator assessment/deadline controls and merit pipeline remain separate from teacher mark entry.
