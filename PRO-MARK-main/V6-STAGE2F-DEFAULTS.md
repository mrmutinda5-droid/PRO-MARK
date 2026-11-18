# V6 Stage 2F — Suggested default assessment weights

This patch updates only `public/dashboard.html` in the existing V6 Stage 2C preview.

- Initial values: Opener 10%, CAT 1 10%, CAT 2 10%, Mid Term 30%, End Term 40%.
- When a saved school default exists, it is loaded instead of suggestions.
- Switching School default / Class override loads the corresponding saved profile, falling back to the school default and then suggestions.
- Suggested defaults are NOT automatically persisted. An administrator must click Save weights.
- Existing V6 API permissions and validation remain in force.
- Official reports, PDFs, and production routes are unchanged.

## Install

Back up `public/dashboard.html`, unzip in repository root, run `npm run check`, inspect in browser on feature branch. Do not merge to production until authenticated save/load and real-mark calculations are tested.
