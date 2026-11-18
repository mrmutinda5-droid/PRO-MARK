# PRO-MARK 4.0.9 — Report Card PDF Repair — 2026-09-26

This build repairs the report-card generation path while preserving the existing 4.0.9 functionality.

## Included
- Hardened term and annual report PDF rendering.
- Defensive normalization of report data before PDF generation.
- Safe PDF fallback when a malformed report value or asset causes the detailed renderer to fail.
- Annual report subject grades/ranks are recalculated from annual averages instead of inheriting a single term grade.
- Annual totals/possible marks are calculated from annual subject averages.
- Subject rank is exposed directly on term and annual subject rows for the PDF renderer.
- Report PDF responses use `Cache-Control: no-store` to prevent stale browser PDF responses.
- Report routes now return the underlying safe error message/status instead of hiding all failures behind a generic 500.
- Frontend report PDF requests use `cache: 'no-store'`.

## Deployment
Use the supplied ZIP as the replacement project package. Keep the existing production database and environment configuration; do not overwrite production data.
