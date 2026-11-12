'use strict';
const express=require('express');const db=require('../db');const {authenticate,roles,schoolBoundary}=require('../middleware/auth');const {generate}=require('../services/timetable-generator');
const router=express.Router();router.use(authenticate);
const admin=roles('PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER');
router.post('/:schoolId/generate',schoolBoundary,admin,async(req,res)=>{
 const sid=req.params.schoolId,b=req.body||{};
 try{
  let savedRequirements=[];
  if(!Array.isArray(b.requirements)||!b.requirements.length){
   savedRequirements=(await db.query(`SELECT tr.class_id,tr.subject_id,tr.teacher_id,tr.lessons_per_week,tr.periods_per_lesson,
       tr.max_per_day,tr.preferred_day,tr.preferred_period,tr.room_requirement AS room,tr.hard_preference,
       (SELECT count(*) FROM learners l WHERE l.class_id=c.id AND l.is_active=true)::int class_size
     FROM timetable_requirements tr JOIN classes c ON c.id=tr.class_id
     WHERE tr.school_id=$1
       AND ($2::uuid IS NULL OR tr.academic_year_id=$2)
       AND ($3::uuid IS NULL OR tr.term_id=$3)
     ORDER BY tr.class_id,tr.subject_id`,[sid,b.academic_year_id||null,b.term_id||null])).rows;
  }
  const [configResult,schoolRooms,unavailableRows,lockedRows]=await Promise.all([db.query(`SELECT * FROM timetable_configurations
    WHERE school_id=$1
      AND ($2::uuid IS NULL OR academic_year_id IS NULL OR academic_year_id=$2)
      AND ($3::uuid IS NULL OR term_id IS NULL OR term_id=$3)
    ORDER BY is_active DESC,academic_year_id DESC NULLS LAST,term_id DESC NULLS LAST,created_at DESC
    LIMIT 1`,[sid,b.academic_year_id||null,b.term_id||null]),
    db.query(`SELECT room_name,room_type,capacity,features FROM timetable_rooms WHERE school_id=$1 AND is_active=true ORDER BY room_type,room_name`,[sid]),
    db.query(`SELECT u.teacher_id,u.room_id,u.day_of_week,u.period,r.room_name
      FROM timetable_unavailability u LEFT JOIN timetable_rooms r ON r.id=u.room_id
      WHERE u.school_id=$1 AND u.is_active=true
        AND ($2::uuid IS NULL OR u.academic_year_id=$2)
        AND ($3::uuid IS NULL OR u.term_id=$3)`,
      [sid,b.academic_year_id||null,b.term_id||null]),
    db.query(`SELECT class_id,subject_id,teacher_id,day_of_week,start_time,end_time,room
      FROM timetable_entries WHERE school_id=$1 AND is_locked=true
        AND academic_year_id IS NOT DISTINCT FROM $2::uuid AND term_id IS NOT DISTINCT FROM $3::uuid`,
      [sid,b.academic_year_id||null,b.term_id||null])]);
  const savedConfig=configResult.rows[0]||{};
  const unavailableTeachers=unavailableRows.rows.filter(x=>x.teacher_id).map(x=>({teacher_id:x.teacher_id,day:x.day_of_week,period:x.period}));
  const unavailableRooms=unavailableRows.rows.filter(x=>x.room_name).map(x=>({room:x.room_name,day:x.day_of_week,period:x.period}));
  const locked=lockedRows.rows.map(entry=>{
   const startTime=String(entry.start_time).slice(0,5);
   let period=(savedConfig.period_start_times||[]).findIndex(time=>String(time).slice(0,5)===startTime)+1;
   if(period===0){
    const firstStart=String(savedConfig.period_start_times?.[0]||b.start_time||b.settings?.start_time||'08:00').slice(0,5);
    const firstMinutes=Number(firstStart.slice(0,2))*60+Number(firstStart.slice(3,5));
    const timeMinutes=Number(startTime.slice(0,2))*60+Number(startTime.slice(3,5));
    const duration=Number(b.lesson_minutes||b.settings?.lesson_minutes||40);
    if(duration>0&&(timeMinutes-firstMinutes)%duration===0)period=(timeMinutes-firstMinutes)/duration+1;
   }
   return {...entry,start_time:entry.start_time,end_time:entry.end_time,period};
  });
  const payload={
   ...b,
   requirements:Array.isArray(b.requirements)&&b.requirements.length?b.requirements:(Array.isArray(b.lessons)&&b.lessons.length?b.lessons:savedRequirements),
   settings:{
    ...(b.settings||{}),
    start_time:b.start_time ?? (b.settings&&b.settings.start_time) ?? savedConfig.period_start_times?.[0] ?? '08:00',
    lesson_minutes:b.lesson_minutes ?? (b.settings&&b.settings.lesson_minutes) ?? 40,
    periods_per_day:b.periods_per_day ?? (b.settings&&b.settings.periods_per_day) ?? savedConfig.periods_per_day ?? 8,
    days:b.days ?? (b.settings&&b.settings.days) ?? savedConfig.teaching_days ?? [1,2,3,4,5],
    period_start_times:b.period_start_times ?? (b.settings&&b.settings.period_start_times) ?? savedConfig.period_start_times ?? [],
    period_end_times:b.period_end_times ?? (b.settings&&b.settings.period_end_times) ?? savedConfig.period_end_times ?? [],
    rooms:(b.settings&&b.settings.rooms)||schoolRooms.rows,
    blocked:b.blocked ?? (b.settings&&b.settings.blocked) ?? [],
    teacher_unavailable:[...unavailableTeachers,...(b.teacher_unavailable ?? (b.settings&&b.settings.teacher_unavailable) ?? [])],
    room_unavailable:[...unavailableRooms,...(b.room_unavailable ?? (b.settings&&b.settings.room_unavailable) ?? [])],
    teacher_limits:b.teacher_limits ?? (b.settings&&b.settings.teacher_limits) ?? [],
    locked
   }
  };
  if(!Array.isArray(payload.requirements)||!payload.requirements.length||payload.requirements.length>500)return res.status(400).json({error:'Save lesson requirements for the selected academic year and term before generating a timetable.'});
  const ids=(key)=>[...new Set(payload.requirements.map(r=>r[key]).filter(Boolean))];
  for(const [key,table] of [['class_id','classes'],['subject_id','subjects'],['teacher_id','teachers']]){
   const values=ids(key);const found=await db.query(`SELECT id FROM ${table} WHERE school_id=$1 AND id=ANY($2::uuid[])`,[sid,values]);if(found.rows.length!==values.length)return res.status(403).json({error:`Invalid or other-school ${key}`});
  }
  if(b.academic_year_id){const x=await db.query('SELECT id FROM academic_years WHERE school_id=$1 AND id=$2',[sid,b.academic_year_id]);if(!x.rowCount)throw Error('Academic year does not belong to school')}
  if(b.term_id){const x=await db.query('SELECT id FROM terms WHERE school_id=$1 AND id=$2',[sid,b.term_id]);if(!x.rowCount)throw Error('Term does not belong to school')}
  const result=generate(payload);if(!result.complete)return res.json(result);
  if(!b.save)return res.json({...result,preview:true});
  // School-scoped advisory transaction lock prevents two simultaneous generators racing.
  const client=await db.pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[sid+':timetable']);
   const existing=await client.query('SELECT count(*)::int n FROM timetable_entries WHERE school_id=$1 AND academic_year_id IS NOT DISTINCT FROM $2::uuid AND term_id IS NOT DISTINCT FROM $3::uuid',[sid,b.academic_year_id||null,b.term_id||null]);
   if(existing.rows[0].n&&!b.replace){await client.query('ROLLBACK');return res.status(409).json({error:'Timetable already has entries for this year/term. Enable replace to regenerate.'})}
   if(b.replace)await client.query('DELETE FROM timetable_entries WHERE school_id=$1 AND academic_year_id IS NOT DISTINCT FROM $2::uuid AND term_id IS NOT DISTINCT FROM $3::uuid AND is_locked=false',[sid,b.academic_year_id||null,b.term_id||null]);
   for(const x of result.scheduled){if(x.locked)continue;await client.query('INSERT INTO timetable_entries(school_id,academic_year_id,term_id,class_id,subject_id,teacher_id,day_of_week,start_time,end_time,room,notes,is_locked) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false)',[sid,b.academic_year_id||null,b.term_id||null,x.class_id,x.subject_id,x.teacher_id,x.day,x.start_time,x.end_time,x.room,'Generated automatically']);}
   await client.query('COMMIT');res.status(201).json({...result,saved:true});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}finally{client.release()}
 }catch(e){res.status(400).json({error:e.message})}
});module.exports=router;
