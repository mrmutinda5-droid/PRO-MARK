# ZELIMU CBC — Eight-Module Navigation and Build Plan

Date: 2026-10-27

## Scope of this step

This step reorganizes the School Operations Hub into the eight module families requested by the product owner. Existing workspace IDs and their current handlers are retained so navigation changes do not require a database migration. Platform Owner controls remain a separate group. School subscription billing is explicitly labelled as platform subscription billing, not school fee collection.

## Eight module families

1. **Administration** — school setup, staff and user enrollment, learner enrollment and promotion workflows, parents/guardians, attendance, discipline/welfare, class lists.
2. **Accounts & School Setup** — school identity/branding, school documents/resources, teacher assignments/accounts/roles, audit/security, controlled import/export. Personal-profile screens still require a dedicated review/build if not already provided elsewhere.
3. **Finance** — current platform subscription billing is retained but clearly separated. School fee structures, learner charges, receipts, partial payments, balances, payment reconciliation and payroll are not claimed as implemented by this navigation change.
4. **Academic** — academic years/terms/classes/subjects, assessments, mark entry, marks progress, performance analytics, report cards, merit and timetable/examination control.
5. **Communication** — existing parent/school SMS and communication workspace. Provider delivery, automated absence/fee alerts, per-term free-unit quota and direct messaging must be verified/configured before represented as fully live.
6. **Transport** — planned: routes, learner assignments, drivers/vehicles, transport fees and GPS/live tracking integration.
7. **Boarding** — planned: boarding registration, dormitories, room allocations, charges, supplies and welfare.
8. **HR & Staff Services** — existing staff directory/account tools are reused; recruitment, onboarding, leave/approval, appraisal, training and secure personnel files require implementation. Payroll belongs to Finance.

## Existing workspaces preserved

The existing `pm24_1` through `pm24_27` workspace identifiers and `openPM24` handler are retained. No existing backend routes, table names, report calculations, marks workflows, or login behaviour are changed in this step. The menu is a navigation reorganization only; it does not imply that the planned features are already functional.

## Safe implementation sequence

1. Protect existing academic and identity data; review startup compatibility SQL and keep risky data repairs opt-in.
2. Verify role-specific access and school isolation on each existing route.
3. Implement School Finance as its own domain, separate from platform subscription billing, with a reviewed SQL migration, payment ledger, receipts and audit trail.
4. Expand attendance/communication with delivery tracking and verified provider configuration.
5. Build library, stock movements, exam-paper generation and certificate generation.
6. Build HR, transport and boarding; integrate external hardware/providers only after compatibility and credentials are configured securely.
7. Add parent and learner portals with strict per-child and per-school access controls.

## Validation for this step

- JavaScript syntax checks pass for the existing 58 JavaScript files.
- Existing `npm run check` smoke test passes.
- The navigation uses the existing workspace IDs, avoiding a backend/schema change.
- No live database or deployment was modified.

## Deployment note

This ZIP is a development checkpoint. Test it in a separate branch/staging deployment before replacing the current production app. Do not run workbook-specific repair jobs on production data without a database backup and an explicit, reviewed target set.
