const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(
  'backend/routes/assessments.js', 'utf8'
);

const match = source.match(
  /function parseZelimuMark\(value,maxMark\)\s*\{[\s\S]*?\n\}/
);

assert.ok(match, 'Mark validator must exist');

const parse = vm.runInNewContext(
  '(' + match[0] + ')'
);

assert.equal(parse(0,100),0);
assert.equal(parse('0',100),0);
assert.equal(parse(75,100),75);
assert.equal(parse('75.5',100),75.5);
assert.equal(parse('',100),null);
assert.equal(parse(null,100),null);

for(const value of [
  -1,101,' ','abc',true,false,{},[],Infinity,NaN
]){
  assert.throws(
    ()=>parse(value,100),
    undefined,
    'Invalid mark should be rejected: '+String(value)
  );
}

const bulkStart = source.indexOf(
  "router.post('/:schoolId/marks/save'"
);
assert.ok(bulkStart>=0,'Bulk mark route missing');

const bulk = source.slice(bulkStart);

assert.ok(
  bulk.includes('Duplicate learner entries are not allowed'),
  'Duplicate learner validation missing'
);

assert.ok(
  bulk.includes("client.query('BEGIN')"),
  'Transaction start missing'
);

assert.ok(
  bulk.includes("client.query('COMMIT')"),
  'Transaction commit missing'
);

assert.ok(
  bulk.includes("client.query('ROLLBACK')"),
  'Transaction rollback missing'
);

assert.ok(
  bulk.includes('parseZelimuMark(row.mark,assessment.max_mark)'),
  'Bulk validation must use the resolved assessment maximum'
);

assert.ok(
  source.includes('parseZelimuMark(b.mark,a.max_mark)'),
  'Single mark validation must use the selected assessment maximum'
);

console.log('PASS: Valid marks accepted');
console.log('PASS: Invalid marks rejected');
console.log('PASS: Blank marks remain null');
console.log('PASS: Duplicate learner protection present');
console.log('PASS: Assessment maximum used');
console.log('PASS: Bulk transaction controls preserved');
