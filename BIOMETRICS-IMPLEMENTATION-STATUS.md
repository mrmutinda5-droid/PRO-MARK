# ZELIMU CBC biometric foundation — 2026-10-27

Implemented: school-isolated device registry (planned devices), future device-person reference mapping schema, event register, manual learner/staff check-in and check-out, role-restricted API, school-specific audit fields, and dedicated dashboard workspace.

Not implemented: fingerprint/face capture, vendor integration, device signing, device event ingestion, verified biometric attendance, payroll automation, guardian notifications or biometric enrolment. These require approved hardware, a secure vendor-specific adapter, consent/retention rules and live testing.

Existing transport, boarding and HR workspaces remain generic record-management functions. They are not represented as complete production integrations.

Deploy requires PostgreSQL CREATE TABLE permission for the application role, because extended-schema.js creates these tables on startup. Back up the database before deployment.
