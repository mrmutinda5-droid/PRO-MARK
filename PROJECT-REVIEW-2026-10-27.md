# ZELIMU CBC source review — 27 October 2026

## Verified and fixed in this review
- The automatic timetable generator accepted repeated days, invalid day numbers, invalid start-time strings, and duplicate identical class/subject/teacher requirements. These inputs are now rejected.
- Ran `node scripts/smoke-check.js`: 34 JavaScript files checked; 27 navigation targets passed.
- Ran isolated generator tests for normal generation and rejection of the four invalid input categories.

## High-priority findings (NOT fixed in this review)
1. **Timetable generation coverage:** The dashboard generator can fall back to a single selected class/subject/teacher. A whole-school timetable needs persistent weekly lesson requirements per class/subject/teacher, fetched from the school database rather than assembled manually for one request.
2. **Existing timetable conflicts:** Generator checks clashes within its proposed output, but preview does not reconcile existing manual timetable entries or other year/term contexts. Saving requires careful overwrite controls and a UI comparison.
3. **Scheduling constraints:** No double-lesson grouping, subject maximum per day, teacher minimum breaks, teacher daily load, room capacity/type, or configurable bell breaks/lunch editor. ASC-level feature parity is not present.
4. **Timetable output:** No tested printable class/teacher/room timetable PDF or Excel export for the generated timetable.
5. **Data consistency:** Server validates school ownership of classes, subjects and teachers, but should also validate that the selected teacher is assigned to the selected class/subject and that year/term records are mutually consistent.
6. **Attendance:** QR/phone scanning requires real mobile browser testing and reliable matching to school-specific learner identifiers. It is not a fingerprint scanner.
7. **Transport:** GPS tracking, vehicles/drivers, fees and live tracking remain incomplete; route/allocation records alone are insufficient.
8. **Boarding:** Rooms and allocations exist, but supplies, welfare, fees, room movement history and boarding reports remain incomplete.
9. **HR:** Leave and training records exist, but approval chains, payroll linkage, appraisals, onboarding and document access need implementation and end-to-end tests.
10. **Finance & communication:** M-Pesa/bank reconciliation, receipts and SMS delivery need provider adapters, credentials, idempotency, delivery logs and live sandbox testing.
11. **Navigation:** A static menu-target smoke test does not prove every workflow is in the correct module. Audit user-visible labels and module ownership with role-by-role browser tests.
12. **Deployment:** PostgreSQL migration, concurrent writes, school isolation, role authorization and PDF generation require integration tests with a real test database before production.

## Recommended work order
1. Make timetable lesson requirements a school-scoped database model and build a full-school generator setup UI.
2. Add generator constraints, preview/edit/publish workflow and printable schedules.
3. Test learner enrollment, attendance, teacher mark entry, grading, reports, merit and finance end-to-end.
4. Finish Transport, Boarding, HR and Communication workflows with school-scoped database migrations.
5. Connect payment/SMS/device providers only after provider configuration is available.
6. Run cross-school access and role tests, database migration rehearsal and deployment smoke tests.

This is a development review, not certification that every module is production-ready.
