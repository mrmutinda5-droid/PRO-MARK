# PRO-MARK 4.0.0 — Portal Structure Final Correction

Implemented in this package:

- Restored icon-based module navigation; numeric badges are no longer used as the primary module icons.
- Converted the 24-module hub into a direct workspace/dropdown model: clicking a module opens its connected workspace immediately below the menu.
- Added workspace 25: **Teacher Resource Library** for PDF, Scheme of Work, Revision Paper, Teacher Guide and Other resources.
- Added workspace 26: **Class Lists** with authorised class registers and Print/Save PDF controls.
- Added workspace 27: **Teacher Assignment, Accounts & Roles** for linking teacher logins, assigning subject/class combinations, and assigning Class Teacher roles.
- Class Teacher access now includes Assessment Management (read/access path), Mark Entry, Marks Management, Report Cards, Merit, Attendance, Documents/Resources and Class Lists.
- Loaded teacher assignments and class-teacher assignments into the portal state so role-filtered class lists and teacher mark-entry context can actually resolve the assigned classes.
- Class Teacher assignment explicitly keeps existing subject assignments and enables mark entry in the school role record.
- Report engine no longer lets an old academic-year identity snapshot overwrite the current registered school name in report cards. Current school identity/branding is read from the live school identity record.
- Master learner creation now persists parent phone when supplied.
- Teacher account/role workspace uses the existing teacher-account endpoint and displays actual linked account roles.

Validation:

`npm run check` → `PRO-MARK smoke check passed: 30 JavaScript files checked.`
