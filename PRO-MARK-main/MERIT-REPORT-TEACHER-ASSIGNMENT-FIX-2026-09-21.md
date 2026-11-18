# PRO-MARK 4.0.6 Merit / Report / Teacher Assignment Fix

- Merit class filtering now respects academic-year learner enrollment and existing mark records instead of requiring `marks.class_id` alone.
- Merit no longer requires `learners.is_active=true` when an academic-year enrollment or matching mark establishes the selected class context.
- Merit subject-teacher lookup now falls back to another assignment in the same academic year when the selected term has no assignment row.
- Report-card subject teacher lookup can use an active same-year assignment even when the assignment was recorded for another term.
- Whole-class report selection can include learners represented by the selected year's enrollment or matching marks, avoiding false `No learners found` messages.
- Imported teacher-subject assignments are created for Terms 1, 2 and 3 so imported teacher names remain available to Merit and Report Cards.

No learner marks are deleted or rewritten by these code changes.
