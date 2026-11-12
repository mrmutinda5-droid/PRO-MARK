# Sample class summary — integrated analytics extensions

Reference: uploaded 10-page Kithoni Junior School class summary.

The existing authenticated `/api/communications/:schoolId/analytics` response now includes:

- `subject_top_learners`: top ten learners per learning area, average, grade, rank, class and stream.
- `gender_by_subject`: learner count and average for each learning area and recorded gender.
- `subject_grade_distribution`: per-learning-area counts for the active grading bands.

These calculations reuse school-scoped learner/subject data already fetched by the analytics endpoint. No student names or marks from the example PDF were imported. Existing endpoint fields remain unchanged.

Not yet included: a full formatted 10-page PDF export, current-versus-previous *assessment* comparison, and verified live-database integration tests. Existing comparison logic compares terms rather than assessments.
