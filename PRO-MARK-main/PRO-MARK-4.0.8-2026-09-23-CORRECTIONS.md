# PRO-MARK 4.0.8 — 23 September 2026 correction set

This release preserves the existing database/schema and corrects the following production issues without resetting school data, marks, learners, assignments, or successful mark-entry behavior.

## Report cards
- Main assessment columns are driven by the administrator's configured Term/class assessments.
- Term 3 is not hard-coded to two exams. If Opener + Mid Term + End Term are configured, all three are rendered and averaged when included.
- Assessment IDs/names are retained separately so one assessment cannot overwrite another merely because they share a type.
- Current `school_identity` branding is authoritative; historical identity snapshots are fallback only.
- School logo, school name, motto and school-specific watermark are rendered when available.
- If no main assessment is configured, the report does not invent an Opener/End Term pair.

## Merit
- Merit averages the actual main assessment records used for the selected class/term.
- Assessment names are loaded from the actual assessment records and shown in the merit workspace/status and official Merit PDF.
- Teacher names are resolved from current subject/class assignments and imported teacher assignments.
- Empty merit output now produces a diagnostic message in the official PDF instead of an apparently blank page.

## Teacher Mark Entry
- Mark Entry is now a focused workflow: Academic Year -> Term -> Assessment -> Class -> Subject -> Learners.
- Teacher assignment cards and class-register panels are not rendered inside the Mark Entry workspace. Dedicated Assignments/Class Lists modules remain available separately.

## Excel import
- Workbook sheet names and key column headers are detected flexibly instead of relying only on fixed positions.
- Teacher names printed on MARK ENTRY are matched to TEACHERS-sheet staff numbers/full names and create subject assignments for the imported class/term.
- Generic Exam 1/2/3-style headers can be mapped to the three main assessment slots while retaining their original names.
- Imported Term 3 workbooks can carry Opener + Mid Term + End Term; all detected main assessments are created/imported.
- Legacy Kauti migration now imports a Term 3 Mid Term when actual Mid Term marks are present instead of always creating only two assessments.

## Safety
- No SQL migration is required for this correction set.
- No school/learner/mark records are deleted or reset by the code changes.
- Existing manual save/autosave mark-entry logic is retained.
