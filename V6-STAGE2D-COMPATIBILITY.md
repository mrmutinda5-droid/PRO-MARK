# ZELIMU V6 Stage 2D — Assessment matching compatibility

This patch updates the read-only weighted term route to support subject-specific and class-specific assessment records. It chooses the most specific matching setup, rejects equally specific duplicates, and refuses to invent missing marks. It does NOT apply database migrations or change official merit, PDF, reports, or marks.

**Important limitation:** Class-wide subject assignments still determine expected subjects; verify they match the school's curriculum. Grade-wide ranking is not implemented in this route. If two different assessments have the same specificity (e.g. class-only and subject-only), the result is deliberately marked ambiguous. Validate school data before relying on rankings.

Install on `feature/merit-v6` after Stage 2C, run `node --test tests/merit-v6-assessment-match.test.js tests/merit-v6-engine.test.js tests/merit-v6-profiles.test.js tests/merit-v4-engine.test.js` and `npm run check`. Keep migration 029 pending until a database backup and test-environment verification.
