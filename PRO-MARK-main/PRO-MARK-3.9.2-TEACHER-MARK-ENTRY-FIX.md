# PRO-MARK 3.9.2 — Teacher Mark Entry loading fix

Fixes the teacher mark-entry selectors becoming unusable when academic/assessment data is returned in a slightly different shape or when the teacher login user ID uses a different field name.

## Teacher flow
Assessment → Class → Subject → automatic learner roster → marks

Selectors remain touch-friendly and unlock sequentially. Assessment remains enabled; Class unlocks after assessment; Subject unlocks after class.
