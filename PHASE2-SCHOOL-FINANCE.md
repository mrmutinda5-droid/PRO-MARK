# ZELIMU CBC — Phase 2: School Finance

## Included in this checkpoint

- A dedicated School Fees & Receipts workspace, separate from Platform Subscription Billing.
- Fee structure creation by academic year and class/stream.
- Idempotent assignment of a fee structure to active learners in the selected class.
- Separate class-specific structures with editable printed instructions; updates affect future assignments without rewriting issued charges.
- Safe removal: unused structures can be deleted, while structures with issued charges are archived to preserve the learner ledger.
- Printable school fee structures and learner-specific, itemized fee statements with charges, receipts, totals, credit and balances.
- Responsive payment entry layout for desktop and mobile screens.
- Recording of learner payments with generated receipt numbers, method/reference/date/notes.
- Allocation of payments against the learner's oldest outstanding charges; any excess remains a prepaid account credit and is allocated to later charges.
- Ledger-derived learner balances: total valid charges less total valid payments, including prepaid credits.
- Unique school-scoped payment references, generated receipt numbers, and append-only credit-note reversals.
- Receipt updates are rejected at the database layer; correction uses a separate audited reversal record.
- Outstanding-charge, account-balance, payment and fee-structure lists; summary totals; printable receipt view.
- Bursar finance summary includes net collections for today and the current month, excluding reversed receipts.
- Tenant-bound API routes and school/user checks for finance writes.
- Audit-log events for fee-structure creation, payment recording and receipt reversals.

## Database migration required

For a new database, apply `database/028_school_finance_core.sql`, `database/033_school_fee_ledger_integrity.sql`, then `database/034_school_fee_structure_print_notes.sql`. For an existing installation with 028 and 033 applied, apply only migration 034. Take a verified backup first. These migrations are intentionally manual; startup does not apply them automatically. Migration 033 preserves existing receipts and their references, backfills unallocated payment credit against outstanding charges in chronological order, adds duplicate-reference protection for new receipts, and creates the append-only credit-note ledger. Migration 034 adds editable printed instructions to fee structures and has been applied and verified on the configured database.

## Current limitations (not yet implemented)

- M-Pesa is currently a manually recorded payment method, not a live Daraja/STK Push integration or automated reconciliation.
- Bank transfers are manually recorded; there is no bank feed integration.
- Payroll is not part of this phase.
- SMS fee reminders and parent-facing balances are not yet connected to this ledger.
- The first version supports KES only to prevent cross-currency payment allocation errors.
- Bursars can manage fee structures, record payments and expenses, and issue receipt reversals; approval and category-management actions remain restricted to school administrators or authorised school leadership.

## Checks run

- `node --check backend/routes/finance.js`
- `node --check backend/routes/school-documents.js`
- Finance ledger unit tests
- Inline dashboard JavaScript syntax check
- `npm run check`

Run the migration on staging first, verify tenant boundaries and payment allocation, then deploy the same reviewed migration and code to production.
