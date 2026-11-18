const test=require('node:test');const assert=require('node:assert/strict');
const {subjectScore,competitionRanks}=require('../backend/services/strict-merit');
test('three exams weighted once per subject, not divided by three',()=>{assert.equal(subjectScore([{assessment_id:'a',percent:60},{assessment_id:'b',percent:70},{assessment_id:'c',percent:80}],[{id:'a',weight:20},{id:'b',weight:30},{id:'c',weight:50}]),73);});
test('missing required exam is incomplete',()=>{assert.equal(subjectScore([{assessment_id:'a',percent:90}],[{id:'a',weight:20},{id:'b',weight:80}]),null);});
test('weights must total 100',()=>{assert.equal(subjectScore([{assessment_id:'a',percent:90}],[{id:'a',weight:80}]),null);});
test('ties use competition ranking and incomplete unranked',()=>{const r=competitionRanks([{learner_id:'a',average_mark:75,complete:true},{learner_id:'b',average_mark:75,complete:true},{learner_id:'c',average_mark:70,complete:true},{learner_id:'d',average_mark:null,complete:false}]);assert.deepEqual([...r.ranks.values()],[1,1,3]);assert.equal(r.ranks.has('d'),false);});
