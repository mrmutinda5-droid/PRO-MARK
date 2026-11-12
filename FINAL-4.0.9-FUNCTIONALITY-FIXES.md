# PRO-MARK 4.0.9 — Final functional fixes

## Learner identity/import foundation
- Workbook import prioritizes Admission No. and also reads Assessment No., learner name, class and stream.
- Existing learners are matched and updated rather than duplicated when a stable admission number or class/name identity is available.
- First/middle/last names are preserved during import.
- Grade/class stream detection is improved for values such as Grade 4 A.

## Assessments
- Term 3 supports the administrator-selected 2-exam or 3-exam main-assessment structure.
- When Term 3 is changed to 2 exams, a previously existing Mid Term is excluded from mark entry, reports and Merit without deleting historical marks.
- Standard assessments are de-duplicated in the API and canonicalized as Opener, Mid Term and End Term.
- When duplicate standard assessment records exist, the record containing saved marks is preferred.
- Teacher Mark Entry keeps the selected Mid Term/other assessment visible and uses one canonical assessment per standard type.
- Merit assessment selector shows one canonical entry per configured main assessment.

## Class lists and learner movement
- Class-list PDF includes school logo and a subtle watermark when enabled.
- Class-list PDF reads current class enrolments as well as the learner's class field.
- Class Teachers can add/remove learners within their assigned class.
- Promotion prevents repeat promotion from an already completed source enrolment and preserves historical enrolments/marks.
- Class Teachers can initiate promotion for their assigned class.

## Grading
- Grading bands are used directly from administrator configuration rather than a hidden hard-coded score scale.
- Administrators can edit an existing grading system, its bands, and target levels.
- Merit, report cards and analytics use configured grading ranges where configured.

## Validation
- All backend JavaScript files pass `node --check`.
- Dashboard JavaScript passes `node --check` after extraction from the HTML file.
- Workbook parser was tested with an XLSX containing learner name, admission number, assessment number, class, stream and three main assessments.
