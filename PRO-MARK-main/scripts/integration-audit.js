require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured in this terminal.');
  process.exit(2);
}

const pool = new Pool({
  connectionString: (() => {
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.delete('sslmode');
    return url.toString();
  })(),
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 15000
});

const required = [
  'schools', 'learners', 'classes', 'teachers', 'subjects',
  'academic_years', 'terms', 'learner_enrollments',
  'teacher_subject_assignments', 'class_teacher_assignments',
  'assessments', 'marks', 'school_fee_structures',
  'school_fee_charges', 'school_fee_payments',
  'school_fee_payment_allocations'
];

const checks = [
  ['learner-class-school',
   'learners l JOIN classes c ON c.id=l.class_id',
   'l.school_id IS DISTINCT FROM c.school_id',
   ['learners.class_id','learners.school_id','classes.id','classes.school_id']],
  ['mark-learner-school',
   'marks m JOIN learners l ON l.id=m.learner_id',
   'm.school_id IS DISTINCT FROM l.school_id',
   ['marks.learner_id','marks.school_id','learners.id','learners.school_id']],
  ['mark-assessment-school',
   'marks m JOIN assessments a ON a.id=m.assessment_id',
   'm.school_id IS DISTINCT FROM a.school_id',
   ['marks.assessment_id','marks.school_id','assessments.id','assessments.school_id']],
  ['fee-charge-learner-school',
   'school_fee_charges f JOIN learners l ON l.id=f.learner_id',
   'f.school_id IS DISTINCT FROM l.school_id',
   ['school_fee_charges.learner_id','school_fee_charges.school_id','learners.id','learners.school_id']],
  ['fee-payment-learner-school',
   'school_fee_payments p JOIN learners l ON l.id=p.learner_id',
   'p.school_id IS DISTINCT FROM l.school_id',
   ['school_fee_payments.learner_id','school_fee_payments.school_id','learners.id','learners.school_id']],
  ['fee-allocation-payment-school',
   'school_fee_payment_allocations a JOIN school_fee_payments p ON p.id=a.payment_id',
   'a.school_id IS DISTINCT FROM p.school_id',
   ['school_fee_payment_allocations.payment_id','school_fee_payment_allocations.school_id','school_fee_payments.id','school_fee_payments.school_id']],
  ['fee-overallocation',
   'school_fee_payments p JOIN school_fee_payment_allocations a ON a.payment_id=p.id',
   'TRUE GROUP BY p.id,p.amount HAVING SUM(a.amount)>p.amount',
   ['school_fee_payments.id','school_fee_payments.amount','school_fee_payment_allocations.payment_id','school_fee_payment_allocations.amount']]
];

(async () => {
  const client = await pool.connect();
  const results = [];
  try {
    await client.query('BEGIN READ ONLY');

    const meta = await client.query(`
      SELECT table_name,column_name
      FROM information_schema.columns
      WHERE table_schema=current_schema()
    `);
    const cols = new Set(meta.rows.map(
      x => `${x.table_name}.${x.column_name}`
    ));
    const tables = new Set(meta.rows.map(x => x.table_name));

    for (const table of required) {
      results.push({
        check: `table:${table}`,
        status: tables.has(table) ? 'PASS' : 'MISSING'
      });
    }

    for (const [name, from, condition, dependencies] of checks) {
      const missing = dependencies.filter(x => !cols.has(x));
      if (missing.length) {
        results.push({
          check: name,
          status: 'SKIPPED',
          reason: `Missing columns: ${missing.join(', ')}`
        });
        continue;
      }
      try {
        const sql = name === 'fee-overallocation'
          ? `SELECT COUNT(*)::int AS n FROM (
               SELECT p.id FROM ${from}
               WHERE ${condition}
             ) q`
          : `SELECT COUNT(*)::int AS n FROM ${from}
             WHERE ${condition}`;

        const response = await client.query(sql);
        const n = response.rows[0].n;
        results.push({
          check: name,
          status: n ? 'FAIL' : 'PASS',
          inconsistent_records: n
        });
      } catch (error) {
        results.push({
          check: name,
          status: 'ERROR',
          reason: error.message
        });
        break;
      }
    }

    await client.query('ROLLBACK');

    const problems = results.filter(
      x => ['MISSING','FAIL','ERROR'].includes(x.status)
    );

    console.log(JSON.stringify({
      system: 'ZELIMU CBC',
      mode: 'READ ONLY',
      results,
      problem_count: problems.length
    }, null, 2));

    process.exitCode = problems.length ? 1 : 0;
  } catch (error) {
    console.error('Audit error:', error.message);
    process.exitCode = 2;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
})().catch(e => {
  console.error(e.message);
  process.exitCode = 2;
});
