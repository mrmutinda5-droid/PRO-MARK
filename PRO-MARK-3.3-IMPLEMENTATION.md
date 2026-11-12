# PRO-MARK 3.3 implementation pack

This pack continues the existing PRO-MARK architecture. It does not recreate the database or replace the existing academic/learner/report/billing model.

## Included

- `dashboard.html` — updated school portal Teacher Mark Entry UI.
- `006_mark_entry_control_and_announcements.sql` — additive database migration for administrator-controlled mark-entry deadlines and portal announcements/voice-message references.

## Teacher Mark Entry changes

- Removed the per-learner Remark field from the mark-entry sheet.
- Teacher enters only the mark.
- Enter saves the current learner and moves to the next learner.
- Existing assigned subject/class/assessment workflow is preserved.
- Existing bulk-save API is preserved; the request now sends learner + mark only.
- Added visible completion progress.
- Added stronger mark-input focus/keyboard behavior.
- Teacher initials/comments remain part of reporting rather than the fast mark-entry step.

## Deadline policy

The new migration creates `mark_entry_policies` so the deadline is data-driven rather than hard-coded.

Intended lifecycle:

1. Admin sets opening date/time and deadline.
2. Before deadline, teacher can enter and correct marks according to school policy.
3. Submission does not itself permanently lock the marks.
4. After the configured deadline, editing becomes locked when `lock_after_deadline` is enabled.
5. School Admin can reopen when `admin_override_allowed` is enabled.
6. Platform Owner can override/reopen when `owner_override_allowed` is enabled.

The backend must enforce this policy at the mark-write endpoint. The existing backend source (`backend/server.js`) was not available in the Library snapshot, so this pack intentionally does **not** replace it with a guessed backend implementation.

## Announcements / teacher welcome voice

`portal_announcements` supports:

- teacher audience
- title/message
- optional voice URL
- first-login display
- acknowledgement requirement
- active period

The existing school announcement/document mechanisms should remain intact. The new table provides a clean place for the enhanced teacher welcome/awareness message.

## Existing database safety

Use the existing `pro_mark` database. Do not run `schema.sql` again. Do not touch the separate legacy `pro_mark_entry` database.

## Verification

The updated dashboard JavaScript passes `node --check`.

The SQL is additive and uses `IF NOT EXISTS`; review it against the live database before applying it.
