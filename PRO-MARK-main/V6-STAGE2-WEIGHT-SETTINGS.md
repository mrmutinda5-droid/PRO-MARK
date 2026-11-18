# V6 Stage 2A — Weight profile administration API

Adds authenticated, tenant-scoped GET/PUT `/api/merit-weight-profiles/:schoolId` with school default (`class_id: null`) and optional class overrides. Existing merit, report-card, and analytics calculations remain unchanged. No new dashboard controls yet.

**Prerequisite:** review and apply `database/029_merit_v6_weight_profiles.sql` only after database backup and a staging test. The endpoint requires this table.

GET query: `academic_year_id=<uuid>&term_id=<uuid>`; response `{profiles:[...]}`.

PUT JSON: `{ "academic_year_id":"uuid", "term_id":"uuid", "class_id":null, "weights":[{"assessment_type":"CAT_1","weight":20},{"assessment_type":"END_TERM","weight":80}] }`.

Permissions: administrators and headteachers may save; deputy and senior teachers may view. Tenant, academic year, term and class are checked before writing. The calculation engine and test suite are included from Stage 1, but Stage 2A does NOT yet connect weighting profiles to official merit/report-card output.

Test: `node --test tests/merit-v4-engine.test.js tests/merit-v6-engine.test.js tests/merit-v6-profiles.test.js && npm run check`

**Do not deploy this as the completed V6 merit system.** Next phase: class/subject-aware assessment resolution and read-only weighted merit preview, followed by shared report calculations and UI.
