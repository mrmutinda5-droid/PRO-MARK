# Timetable generator implementation

Added backend/services/timetable-generator.js and backend/routes/timetable-generator.js, mounted at /api/timetable-generator/:schoolId/generate. Academic timetable UI has preview/save controls.

Inputs: class/subject/teacher/weekly lesson requirements, periods per day, lesson length, first lesson, optional blocked slots and teacher unavailable slots via API. The engine uses bounded backtracking and prevents teacher, class and room clashes. Save is school-scoped and transactionally replaces the selected year/term only with explicit replace=true. Database records and authentication are reused.

Limitations: no ASC proprietary code; this is a foundational generator, not feature parity. The dashboard currently offers a simple per-assignment lesson count and falls back to one selected class/subject/teacher; full school-wide subject load configuration, double lessons, advanced constraints, break-time editor, timetable PDFs and browser/database integration tests remain. Set academic year/term explicitly via API when needed. Production deployment requires real PostgreSQL and role testing.
