# PRO-MARK — Class Teacher / Teacher Workflow Corrections

This release implements the handwritten corrections supplied on 17 September 2026.

## Teacher management
- Selecting a teacher profile now prepares the assignment, class-teacher and account controls for that teacher.
- Subject-teacher assignment now has a working backend endpoint and reactivates an existing matching assignment instead of creating duplicates.
- Teacher assignment results now retain the real academic term instead of returning a blank term.
- Class-teacher assignment now has a working backend endpoint.
- A class has one Class Teacher per academic year; reassigning replaces the previous Class Teacher.
- Assigning a Class Teacher requires an active linked PRO-MARK login and synchronises the single school role to CLASS_TEACHER while preserving subject assignments.
- Class-teacher lists are now rendered in the administration workspace.

## Class Teacher workspace
- Assigned classes are shown with direct controls for:
  - Class List
  - Mark Entry Monitoring
  - Merit / Past View
  - Report Cards / Print
  - Attendance Register
- Class Teachers are restricted server-side to their assigned class when monitoring marks, attendance, merit and report cards.
- Historical terms within an assigned academic year remain accessible for class oversight.

## Mark entry
- Teacher mark setup reuses already-loaded assignments instead of making a duplicate assignment request, reducing initial loading time.
- Mark monitoring shows the subject teacher, assessment, entered/expected/missing marks and progress.
- Term 3 Opener/End Term selection remains tied to the actual assessment ID so existing Opener marks appear in the Opener sheet.
- Teacher mark-sheet PDF now includes the actual school logo visibly as well as the watermark.

## Security / password
- Existing self-service password-change confirmation remains active and validates the current password before replacing the stored hash.

## Validation
- All JavaScript files pass `node --check`.
- Dashboard inline JavaScript passes `node --check`.
