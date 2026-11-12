'use strict';

const assert = require('node:assert/strict');
const { buildPublicationSummary } = require('../backend/routes/communications');

const rows = [
  { published_learners: 5, sms_sent: 4, sms_queued: 1, sms_sending: 0, sms_failed: 1, sms_skipped: 2 },
  { published_learners: 2, sms_sent: 2, sms_queued: 0, sms_sending: 0, sms_failed: 0, sms_skipped: 0 },
  { published_learners: 0, sms_sent: 0, sms_queued: 0, sms_sending: 1, sms_failed: 0, sms_skipped: 1 }
];

const summary = buildPublicationSummary(rows);
assert.equal(summary.publications, 3);
assert.equal(summary.learners, 7);
assert.equal(summary.sms_sent, 6);
assert.equal(summary.sms_queued, 1);
assert.equal(summary.sms_sending, 1);
assert.equal(summary.sms_failed, 1);
assert.equal(summary.sms_skipped, 3);

console.log('Publication summary test passed');
