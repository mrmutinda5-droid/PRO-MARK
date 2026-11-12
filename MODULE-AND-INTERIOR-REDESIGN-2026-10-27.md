# ZELIMU CBC — Module Placement & Interior Redesign

## Scope
- Refreshed the school operations dashboard navigation and interior styling for a more polished, consistent SaaS appearance.
- Preserved existing workspace IDs and event targets so navigation continues to use the existing handlers.
- Kept report-card and merit document formats out of the visual redesign.

## Module placement changes
- Staff records and staff assignment/role controls now appear under HR & Staff Services rather than duplicating staff enrollment in Administration.
- Learner enrollment, parent/guardian management, attendance, discipline/welfare and class registers remain under Administration.
- Teaching Resource Library is grouped under Academic, while official school documents and branding assets remain under Accounts & School Setup.
- Inventory & School Assets is grouped under School Operations rather than a miscellaneous extra-workspaces group.
- Renamed account/role navigation labels to clarify purpose without changing underlying routes.
- Transport and Boarding remain clearly marked as planned; unfinished features are not presented as operational.

## Visual changes
- Updated dashboard background, module card hierarchy, spacing, borders, typography, hover states and responsive breakpoints.
- Added consistent branded accent strips and calmer neutral surfaces.
- Styles target navigation/dashboard chrome only. Report-card, report-PDF and merit-sheet output formats were not intentionally changed.

## Validation
- `npm run check` passed.
- Existing module identifiers were preserved. No database migration was introduced.
- Live browser, API, and Supabase checks have not been performed; deploy to staging first and verify role visibility and each module click.
