# PRO-MARK 3.9.7 — Unified Users, Mark Entry Activation & Role Control

## What changed

1. **All school platform roles can use Mark Entry**
   - SCHOOL_ADMIN
   - ADMIN
   - HEADTEACHER
   - DEPUTY_HEADTEACHER
   - SENIOR_TEACHER
   - CLASS_TEACHER
   - TEACHER

2. **Mark Entry activation is separate from account activation**
   - `users.is_active` controls whether the person can log in.
   - `user_school_roles.mark_entry_enabled` controls whether Mark Entry is active for that school role.
   - Existing role rows default to Mark Entry active so current teachers are not unexpectedly locked out.

3. **User & Role Control**
   - School administrators get a new **USER & ROLE CONTROL** area.
   - They can activate/deactivate a user's account.
   - They can activate/deactivate Mark Entry.
   - They can change a user's school role.
   - They can remove a school role without deleting the teacher, marks, learners, assignments or history.

4. **One role per person per school**
   - Legacy duplicate role rows are reduced to one role per person.
   - Priority is: SCHOOL_ADMIN → ADMIN → HEADTEACHER → DEPUTY_HEADTEACHER → SENIOR_TEACHER → CLASS_TEACHER → TEACHER.
   - Only one person can hold each of the leadership/admin roles in a school.
   - TEACHER and CLASS_TEACHER remain multi-person roles.
   - A role change does not delete the teacher profile or academic assignments.

5. **Mark Entry security**
   - Mark-save endpoints accept the full school role set, but the account must have Mark Entry activated.
   - The existing assignment check still ensures a linked teacher can save only the subject/class assignment belonging to that teacher.
   - A person who has no linked teacher profile is shown a clear message and must first be linked to a teacher profile.

## Database migration

Run this once against the existing PRO-MARK database:

`database/013_unified_user_mark_entry_and_role_control.sql`

Do not rerun the base schema on a production database.

## UI locations

### School administrator
Dashboard → Administrator Control Centre → **USER & ROLE CONTROL**

### Platform owner
Platform Owner → **Platform User & Mark Entry Control**

After a role change, the affected user should sign out and sign in again because the login token contains the current role.

## Important operating order

1. Create the teacher/person.
2. Create or link the person's login.
3. Assign the person's school role.
4. Assign their class/subject work.
5. Activate **Account**.
6. Activate **Mark Entry**.
7. The teacher signs out/in again if their role was changed.
8. The person enters marks through the existing five-step Mark Entry workflow.
