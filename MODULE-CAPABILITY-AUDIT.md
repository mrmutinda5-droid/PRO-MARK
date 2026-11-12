# ZELIMU CBC — Module and Safety Audit

**Audit date:** 2026-10-27  
**Source:** `PRO-MARK-main.zip` uploaded by the user, plus the safety changes in this working copy.  
**Scope:** Static source inspection only. No live database or deployed website was accessed or changed.

## 1. What is already present in the codebase

The project is not a blank application. It contains route modules and/or persistence structures for:

- Authentication, platform owner functions, school setup, school identity/branding, users and school roles.
- Learners, teachers, classes, subjects, academic years, terms, assessment setup, mark entry, grading, merit and report generation/PDFs.
- School announcements and communication message records.
- Subscription billing for the ZELIMU platform (this is not the same as a school's learner-fee ledger).
- Learner attendance, discipline cases, inventory items, timetable entries and school resource documents.
- Parent/guardian and learner-to-guardian relationships.

Presence of a route, table or dashboard control does not prove that a feature works end-to-end. Browser testing and role-by-role tests remain necessary.

## 2. First-pass feature coverage

| Requested capability | Source evidence / assessment | Next verification or implementation |
|---|---|---|
| Administration and learner registration | People routes, learner/class records, promotion/enrollment code | Verify add/edit/archive/transfer/promotion flows and tenant checks |
| Staff and teacher records | People/platform routes, teachers table | Verify full staff lifecycle, staff attendance and document handling |
| Academic marks, grading, reports and merit | Assessment, grading, merit and report routes/services | Run regression tests for mark save, term reports, ranking and PDF export |
| Results analytics and exam comparison | Analytics/merit/report structures exist; full user-facing coverage not proven | Trace dashboard controls to endpoints and test comparisons over time |
| School fee management | Platform subscription billing exists; not evidence of a school fee ledger | Implement learner accounts, invoices, receipts, allocations, balances, reversals and reconciliation |
| Payroll | No dedicated payroll route/table established in this audit | Design payroll periods, salary components, deductions, approvals and payslips |
| Library | No dedicated circulation module established in this audit | Build catalogue, copies, issue/return, overdue and stock audit workflows |
| Inventory | `inventory_items` structure and operations route exist | Add movement ledger, requisitions, purchase/receipt, issue/return and stock reconciliation |
| Exam question generator | Not established as an end-to-end module | Build question bank, curriculum tags, paper blueprint, marks validation and printable output |
| Leaving certificates | Document generation exists generally; dedicated certificate workflow not established | Add template, sequential issue number, approval, print/export and revocation audit |
| Timetable | `timetable_entries` structure exists | Add clash detection for class/teacher/room, generation rules and publish workflow |
| Parent communications/SMS | Communication routes/table exist | Verify actual provider integration, consent, delivery status, costs and term quota enforcement |
| Parent and learner portals | Dashboard and role-aware code exist; exact permissions require tests | Test cross-school isolation and parent access to only linked children |
| Transport/live tracking | Dedicated end-to-end implementation not established | Build routes/vehicles/assignments first; live tracking requires a compatible provider/device |
| Boarding/dormitories | Dedicated end-to-end implementation not established | Build boarding registration, dorm/bed allocation, charges and welfare records |
| HR | No full HR workflow established | Build recruitment, leave approvals, appraisals, training and confidential staff documents |
| Biometric attendance | Not established | Define compatible hardware/protocol and consent, fallback and audit requirements |
| M-Pesa/bank integration | Not proven by the platform's manual subscription-payment flow | Integrate supported payment APIs/webhooks with idempotent reconciliation and audit logs |

## 3. Startup database safety changes in this working copy

The original `backend/schema-compat.js` ran several data changes during normal server startup. These are now guarded or made conditional:

1. **Term 3 imported-mark repair** — the UPDATE and DELETE are opt-in only via `ZELIMU_ENABLE_TERM3_IMPORT_REPAIR=true`.
2. **Duplicate school-role cleanup** — DELETE statements are opt-in only via `ZELIMU_ENABLE_ROLE_DEDUP_REPAIR=true`. If duplicates remain, the unique indexes are skipped and a warning is logged instead of deleting role rows automatically.
3. **Legacy learner identifier cleanup** — converting `IMPORT-*`/`LEGACY-*` admission numbers to NULL is opt-in only via `ZELIMU_ENABLE_LEGACY_ADMISSION_CLEANUP=true`.
4. **Admission-number unique index** — creation is skipped with a warning if duplicate nonblank school/admission-number pairs already exist, rather than rewriting records to force the index.
5. **Smoke-check regression assertions** — added checks ensure these safety gates remain in place.

Do not enable any of these environment variables in production as a quick fix. Each repair should be planned, backed up, scoped to the intended school/rows and run once under an explicit maintenance procedure.

## 4. Important limitations and risks still to address

- `ensurePlatformOwnerProtection()` changes the configured owner user's active state and role controls during startup. This behaviour needs a separate review because a compatibility helper should not silently override deliberate account suspension or permissions.
- `ensureAssessmentWorkflowSchema()` still performs additive DDL on startup. The long-term design should move schema changes to versioned, explicit migrations rather than changing schemas implicitly whenever the server boots.
- The archive contains old correction notes and a nested ZIP. This audit uses the current top-level source files as code evidence, not old notes as proof of behaviour.
- No Supabase schema migrations were executed by this patch, and no production database was contacted.
- No end-to-end login, mark-entry, finance, parent portal, PDF, SMS or tenant-isolation tests were run against a live environment.

## 5. Recommended order of implementation

1. Confirm current source/commit and take a Git checkpoint.
2. Complete startup mutation review and move schema work into versioned migrations.
3. Test authentication, school boundaries, role permissions and platform-owner controls.
4. Regression-test existing academics: mark save, grading, merit, term reports, whole-class PDF, learner promotion and imports.
5. Build school finance as a distinct module from platform subscription billing.
6. Improve results analytics and parent/teacher/learner portals.
7. Add payroll, library, inventory movement ledger, exam generator and leaving certificates.
8. Add timetable conflict detection, HR, transport and boarding.
9. Integrate SMS, M-Pesa/banks, biometric devices and GPS only after provider/hardware choices are confirmed.

## 6. Verification performed

- JavaScript syntax checking across project files.
- Existing `npm run check` smoke script.
- Added static regression assertions for the startup repair guards.

Passing these checks is a useful baseline, not proof of production readiness.
