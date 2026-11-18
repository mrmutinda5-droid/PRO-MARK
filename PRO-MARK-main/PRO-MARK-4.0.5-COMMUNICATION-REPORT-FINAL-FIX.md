# PRO-MARK 4.0.5 — Communication + Whole-Class Report Final Fix

## Communication
- Communication Centre now loads the selected academic year's terms immediately.
- Parent selector loads the full parent/guardian directory.
- Learner selector can be filtered by selected class/year/term.
- Class-wide SMS is now supported directly from Communication Centre.
- Result publication remains term-specific and duplicate-protected.

## Whole-class report cards
- Class report learner selection accepts both the selected academic-year enrollment and the learner's current class assignment as a compatibility fallback.
- Learners are deduplicated before report generation.
- The existing report merger remains one PDF containing all generated learner report pages.
- Response headers expose report/page counts for verification.

## Database
Apply only `database/021_parent_publish_and_duplicate_guard.sql`. It removes duplicate published-result records with the same learner/parent/year/term before creating the unique protection index. Do not rerun the full schema.
