# PRO-MARK 4.0.0 — Portal Flow & Reliability Fix

## Implemented

1. **Teacher Resource Library is now wired into the actual portal**
   - PDF
   - Scheme of Work
   - Revision Paper
   - Teacher Guide
   - Other
   - Admin/owner upload; teachers and authorised staff open resources.
   - Resource files are stored in the school resource table as PDF bytes so the library does not depend on Render's ephemeral upload filesystem.

2. **Class Teacher remains a teacher with one login**
   - Class Teacher role remains eligible for mark entry.
   - Existing teacher subject/class assignments are preserved when a Class Teacher is assigned.
   - Class Teacher can access mark entry, saved marks, reports, merit, attendance and class resources subject to the existing role controls.

3. **Class Teacher class access repaired**
   - Class-teacher assignments are loaded before class-register filtering.
   - Assigned class lists become visible to the Class Teacher.
   - Class Teacher class-register PDF is available only for assigned classes.

4. **Teacher account visibility improved**
   - Teacher directory now shows linked account role(s) and Mark Entry ON/OFF status.
   - People area has direct buttons for **CLASS LISTS** and **TEACHER SUBJECTS & ASSIGNMENTS**.
   - Module 3 and Module 4 dropdowns also expose direct links to these workspaces.

5. **Portal landing screen cleaned up**
   - The large MARK ENTRY workspace is no longer forced onto the front of the portal.
   - Teachers enter the Mark Entry workspace through module 08.
   - Administrators land on the organised module control centre.

6. **24-module navigation changed to dropdown-style workspace**
   - Clicking a module opens its live module panel directly beneath the module menu.
   - It does not automatically jump the page down to a distant section.
   - Existing detailed workspaces remain available through explicit workspace buttons.

7. **Class-list PDF route rebuilt**
   - A4 landscape PDF generation uses a direct, controlled pagination flow.
   - Content-length is set and empty-PDF responses are rejected.
   - Class register columns are kept fixed and readable.

8. **Dashboard request responsiveness improved**
   - GET retry delay reduced.
   - Short private browser caching is enabled for GET API responses.
   - Mutating requests remain no-store.
   - Existing parallel dashboard loading is preserved.

## Validation

`npm run check` passed:

`PRO-MARK smoke check passed: 31 JavaScript files checked.`

The live Render deployment has not been claimed as tested by this package build; deploy this package to the GitHub/Render project before live verification.
