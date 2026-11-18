# PRO-MARK 4.0.1 — Resource Catalogue + Whole-Class Report PDF

## Resource Library
Resources are now catalogued independently by:
- Category: Scheme of Work, Notes, Revision Paper, Teacher Guide, Other
- Subject
- Class / Stream
- Academic year

The dashboard groups documents into separate catalogue sections and provides filters for each dimension. Existing resources remain available; older uploads without metadata appear under General / All.

## Report Cards
- Added a direct **Download whole class PDF** action.
- The class endpoint builds one PDF containing all learners enrolled in the selected class/year and selected term.
- Class PDF generation uses bounded concurrency (8 learners at a time) to reduce total wait time without overwhelming the database.
- Existing individual learner reports remain available.

## Report card frame
Removed the unnecessary accent/green line treatment. The report now uses a clean double black document frame.

## Validation
- Backend JavaScript syntax checks passed.
- Dashboard embedded JavaScript syntax check passed.
- PRO-MARK smoke check passed.
