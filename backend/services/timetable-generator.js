'use strict';

const DEFAULT_DAYS=[1,2,3,4,5];
const MAX_TASKS=800;
const MAX_ATTEMPTS=250000;

function integer(value,fallback=null){
 const result=Number(value);
 return Number.isInteger(result)?result:fallback;
}

function minutes(value){
 const match=String(value||'').match(/^(\d{1,2}):(\d{2})$/);
 if(!match)return NaN;
 const hours=Number(match[1]),mins=Number(match[2]);
 return hours<=23&&mins<=59?hours*60+mins:NaN;
}

function formatTime(value){
 return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
}

function generate({requirements,settings={}}){
 if(!Array.isArray(requirements)||!requirements.length)throw Error('At least one lesson requirement is required');
 const days=Array.isArray(settings.days)&&settings.days.length?settings.days.map(x=>integer(x,null)):DEFAULT_DAYS;
 if(days.some(x=>x===null||x<1||x>7)||new Set(days).size!==days.length)throw Error('Teaching days must be unique integers between 1 and 7');
 const periodCount=integer(settings.periods_per_day,8);
 const periodDuration=integer(settings.lesson_minutes,40);
 if(periodCount<1||periodCount>12||periodDuration<20||periodDuration>180)throw Error('Timetable must have 1–12 periods per day and periods of 20–180 minutes');
 const start=minutes(settings.start_time||'08:00');
 if(!Number.isInteger(start)||start<360||start+periodCount*periodDuration>1440)throw Error('Invalid timetable start time or bell schedule');

 const periodStarts=Array.isArray(settings.period_start_times)?settings.period_start_times:[];
 const periodEnds=Array.isArray(settings.period_end_times)?settings.period_end_times:[];
 const slots=[];
 for(const day of days){
  for(let i=0;i<periodCount;i++){
   const slotStart=periodStarts[i]?minutes(periodStarts[i]):start+i*periodDuration;
   const slotEnd=periodEnds[i]?minutes(periodEnds[i]):slotStart+periodDuration;
   if(!Number.isInteger(slotStart)||!Number.isInteger(slotEnd)||slotEnd<=slotStart)throw Error(`Invalid bell time for period ${i+1}`);
   if(i&&slotStart<minutes(periodEnds[i-1]||formatTime(start+(i-1)*periodDuration+periodDuration)))throw Error('Periods must be in chronological order without overlaps');
   slots.push({day,period:i+1,start_minute:slotStart,end_minute:slotEnd,start_time:formatTime(slotStart),end_time:formatTime(slotEnd)});
  }
 }

 const blocked=new Set((settings.blocked||[]).map(x=>`${integer(x.day,null)}:${integer(x.period,null)}`));
 const unavailable=new Set((settings.teacher_unavailable||[]).map(x=>`${x.teacher_id}:${integer(x.day,null)}:${integer(x.period,null)}`));
 const roomUnavailable=new Set((settings.room_unavailable||[]).map(x=>`${x.room}:${integer(x.day,null)}:${integer(x.period,null)}`));
 const rooms=(settings.rooms||[]).map(room=>typeof room==='string'?{room_name:room,capacity:null}:{...room});
 const teacherLimits=new Map((settings.teacher_limits||[]).map(limit=>{
  if(!limit?.teacher_id)throw Error('Teacher workload limits must identify a teacher');
  for(const key of ['max_daily_periods','max_weekly_periods']){
   if(limit[key]!==undefined&&limit[key]!==null&&(!Number.isInteger(Number(limit[key]))||Number(limit[key])<1||Number(limit[key])>periodCount*days.length))
    throw Error(`Invalid ${key.replaceAll('_',' ')} for teacher ${limit.teacher_id}`);
  }
  return [String(limit.teacher_id),limit];
 }));
 const tasks=[],keys=new Set();
 for(const requirement of requirements){
  const classId=requirement.class_id,subjectId=requirement.subject_id,teacherId=requirement.teacher_id;
  const count=integer(requirement.lessons_per_week,null);
  const length=integer(requirement.periods_per_lesson,1);
  const key=`${classId}:${subjectId}:${teacherId}`;
  if(!classId||!subjectId||!teacherId)throw Error('Each lesson requirement must have an assigned class, subject and teacher');
  if(keys.has(key))throw Error('Duplicate class/subject/teacher lesson requirement');
  keys.add(key);
  if(count===null||count<1||count>days.length*periodCount||length===null||length<1||length>3)throw Error('Weekly lesson count must be valid and lesson length must be 1–3 consecutive periods');
  const dailyMax=integer(requirement.max_per_day,0);
  const classSize=integer(requirement.class_size,0);
  const requiredRoom=String(requirement.room||'').trim();
  const roomOptions=requiredRoom?rooms.filter(room=>String(room.room_name)===requiredRoom):rooms;
  const eligibleRoomNames=roomOptions.filter(room=>!room.capacity||!classSize||Number(room.capacity)>=classSize).map(room=>String(room.room_name));
  const roomNames=eligibleRoomNames.length?eligibleRoomNames:(requiredRoom?[]:['']);
  const allowedDays=Array.isArray(requirement.allowed_days)&&requirement.allowed_days.length?requirement.allowed_days.map(x=>integer(x,null)):days;
  if(allowedDays.some(x=>x===null||!days.includes(x)))throw Error('A lesson requirement uses a day outside the timetable calendar');
  for(let n=0;n<count;n++)tasks.push({...requirement,room_options:roomNames,class_id:classId,subject_id:subjectId,teacher_id:teacherId,periods_per_lesson:length,max_per_day:dailyMax,allowed_days:allowedDays,sequence:n});
 }
 if(tasks.length>MAX_TASKS)throw Error(`Maximum ${MAX_TASKS} lesson occurrences per generation`);

 for(const task of tasks){
  task.candidates=[];
  for(const slot of slots){
   if(!task.allowed_days.includes(slot.day)||slot.period+task.periods_per_lesson-1>periodCount)continue;
   const block=slots.filter(x=>x.day===slot.day&&x.period>=slot.period&&x.period<slot.period+task.periods_per_lesson);
   if(block.length!==task.periods_per_lesson)continue;
   let contiguous=true;
   for(let i=1;i<block.length;i++)if(block[i-1].end_minute!==block[i].start_minute)contiguous=false;
   if(!contiguous||block.some(x=>blocked.has(`${x.day}:${x.period}`)))continue;
   task.candidates.push({day:slot.day,period:slot.period,start_time:block[0].start_time,end_time:block[block.length-1].end_time,periods:block.map(x=>x.period)});
  }
 }

 for(const lock of settings.locked||[]){
  const task=tasks.find(x=>x.class_id===lock.class_id&&x.subject_id===lock.subject_id&&x.teacher_id===lock.teacher_id&&!x.lockedCandidate);
  if(!task)throw Error(`Locked placement for ${lock.class_id}/${lock.subject_id} has no matching lesson requirement`);
  if(lock.room&&!task.room_options.includes(String(lock.room)))throw Error(`Locked placement for ${lock.class_id}/${lock.subject_id} requires an unavailable or ineligible room`);
  const candidate=task.candidates.find(x=>x.day===Number(lock.day)&&x.period===Number(lock.period)&&x.start_time===String(lock.start_time).slice(0,5)&&x.end_time===String(lock.end_time).slice(0,5));
  if(!candidate)throw Error(`Locked placement for ${lock.class_id}/${lock.subject_id} does not match the configured bell schedule`);
  task.lockedCandidate=candidate;task.lockedRoom=lock.room?String(lock.room):'';
 }

 const classBusy=new Set(),teacherBusy=new Set(),roomBusy=new Set(),subjectDaily=new Map(),placed=[];
 const teacherDailyPeriods=new Map(),teacherWeeklyPeriods=new Map();
 const lessonsPerTeacher=new Map();
 for(const task of tasks)lessonsPerTeacher.set(task.teacher_id,(lessonsPerTeacher.get(task.teacher_id)||0)+task.periods_per_lesson);
 tasks.sort((a,b)=>Number(Boolean(b.lockedCandidate))-Number(Boolean(a.lockedCandidate))||a.candidates.length-b.candidates.length||b.periods_per_lesson-a.periods_per_lesson||
  (lessonsPerTeacher.get(b.teacher_id)-lessonsPerTeacher.get(a.teacher_id))||
  String(a.class_id).localeCompare(String(b.class_id))||String(a.subject_id).localeCompare(String(b.subject_id)));
 let attempts=0,stopped=false,bestPlaced=[];

 function canPlace(task,candidate){
  const dayKey=`${task.class_id}:${task.subject_id}:${candidate.day}`;
  if(task.preferred_day&&Number(task.preferred_day)!==candidate.day&&task.hard_preference)return false;
  if(task.preferred_period&&Number(task.preferred_period)!==candidate.period&&task.hard_preference)return false;
  if(task.max_per_day&&((subjectDaily.get(dayKey)||0)+1)>task.max_per_day)return false;
  const limits=teacherLimits.get(String(task.teacher_id))||{};
  const dailyKey=`${task.teacher_id}:${candidate.day}`,dailyPeriods=teacherDailyPeriods.get(dailyKey)||0,weeklyPeriods=teacherWeeklyPeriods.get(task.teacher_id)||0;
  if(limits.max_daily_periods&&dailyPeriods+candidate.periods.length>Number(limits.max_daily_periods))return false;
  if(limits.max_weekly_periods&&weeklyPeriods+candidate.periods.length>Number(limits.max_weekly_periods))return false;
  for(const period of candidate.periods){
   const slotKey=`${candidate.day}:${period}`;
   if(classBusy.has(`${task.class_id}:${slotKey}`)||teacherBusy.has(`${task.teacher_id}:${slotKey}`))return false;
   if(unavailable.has(`${task.teacher_id}:${slotKey}`))return false;
   if(candidate.room&&roomUnavailable.has(`${candidate.room}:${slotKey}`))return false;
   if(candidate.room&&roomBusy.has(`${candidate.room}:${slotKey}`))return false;
  }
  return true;
 }
 function mark(task,candidate,value){
  const dayKey=`${task.class_id}:${task.subject_id}:${candidate.day}`;
  const dailyKey=`${task.teacher_id}:${candidate.day}`;
  for(const period of candidate.periods){
   const slotKey=`${candidate.day}:${period}`;
   const method=value?'add':'delete';
   classBusy[method](`${task.class_id}:${slotKey}`);
   teacherBusy[method](`${task.teacher_id}:${slotKey}`);
   if(candidate.room)roomBusy[method](`${candidate.room}:${slotKey}`);
  }
  teacherDailyPeriods.set(dailyKey,(teacherDailyPeriods.get(dailyKey)||0)+(value?candidate.periods.length:-candidate.periods.length));
  teacherWeeklyPeriods.set(task.teacher_id,(teacherWeeklyPeriods.get(task.teacher_id)||0)+(value?candidate.periods.length:-candidate.periods.length));
  subjectDaily.set(dayKey,(subjectDaily.get(dayKey)||0)+(value?1:-1));
 }
 function candidateScore(task,candidate){
  let score=candidate.period;
  if(task.preferred_day)score+=candidate.day===Number(task.preferred_day)?-100:80;
  if(task.preferred_period)score+=candidate.period===Number(task.preferred_period)?-60:20;
  score+=(subjectDaily.get(`${task.class_id}:${task.subject_id}:${candidate.day}`)||0)*35;
  const sameDay=placed.filter(x=>x.class_id===task.class_id&&x.day===candidate.day);
  if(sameDay.some(x=>x.subject_id===task.subject_id))score+=50;
  return score;
 }
 function place(index){
  if(index>bestPlaced.length)bestPlaced=placed.slice();
  if(index===tasks.length)return true;
  if(++attempts>MAX_ATTEMPTS){stopped=true;return false;}
  const task=tasks[index];
  const candidates=(task.lockedCandidate?[task.lockedCandidate]:task.candidates.slice()).sort((a,b)=>candidateScore(task,a)-candidateScore(task,b)||a.day-b.day||a.period-b.period);
  for(const timeCandidate of candidates){
   for(const room of task.lockedCandidate?[task.lockedRoom]:task.room_options){
    const candidate={...timeCandidate,room};
    if(!canPlace(task,candidate))continue;
    mark(task,candidate,true);
    placed.push({...candidate,class_id:task.class_id,subject_id:task.subject_id,teacher_id:task.teacher_id,room:candidate.room||'',periods_per_lesson:task.periods_per_lesson,sequence:task.sequence,locked:Boolean(task.lockedCandidate)});
    if(place(index+1))return true;
    placed.pop();mark(task,candidate,false);
    if(stopped)return false;
   }
  }
  return false;
 }

 const complete=place(0);
 const scheduled=(complete?placed:bestPlaced).slice().sort((a,b)=>a.day-b.day||a.period-b.period||String(a.class_id).localeCompare(String(b.class_id)));
 const workload={};
 const classWorkload={},roomUtilization={};
 for(const lesson of scheduled){
  workload[lesson.teacher_id]??={lessons:0,periods:0,by_day:{}};
  workload[lesson.teacher_id].lessons++;
  workload[lesson.teacher_id].periods+=lesson.periods_per_lesson;
  workload[lesson.teacher_id].by_day[lesson.day]=(workload[lesson.teacher_id].by_day[lesson.day]||0)+lesson.periods_per_lesson;
  classWorkload[lesson.class_id]??={lessons:0,periods:0,by_day:{}};
  classWorkload[lesson.class_id].lessons++;classWorkload[lesson.class_id].periods+=lesson.periods_per_lesson;
  classWorkload[lesson.class_id].by_day[lesson.day]=(classWorkload[lesson.class_id].by_day[lesson.day]||0)+lesson.periods_per_lesson;
  if(lesson.room){
   roomUtilization[lesson.room]??={lessons:0,periods:0,by_day:{}};
   roomUtilization[lesson.room].lessons++;roomUtilization[lesson.room].periods+=lesson.periods_per_lesson;
   roomUtilization[lesson.room].by_day[lesson.day]=(roomUtilization[lesson.room].by_day[lesson.day]||0)+lesson.periods_per_lesson;
  }
 }
 const softWarnings=[];
 const warnedPreferences=new Set();
 for(const task of tasks){
  const taskKey=`${task.class_id}:${task.subject_id}:${task.teacher_id}`;
  const matches=scheduled.filter(x=>x.class_id===task.class_id&&x.subject_id===task.subject_id&&x.teacher_id===task.teacher_id);
  if(task.preferred_day&&matches.length&&matches.some(x=>x.day!==Number(task.preferred_day))&&!warnedPreferences.has(taskKey)){
   softWarnings.push(`Preferred day ${task.preferred_day} was not used for every ${task.subject_id} lesson in ${task.class_id}.`);
   warnedPreferences.add(taskKey);
  }
  if(task.preferred_period&&matches.length&&matches.some(x=>x.period!==Number(task.preferred_period))&&!warnedPreferences.has(`${taskKey}:period`)){
   softWarnings.push(`Preferred period ${task.preferred_period} was not used for every ${task.subject_id} lesson in ${task.class_id}.`);
   warnedPreferences.add(`${taskKey}:period`);
  }
 }
 const scheduledSlots=new Set(),hardConflicts=[];
 for(const lesson of scheduled)for(const period of lesson.periods){
  const slot=`${lesson.day}:${period}`;
  for(const [type,key] of [['class',`${lesson.class_id}:${slot}`],['teacher',`${lesson.teacher_id}:${slot}`],...(lesson.room? [['room',`${lesson.room}:${slot}`]]:[])]){
   if(scheduledSlots.has(`${type}:${key}`))hardConflicts.push({type,lesson_id:`${lesson.class_id}:${lesson.subject_id}:${lesson.day}:${period}`});
   else scheduledSlots.add(`${type}:${key}`);
  }
 }
 const preferenceTargets=tasks.filter(task=>task.preferred_day||task.preferred_period);
 const preferenceChecks=preferenceTargets.reduce((sum,task)=>sum+Number(Boolean(task.preferred_day))+Number(Boolean(task.preferred_period)),0);
 const preferenceMet=preferenceTargets.reduce((sum,task)=>{
  const lesson=scheduled.find(x=>x.class_id===task.class_id&&x.subject_id===task.subject_id&&x.teacher_id===task.teacher_id&&x.sequence===task.sequence);
  return sum+Number(Boolean(task.preferred_day&&lesson?.day===Number(task.preferred_day)))+Number(Boolean(task.preferred_period&&lesson?.period===Number(task.preferred_period)));
 },0);
 const placedKeys=new Set(scheduled.map(x=>`${x.class_id}:${x.subject_id}:${x.teacher_id}:${x.sequence}`));
 const unscheduled=tasks.filter(task=>!placedKeys.has(`${task.class_id}:${task.subject_id}:${task.teacher_id}:${task.sequence}`)).map(task=>({class_id:task.class_id,subject_id:task.subject_id,teacher_id:task.teacher_id,lesson_number:task.sequence+1,reason:task.candidates.length?'No placement remains without violating a class, teacher, room or availability constraint.':'No valid period block exists for this lesson.'}));
 return {
  complete,scheduled,required:tasks.length,placed:scheduled.length,total_required_lessons:tasks.length,
  successfully_placed_lessons:scheduled.length,unscheduled_lessons:unscheduled.length,
  attempts,search_limit:MAX_ATTEMPTS,stopped,unscheduled,workload,teacher_workload:workload,
  class_workload:classWorkload,room_utilization:roomUtilization,
  hard_constraints:{valid:hardConflicts.length===0,conflicts:hardConflicts},
  soft_preference_score:preferenceChecks?Math.round(preferenceMet/preferenceChecks*100):null,
  soft_warnings:softWarnings,reason:complete?null:'No complete conflict-free timetable found; review the unplaced lessons and constraints.'
 };
}

module.exports={generate};
