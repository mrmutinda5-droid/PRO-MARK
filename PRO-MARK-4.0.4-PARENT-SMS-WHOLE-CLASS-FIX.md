# PRO-MARK 4.0.4

- Whole-class report generation is atomic and merges every enrolled learner report.
- Report-card class register now loads from academic-year enrollment.
- Class PDF returns report/page counts for verification.
- Added Parent & School Communication Centre for class result publication, parent SMS and communication history.
- Published result SMS is deduplicated per learner + parent + academic year + term.
- Custom duplicate messages within 10 minutes are skipped.
- Removed duplicate primary navigation entries for resource library, class lists and teacher assignment; they remain accessible from their main modules.

Apply `database/021_parent_publish_and_duplicate_guard.sql` to the existing Neon database.
