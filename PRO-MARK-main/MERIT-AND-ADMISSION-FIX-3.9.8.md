# PRO-MARK 3.9.8 — Merit + Admission Fix

- Merit PDF no longer creates a separate cover/extra first page; the merit register begins on the first page and only adds pages when content actually overflows.
- Merit tables now use full cell border/grid lines for a structured print layout.
- Repeated merit page headers remain on continuation pages.
- Excel school import no longer fabricates `IMPORT-...` admission numbers. Imported learners receive a NULL/blank admission number so the school can enter official admission numbers later.
- No SQL/database changes are required for these fixes.
