# V6 Stage 2B — read-only class weighted term merit

Opt-in GET `/api/merit-v6-term/:schoolId?academic_year_id=...&term_id=...&class_id=...`.
Requires SQL migration `029_merit_v6_weight_profiles.sql` and a saved default or class profile.
This does not replace existing `/api/merit` routes, reports, PDFs or dashboard. No database writes.
It requires historical `learner_enrollments`, assigned subjects, and one subject-independent assessment per selected type. Duplicate assessment types produce incomplete results rather than guessed scores. Grade-wide ranks intentionally omitted in class-only requests.
**Not production ready**: confirm assessment setup model (some schools create per-subject assessments), enrollment completeness, and class/stream ranking semantics before deployment. Test on staging DB first.
