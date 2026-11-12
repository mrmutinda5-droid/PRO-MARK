# Operations integrity update — 2026-10-27

Updated backend/routes/extended.js:
- Validates school-owned active learner references and UUIDs.
- Validates route and boarding room references against the same school.
- Enforces positive room capacities and nonnegative route fees.
- Rejects duplicate active transport and boarding allocations per learner.
- Checks boarding room capacity on allocation creation and edit.
- Validates leave date order and permitted statuses.
- Prevents deleting routes or rooms that have dependent allocations.

Validation: `node --check backend/routes/extended.js` and `npm run check` passed (32 JS files, 29 navigation targets).

Not production-certified: live PostgreSQL integration tests, concurrency-safe allocation transactions, provider integrations, role-by-role browser tests, SMS, GPS, payment gateways, and biometric hardware support remain outstanding. Capacity limits need database-level locking for concurrent users. No live payment, SMS, GPS, or fingerprint functionality is claimed.
