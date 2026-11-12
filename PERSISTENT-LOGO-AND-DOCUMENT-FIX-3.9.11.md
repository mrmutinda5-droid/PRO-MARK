# PRO-MARK 3.9.11 — Root document, PDF and persistence fixes

## Database
No SQL migration is required. The working Neon schema is untouched.

## Fixes
- School logo uploads are stored as database-backed image data URLs, so Render deploys/restarts no longer erase the logo.
- Merit PDF is rendered fully in memory before HTTP headers are sent, preventing partial/corrupt PDF responses.
- Class List PDF is rendered fully in memory before HTTP headers are sent.
- PDF opening is popup-safe: the new window is opened synchronously, then navigated to the authenticated PDF blob.
- Merit keeps one intentional cover page and one or more register pages only when content exists; no spacer/blank page is generated.
- Class learner registers are alphabetized by surname, then first name, then middle name.
- Class List PDF column widths are scaled to the actual A4 landscape page width, preventing off-page/clipped columns.
- Browser and PDF table rules use crisp black borders.
- Assessment mark-sheet PDFs also understand database-persisted logos.
- Dashboard GET requests retry once after a transient network/cold-start failure.
- Frequently loaded school overview data no longer includes the large logo payload.
