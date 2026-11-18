# ZELIMU CBC — Eight-module implementation register

This is a requirements register, **not a claim of completed functionality**.

| Module | Required capabilities | Current status / next work |
|---|---|---|
| Administration | Admission, learners and guardians, daily student/staff attendance, biometrics, staff register, promotion | Existing learner/guardian/staff and attendance areas; staff attendance and biometric integration need verification and implementation. |
| Accounts & Setup | Reports, system configuration, branding, user profiles | Existing identity, official assets, reports and access controls; user self-service profiles and consolidated reporting need dedicated review. |
| Finance | Fees, receipts, M-Pesa/bank, class/stream structures, reminders, sibling billing, reports | Existing school finance workspace; payment-provider callbacks, reconciliations, reminder automation and sibling billing not verified. |
| Academic | Marks, grading, report cards, exams, trends, timetables, SMS/email results | Existing assessment/mark/report/merit/timetable workspaces; automatic scheduling and results delivery need validation. |
| Communication | Bulk SMS, 2,500 free term units, fee/absence alerts, direct parent messages | Existing communication workspace. Free-unit allowance is a commercial requirement, NOT a funded or active service; delivery and automation need provider setup. |
| Transport | Routes, students, drivers, vehicles, fees, GPS | Not implemented; design and create tenant-scoped tables, APIs, role permissions, audit trail and optional GPS provider integration. |
| Boarding | Dorms, rooms, residents, fees, supplies, welfare | Not implemented; design and create tenant-scoped tables, APIs and restricted welfare permissions. |
| HR | Recruitment, onboarding, leave, appraisals, training, documents, discipline | Staff and roles exist; full HR workflows need new tenant-scoped data models and APIs. |

## Mandatory engineering gates
1. Backup PostgreSQL and preserve the current ZIP.
2. Verify all routes and permissions by role and school.
3. Use additive migrations, never destructive table resets.
4. Never simulate payment, biometric, GPS or SMS integration as live.
5. Validate report cards, merit, marks, admissions and password reset against a staging database.
6. Obtain explicit approval before enabling SMS charges, payment collection or third-party sharing.
