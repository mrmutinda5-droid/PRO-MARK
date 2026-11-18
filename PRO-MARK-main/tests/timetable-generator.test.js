'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {generate}=require('../backend/services/timetable-generator');

const settings={days:[1,2,3],periods_per_day:4,lesson_minutes:40,start_time:'08:00'};

test('places every requested class/subject/teacher occurrence without overlaps',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:3},
  {class_id:'class-b',subject_id:'english',teacher_id:'teacher-a',lessons_per_week:3}
 ],settings});
 assert.equal(result.complete,true);
 assert.equal(result.scheduled.length,6);
 const occupied=new Set();
 for(const lesson of result.scheduled){
  const key=`${lesson.teacher_id}:${lesson.day}:${lesson.period}`;
  assert.equal(occupied.has(key),false);
  occupied.add(key);
 }
});

test('expands double periods into contiguous bell slots',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'science',teacher_id:'teacher-a',lessons_per_week:2,periods_per_lesson:2,room:'Lab'}
 ],settings:{...settings,rooms:[{room_name:'Lab',capacity:40}]}});
 assert.equal(result.complete,true);
 assert.equal(result.scheduled.length,2);
 for(const lesson of result.scheduled){
  assert.equal(lesson.periods_per_lesson,2);
  assert.equal(lesson.end_time,lesson.period===1?'09:20':'10:40');
  assert.equal(lesson.room,'Lab');
 }
 assert.equal(result.workload['teacher-a'].periods,4);
});

test('assigns available rooms and prevents double-booking a room',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:2,class_size:30},
  {class_id:'class-b',subject_id:'english',teacher_id:'teacher-b',lessons_per_week:2,class_size:20}
 ],settings:{...settings,days:[1],rooms:[
  {room_name:'Small',capacity:25},
  {room_name:'Large',capacity:40}
 ]}});
 assert.equal(result.complete,true);
 assert.equal(result.scheduled.length,4);
 assert.ok(result.scheduled.filter(x=>x.class_id==='class-a').every(x=>x.room==='Large'));
 const busy=new Set();
 for(const lesson of result.scheduled){
  const key=`${lesson.room}:${lesson.day}:${lesson.period}`;
  assert.equal(busy.has(key),false);
  busy.add(key);
 }
});

test('uses saved availability and blocked periods as hard constraints',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:2}
 ],settings:{...settings,days:[1],periods_per_day:2,blocked:[{day:1,period:1}],teacher_unavailable:[{teacher_id:'teacher-a',day:1,period:2}]}});
 assert.equal(result.complete,false);
 assert.equal(result.placed,0);
 assert.equal(result.unscheduled.length,2);
});

test('honors hard preferred day and period',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:1,preferred_day:2,preferred_period:3,hard_preference:true}
 ],settings});
 assert.equal(result.complete,true);
 assert.equal(result.scheduled[0].day,2);
 assert.equal(result.scheduled[0].period,3);
});

test('preserves locked placements while scheduling the remaining occurrences',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:2}
 ],settings:{...settings,locked:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',day:2,period:4,start_time:'10:00',end_time:'10:40'}
 ]}});
 assert.equal(result.complete,true);
 assert.equal(result.scheduled.filter(x=>x.locked).length,1);
 assert.ok(result.scheduled.some(x=>x.locked&&x.day===2&&x.period===4));
});

test('preserves the room on a locked placement and rejects ineligible locked rooms',()=>{
 const requirement={class_id:'class-a',subject_id:'science',teacher_id:'teacher-a',lessons_per_week:1};
 const locked={class_id:'class-a',subject_id:'science',teacher_id:'teacher-a',day:1,period:2,start_time:'08:40',end_time:'09:20',room:'Lab B'};
 const configured={...settings,rooms:['Lab A','Lab B'],locked:[locked]};
 const result=generate({requirements:[requirement],settings:configured});
 assert.equal(result.scheduled[0].room,'Lab B');
 assert.throws(()=>generate({requirements:[requirement],settings:{...configured,rooms:['Lab A']}}),/unavailable or ineligible room/);
});

test('preserves an intentionally unassigned room on a locked placement',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'science',teacher_id:'teacher-a',lessons_per_week:1}
 ],settings:{...settings,rooms:['Lab A'],locked:[
  {class_id:'class-a',subject_id:'science',teacher_id:'teacher-a',day:1,period:1,start_time:'08:00',end_time:'08:40',room:null}
 ]}});
 assert.equal(result.scheduled[0].locked,true);
 assert.equal(result.scheduled[0].room,'');
});

test('does not form a double period across a configured break',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'science',teacher_id:'teacher-a',lessons_per_week:1,periods_per_lesson:2}
 ],settings:{days:[1],periods_per_day:3,period_start_times:['08:00','09:00','09:40'],period_end_times:['08:40','09:40','10:20']}});
 assert.equal(result.complete,true);
 assert.equal(result.scheduled[0].period,2);
});

test('enforces teacher workload limits and returns schedule diagnostics',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:2}
 ],settings:{...settings,days:[1],periods_per_day:4,teacher_limits:[{teacher_id:'teacher-a',max_daily_periods:1,max_weekly_periods:1}]}});
 assert.equal(result.complete,false);
 assert.equal(result.placed,1);
 assert.equal(result.teacher_workload['teacher-a'].periods,1);
 assert.equal(result.class_workload['class-a'].periods,1);
 assert.equal(result.hard_constraints.valid,true);
 assert.equal(result.soft_preference_score,null);
 assert.equal(result.unscheduled_lessons,1);
});

test('rejects workload limits larger than the configured timetable capacity',()=>{
 const requirement={class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:1};
 assert.throws(()=>generate({requirements:[requirement],settings:{...settings,teacher_limits:[{teacher_id:'teacher-a',max_daily_periods:5}]}}),/Invalid max daily periods/);
 assert.throws(()=>generate({requirements:[requirement],settings:{...settings,teacher_limits:[{teacher_id:'teacher-a',max_weekly_periods:13}]}}),/Invalid max weekly periods/);
});

test('scores soft preferences per scheduled lesson occurrence',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:2,preferred_day:1,preferred_period:1}
 ],settings:{days:[1],periods_per_day:2}});
 assert.equal(result.complete,true);
 assert.equal(result.soft_preference_score,75);
});

test('returns a partial diagnostic and unplaced lesson reasons when infeasible',()=>{
 const result=generate({requirements:[
  {class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:3},
  {class_id:'class-b',subject_id:'english',teacher_id:'teacher-a',lessons_per_week:3}
 ],settings:{...settings,days:[1],periods_per_day:4}});
 assert.equal(result.complete,false);
 assert.ok(result.placed>0);
 assert.ok(result.placed<result.required);
 assert.equal(result.unscheduled.length,result.required-result.placed);
 assert.match(result.reason,/No complete conflict-free timetable/);
});

test('rejects duplicate requirements and invalid calendar settings',()=>{
 const requirement={class_id:'class-a',subject_id:'math',teacher_id:'teacher-a',lessons_per_week:1};
 assert.throws(()=>generate({requirements:[requirement,requirement],settings}),/Duplicate/);
 assert.throws(()=>generate({requirements:[requirement],settings:{...settings,days:[1,1]}}),/unique/);
});
