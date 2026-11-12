# Additional working CRUD workflows

Implemented tenant-scoped, role-protected database-backed CRUD for transport routes, transport learner allocations, boarding rooms, boarding learner allocations, HR leave records, and HR training records. Access through `/school-operations.html` using the school UUID and existing login token.

**Limitations:** This is a basic administrative record workflow, not a complete production transport, boarding or HR subsystem. There is no GPS feed, payroll, biometric hardware, payment gateway, SMS provider, approval chain, room-capacity enforcement, or automated transport billing. Real database, permission, mobile, and integration tests remain required.
