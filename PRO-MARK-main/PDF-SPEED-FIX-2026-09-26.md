# PRO-MARK 4.0.9 — PDF Speed and Teacher Mark PDF Fix

## Applied changes

- Optimized term report generation for repeated learner/class PDF requests by caching short-lived class-level ranking, teacher-assignment, and staff context queries.
- Whole-class report generation retains bounded concurrency while avoiding repeated expensive school-wide ranking queries for every learner.
- Annual learner reports now build their term reports concurrently instead of waiting for each term sequentially.
- Teacher `SAVE MARK SHEET PDF` remains active and now uses a short-lived PDF cache for repeated clicks.
- Teacher mark-sheet PDF cache is invalidated immediately after marks are successfully saved, so the next PDF reflects newly entered marks.
- Report-card Term and Annual buttons now show an explicit busy state while the protected PDF is being prepared, preventing repeated clicks from creating overlapping requests.
- Existing report layout, grading, teacher attribution, school identity, marks, and working modules were not intentionally redesigned.

## Deployment checks

- `npm run check` passes.
- All JavaScript files pass Node syntax validation.
- `package.json` and `package-lock.json` remain included for Render's normal `npm install`/`npm ci` deployment process.
- `node_modules`, local environment files, and Git metadata are excluded from the release archive.
- Render uses the existing `npm start` entry point (`node backend/server.js`) and the server already binds to `0.0.0.0` and the platform-provided `PORT`.

## Important

The ZIP contains source code only. A live Render deployment still requires the Render service to have a valid `DATABASE_URL` and any other environment secrets required by the existing installation. No production database credentials are embedded in this archive.
