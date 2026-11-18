'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {weightedSubject,learnerAverage,scopedRanks}=require('../backend/services/merit-v4-engine');
const exams=[{id:'a',weight:20},{id:'b',weight:30},{id:'c',weight:50}];
test('weighted average once, without dividing by exam count',()=>{
 assert.equal(weightedSubject([{assessment_id:'a',percent:50},{assessment_id:'b',percent:70},{assessment_id:'c',percent:90}],exams).score,76);
});
test('missing exam blocks official score',()=>assert.equal(weightedSubject([{assessment_id:'a',percent:90}],exams).complete,false));
test('invalid weights block official score',()=>assert.equal(weightedSubject([{assessment_id:'a',percent:90}],exams.slice(0,2)).reason,'INVALID_WEIGHTS'));
test('zero marks are valid',()=>assert.equal(weightedSubject(exams.map(x=>({assessment_id:x.id,percent:0})),exams).score,0));
test('duplicate exam mark blocks official score',()=>assert.equal(weightedSubject([{assessment_id:'a',percent:50},{assessment_id:'a',percent:60}],exams).reason,'DUPLICATE_MARK'));
test('all expected subjects used as denominator',()=>{
 assert.equal(learnerAverage([{subject_id:'1',complete:true,score:80},{subject_id:'2',complete:true,score:60}],['1','2']).average,70);
 assert.equal(learnerAverage([{subject_id:'1',complete:true,score:80}],['1','2']).complete,false);
});
test('approved exemption excludes only exempt subject',()=>assert.equal(learnerAverage([{subject_id:'1',complete:true,score:80}],['1','2'],['2']).average,80));
test('ties, incomplete learners, independent grade and stream ranks',()=>{
 const r=scopedRanks([
 {learner_id:'a',class_id:'east',school_level_id:'7',complete:true,average:90},
 {learner_id:'b',class_id:'east',school_level_id:'7',complete:true,average:80},
 {learner_id:'c',class_id:'west',school_level_id:'7',complete:true,average:90},
 {learner_id:'d',class_id:'west',school_level_id:'7',complete:false,average:null},
 {learner_id:'e',class_id:'north',school_level_id:'8',complete:true,average:95}
 ]);
 assert.equal(r[0].overall_rank,1);assert.equal(r[2].overall_rank,1);
 assert.equal(r[1].overall_rank,3);assert.equal(r[1].stream_rank,2);
 assert.equal(r[3].overall_rank,null);assert.equal(r[3].stream_rank,null);
 assert.equal(r[4].overall_rank,1);
});
