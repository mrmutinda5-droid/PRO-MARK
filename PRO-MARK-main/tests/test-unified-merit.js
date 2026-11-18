'use strict';const assert=require('node:assert/strict');const {calculate,subjectResult}=require('../backend/services/merit-flex-engine');
const ids=['a','b','c'];const marks=ids.map((id,i)=>({assessment_id:id,percent:[80,60,100][i]}));
assert.equal(subjectResult(marks,ids,'INDIVIDUAL',['b']).score,80);
assert.equal(subjectResult(marks,ids,'CAT_GROUP',['b']).score,80);
assert.equal(subjectResult(marks,ids,'CUSTOM',['b'],{a:20,b:30,c:50}).score,84);
assert.equal(subjectResult(marks,['a','b'],'CAT_GROUP',['b']).score,70);
const result=calculate([{learner_id:'one',marks:marks.map(m=>({...m,subject_id:'math'}))}],['math'],ids,'CUSTOM',['b'],{a:20,b:30,c:50});assert.equal(result[0].average,84);assert.equal(result[0].class_rank,1);
console.log('Unified merit engine tests passed.');
