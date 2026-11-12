# PRO-MARK 4.0.0 — 24-Module Operational Rebuild

## Critical correction: Term 3 imported marks

Term 3 now has a strict assessment model:
- OPENER
- END TERM

The workbook importer no longer converts an `AVERAGE` column into `END_TERM` silently. If a Term 3 workbook contains no explicit Opener or End Term column but contains only an Average column, that value is treated as the Term 3 Opener for the existing workbook-import workflow. Explicit End Term columns remain End Term.

On startup, existing Term 3 marks that were created by the old workbook importer with the provenance `Imported from uploaded workbook` are safely moved from End Term to the matching Opener assessment when no Opener mark already exists.

## Mark-entry authority

Platform Owner, School Admin and Admin are school-wide mark-entry authorities. They do not depend on a teacher profile or teacher-specific mark-entry toggle. The mark-entry workspace loads the school's active teacher/class/subject assignments and labels the administrator view as **SCHOOL-WIDE AUTHORITY**.

## Mark progress

Marks Management now includes a persistent class-by-class progress view showing:
- expected marks
- entered marks
- missing marks
- percentage completion
- NOT STARTED / IN PROGRESS / COMPLETE status
- class, stream, subject and assessment

## 24-module navigation

The old mixed navigation is replaced by the exact 24-module sequence:
1. PLATFORM OWNER / SCHOOL ENROLLMENT
2. SCHOOL ADMIN SETUP
3. USER / STAFF ENROLLMENT
4. LEARNER ENROLLMENT
5. PARENT/GUARDIAN MANAGEMENT
6. ACADEMIC MANAGEMENT
7. ASSESSMENTS
8. MARK ENTRY
9. MARKS MANAGEMENT
10. ACADEMIC PERFORMANCE
11. REPORT CARDS
12. MERIT / PERFORMANCE ANALYSIS
13. ATTENDANCE
14. DISCIPLINE
15. COMMUNICATION
16. DOCUMENTS
17. SCHOOL FINANCE / BILLING
18. INVENTORY / ASSETS
19. TIMETABLE
20. EXAMINATION CONTROL
21. ADMINISTRATION
22. PLATFORM OWNER CONTROL
23. IMPORT / EXPORT
24. AUDIT & SECURITY

## Persistent operational domains added

The database compatibility layer now creates persistent tables for:
- attendance records
- discipline cases
- inventory/assets
- timetable entries

The dashboard has operational workspaces for these modules rather than temporary placeholder buttons.

## Security / isolation

The new operations endpoints remain school-bound and role controlled. Export is scoped to the current school. Audit viewing is restricted to administrative roles.
