# ZELIMU CBC V6 — Weighted Merit Foundation (Stage 1)

This is a **safe, additive foundation**, not a finished live merit replacement.

- New pure engine: `backend/services/merit-v6-engine.js`.
- Tests: `tests/merit-v6-engine.test.js`.
- Optional, review-first migration: `database/029_merit_v6_weight_profiles.sql`.
- School default plus class-specific override; validates exact 100%.
- Missing marks or assessment setup block official scores and ranks; zero marks count as valid.
- This package **does not alter the existing V5 dashboard, merit route, reports, or Supabase records**.
- **Do not run the migration yet**; configuration API and integration into merit/PDF/report cards are the next stage.
- No API is exposed by this stage; weights are not yet saved from the portal.

## Test
`node --test tests/merit-v6-engine.test.js tests/merit-v4-engine.test.js`
`npm run check`

## Next stage
Create authenticated, school-scoped configuration endpoints, link the admin interface, load expected subjects/enrollments, and switch term merit + PDF + report cards to one shared engine only after reconciliation tests.
