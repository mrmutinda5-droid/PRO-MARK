# PRO-MARK 4.0.1 — Report Rank + Comparative Trends + Fast Analytics

## Corrected class rank
- Class rank now uses the same reportable subject averages used by the report card.
- Only learners in the selected class, academic year and term with reportable marks are included.
- Ranking is unique using `ROW_NUMBER()` with learner ID as a deterministic tie-breaker.
- A class with two assessed learners therefore produces ranks 1 and 2, not rank 3 from unrelated learners/marks.

## Report-card trend graph
- Replaced the single combined assessment/term mini-line with a comparative multi-subject line graph.
- Each subject has its own line and colour.
- Annual reports compare Subject 1/Subject 2/etc. across Term 1, Term 2 and Term 3.
- Term reports compare each subject across the configured assessments for that term.
- Legend, axis grid and points are included for readability.

## Results analysis
- Added real line graphs for subject-by-term trends and class/stream-by-term trends.
- Existing bar/table analysis remains available below the graphs.
- Added a short-lived browser cache (15 seconds) for repeated identical analytics selections.
- Added a server response cache (10 seconds, bounded) for repeated identical analytics selections to reduce repeated database work and prevent duplicate concurrent refresh pressure.

## Validation
- `node --check` passed for changed backend files.
- Dashboard JavaScript extracted from `public/dashboard.html` passes `node --check`.
- Full PRO-MARK smoke check passed: 31 JavaScript files checked.

No database migration is required for these changes.
