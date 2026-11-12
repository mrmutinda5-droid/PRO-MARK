# PRO-MARK 4.0.0 — Promotion Engine + School Calendar + Expanded Analytics

## Promotion / progression engine
- Bulk promotion from source academic year/class to destination academic year/class.
- Automatically suggests the next level and preserves the stream where possible.
- Creates/updates destination learner enrollment with `previous_class_id`.
- Completes the source-year enrollment without deleting marks or reports.
- Updates the learner's current class pointer.
- Records an approved `PROMOTION` movement event for every learner.
- Records a bulk audit event.
- Destination effective date uses the destination academic year's start date when available.

## Report-card school calendar
- Report cards already use term opening/closing dates.
- They now also show the next reopening date.
- Term 3 looks ahead to Term 1 of the next academic year when available.
- Dashboard report-card workspace displays the selected term closing date and next reopening date.

## Expanded analytics
Added data for:
- term-to-term school/class trends;
- subject-by-term trends;
- class/stream-by-term trends;
- learner trajectories across terms;
- top improvers;
- top declining learners;
- assessment comparison;
- target vs actual subject achievement;
- teacher/subject/class performance;
- competency distribution EE/ME/AE/BE;
- gender comparison;
- teacher filter support in analytics.

## Validation
`npm run check` / smoke check: 30 JavaScript files checked successfully.
