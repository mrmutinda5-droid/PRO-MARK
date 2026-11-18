# PRO-MARK 4.0.7 — Excel Teacher Role Fix

The Excel import previously read the TEACHERS role column but did not persist that role anywhere except indirectly for CLASS_TEACHER subject assignments.

This release:
- stores the imported role on `teachers.imported_role`;
- shows that role in the Teachers list when no login role exists;
- uses the imported role as the default when a teacher login is created later;
- applies a role to an already-linked login when the workbook staff number is an email matching an existing user;
- creates CLASS_TEACHER assignments for Terms 1, 2 and 3;
- keeps subject/class assignments available in all three terms;
- lets report-card head-teacher resolution use an imported HEADTEACHER role as a fallback.

Existing marks are not deleted or rewritten.
