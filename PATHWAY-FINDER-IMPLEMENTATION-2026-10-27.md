# ZELIMU CBC Pathway Finder — 27 October 2026

## Added
- Public route: `/pathway-finder.html` (served as a static public page).
- Homepage navigation and hero CTA links to the Pathway Finder.
- Homepage section introduces the three CBC senior pathways: STEM, Social Sciences, and Arts and Sports Science.
- Three-step, responsive interest wizard: choose up to five interests, choose a pathway to explore, and view guidance.
- Includes 13 STEM interests, 18 Social Sciences interests and 14 Arts and Sports Science interests.
- Optional learning-area marks (0–100) add context to the results. Blank marks are permitted.
- Guidance makes clear that results are not official placement decisions or guarantees of eligibility.
- Choices and optional marks are kept in page memory only and are not sent to the server or saved to school records.

## Limitations / future integration
- This is a public, client-side guidance tool, not yet connected to learner login, school records, teacher recommendations, or official placement systems.
- The simple interest percentage is a transparent reflection of selected interests, not a validated psychometric score.
- Before storing learner-specific results, implement authenticated learner identity, school-boundary authorization, consent/privacy controls, and a dedicated data model/API.

## Checks
- `node --check` passed for inline scripts in `public/index.html` and `public/pathway-finder.html`.
- `node scripts/smoke-check.js` passed (59 JavaScript files checked).
- No database migration was added and no live deployment was performed.
