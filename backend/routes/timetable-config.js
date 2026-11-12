'use strict';
const express=require('express');
const db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {assertBelongs}=require('../services/tenant');
const router=express.Router();
router.use(authenticate);
const admin=roles('PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER');
const reader=roles('PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER');
const parseJson=(value)=>{
  if(value===undefined||value===null||value==='')return null;
  if(typeof value==='string'){
    try{return JSON.parse(value);}catch{return value;}
  }
  return value;
};
router.get('/:schoolId/config',schoolBoundary,reader,async(req,res)=>{
  try{
    const q=await db.query(`SELECT * FROM timetable_configurations WHERE school_id=$1 ORDER BY is_active DESC, created_at DESC`,[req.params.schoolId]);
    res.json(q.rows);
  }catch(e){res.status(400).json({error:e.message});}
});
router.post('/:schoolId/config',schoolBoundary,admin,async(req,res)=>{
  try{
    const sid=req.params.schoolId;
    const b=req.body||{};
    if(!b.name)throw Error('Timetable configuration name is required');
    const teachingDays=Array.isArray(b.teaching_days)?b.teaching_days:((Array.isArray(parseJson(b.teaching_days))?parseJson(b.teaching_days):[1,2,3,4,5]));
    const periodsPerDay=Number(b.periods_per_day||b.lessons_per_day||8);
    if(!Number.isInteger(periodsPerDay)||periodsPerDay<1||periodsPerDay>12)throw Error('Periods per day must be between 1 and 12');
    if(teachingDays.some(day=>!Number.isInteger(Number(day))||Number(day)<1||Number(day)>7)||new Set(teachingDays.map(Number)).size!==teachingDays.length)throw Error('Teaching days must be unique days from 1 to 7');
    if(b.effective_start_date&&b.effective_end_date&&b.effective_start_date>b.effective_end_date)throw Error('Effective start date must be before the end date');
    const periodStarts=parseJson(b.period_start_times)||[],periodEnds=parseJson(b.period_end_times)||[];
    if(!Array.isArray(periodStarts)||!Array.isArray(periodEnds))throw Error('Period start and end times must be comma-separated time lists');
    if((periodStarts.length&&periodStarts.length!==periodsPerDay)||(periodEnds.length&&periodEnds.length!==periodsPerDay))throw Error('Provide exactly one start and end time for each period');
    const toMinutes=value=>{const match=String(value).match(/^([01]\d|2[0-3]):([0-5]\d)$/);return match?Number(match[1])*60+Number(match[2]):NaN;};
    let previousEnd=-1;
    for(let i=0;i<Math.max(periodStarts.length,periodEnds.length);i++){
      const start=toMinutes(periodStarts[i]),end=toMinutes(periodEnds[i]);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||start<previousEnd)throw Error(`Invalid or overlapping bell times at period ${i+1}`);
      previousEnd=end;
    }
    if(b.academic_year_id)await assertBelongs('academic_years',b.academic_year_id,sid);
    if(b.term_id){
      await assertBelongs('terms',b.term_id,sid);
      if(b.academic_year_id){
        const term=await db.query('SELECT id FROM terms WHERE id=$1 AND school_id=$2 AND academic_year_id=$3',[b.term_id,sid,b.academic_year_id]);
        if(!term.rowCount)throw Error('Selected term does not belong to the selected academic year');
      }
    }
    const q=await db.query(`INSERT INTO timetable_configurations(school_id,academic_year_id,term_id,name,description,effective_start_date,effective_end_date,teaching_days,periods_per_day,period_start_times,period_end_times,break_periods,lunch_periods,is_active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14)
      RETURNING *`,[
      sid,
      b.academic_year_id||null,
      b.term_id||null,
      b.name,
      b.description||'',
      b.effective_start_date||null,
      b.effective_end_date||null,
      JSON.stringify(teachingDays),
      periodsPerDay,
      JSON.stringify(periodStarts),
      JSON.stringify(periodEnds),
      JSON.stringify(parseJson(b.break_periods)||[]),
      JSON.stringify(parseJson(b.lunch_periods)||[]),
      b.is_active!==false
    ]);
    res.status(201).json(q.rows[0]);
  }catch(e){res.status(400).json({error:e.message});}
});
router.get('/:schoolId/requirements',schoolBoundary,reader,async(req,res)=>{
  try{
    const q=await db.query(`SELECT tr.*,c.name class_name,c.stream,s.name subject_name,te.first_name teacher_first_name,te.last_name teacher_last_name,
        (SELECT count(*) FROM learners l WHERE l.class_id=c.id AND l.is_active=true)::int class_size
      FROM timetable_requirements tr
      JOIN classes c ON c.id=tr.class_id
      JOIN subjects s ON s.id=tr.subject_id
      LEFT JOIN teachers te ON te.id=tr.teacher_id
      WHERE tr.school_id=$1
        AND ($2::uuid IS NULL OR tr.academic_year_id=$2)
        AND ($3::uuid IS NULL OR tr.term_id=$3)
      ORDER BY c.name,c.stream,s.name`,[req.params.schoolId,req.query.academic_year_id||null,req.query.term_id||null]);
    res.json(q.rows);
  }catch(e){res.status(400).json({error:e.message});}
});
router.post('/:schoolId/requirements',schoolBoundary,admin,async(req,res)=>{
  const sid=req.params.schoolId,b=req.body||{},client=await db.pool.connect();
  try{
    if(!b.class_id||!b.subject_id||!b.teacher_id)throw Error('Class, subject and teacher are required');
    if(!Number.isInteger(Number(b.lessons_per_week))||Number(b.lessons_per_week)<1||Number(b.lessons_per_week)>30)throw Error('Lessons per week must be between 1 and 30');
    const periods=Number(b.periods_per_lesson||1),daily= b.max_per_day===undefined||b.max_per_day===''?null:Number(b.max_per_day);
    if(!Number.isInteger(periods)||periods<1||periods>3)throw Error('Lesson length must be 1–3 consecutive periods');
    if(daily!==null&&(!Number.isInteger(daily)||daily<1||daily>12))throw Error('Maximum lessons per day must be 1–12');
    const preferredDay=b.preferred_day?Number(b.preferred_day):null,preferredPeriod=b.preferred_period?Number(b.preferred_period):null;
    if(preferredDay!==null&&(!Number.isInteger(preferredDay)||preferredDay<1||preferredDay>7))throw Error('Preferred day must be from 1 to 7');
    if(preferredPeriod!==null&&(!Number.isInteger(preferredPeriod)||preferredPeriod<1||preferredPeriod>12))throw Error('Preferred period must be from 1 to 12');
    await assertBelongs('classes',b.class_id,sid);
    await assertBelongs('subjects',b.subject_id,sid);
    await assertBelongs('teachers',b.teacher_id,sid);
    if(b.academic_year_id)await assertBelongs('academic_years',b.academic_year_id,sid);
    if(b.term_id){
      await assertBelongs('terms',b.term_id,sid);
      if(b.academic_year_id){
        const term=await db.query('SELECT id FROM terms WHERE id=$1 AND school_id=$2 AND academic_year_id=$3',[b.term_id,sid,b.academic_year_id]);
        if(!term.rowCount)throw Error('Selected term does not belong to the selected academic year');
      }
    }
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${sid}:timetable-requirement:${b.class_id}:${b.subject_id}:${b.academic_year_id||''}:${b.term_id||''}`]);
    const existing=await client.query(`SELECT id FROM timetable_requirements
      WHERE school_id=$1 AND class_id=$2 AND subject_id=$3
        AND academic_year_id IS NOT DISTINCT FROM $4::uuid AND term_id IS NOT DISTINCT FROM $5::uuid
      ORDER BY created_at DESC LIMIT 1`,[sid,b.class_id,b.subject_id,b.academic_year_id||null,b.term_id||null]);
    const values=[sid,b.academic_year_id||null,b.term_id||null,b.class_id,b.subject_id,b.teacher_id,Number(b.lessons_per_week),preferredDay,preferredPeriod,b.room_requirement||'',b.notes||'',periods,daily,b.hard_preference===true];
    let q;
    if(existing.rows[0]){
      q=await client.query(`UPDATE timetable_requirements SET teacher_id=$6,lessons_per_week=$7,preferred_day=$8,preferred_period=$9,room_requirement=$10,notes=$11,periods_per_lesson=$12,max_per_day=$13,hard_preference=$14,updated_at=now() WHERE id=$15 RETURNING *`,[...values,existing.rows[0].id]);
    }else{
      q=await client.query(`INSERT INTO timetable_requirements(school_id,academic_year_id,term_id,class_id,subject_id,teacher_id,lessons_per_week,preferred_day,preferred_period,room_requirement,notes,periods_per_lesson,max_per_day,hard_preference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,values);
    }
    await client.query('COMMIT');
    res.status(existing.rows[0]?200:201).json(q.rows[0]);
  }catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(e.status||400).json({error:e.message});}
  finally{client.release();}
});
router.delete('/:schoolId/requirements/:requirementId',schoolBoundary,admin,async(req,res)=>{
  try{
    const q=await db.query('DELETE FROM timetable_requirements WHERE id=$1 AND school_id=$2 RETURNING id',[req.params.requirementId,req.params.schoolId]);
    if(!q.rowCount)return res.status(404).json({error:'Timetable requirement not found'});
    res.json({ok:true,id:q.rows[0].id});
  }catch(e){res.status(400).json({error:e.message});}
});
router.get('/:schoolId/unavailability',schoolBoundary,reader,async(req,res)=>{
  try{
    const q=await db.query(`SELECT u.*,t.first_name teacher_first_name,t.last_name teacher_last_name,r.room_name
      FROM timetable_unavailability u
      LEFT JOIN teachers t ON t.id=u.teacher_id
      LEFT JOIN timetable_rooms r ON r.id=u.room_id
      WHERE u.school_id=$1 AND u.is_active=true
        AND ($2::uuid IS NULL OR u.academic_year_id=$2)
        AND ($3::uuid IS NULL OR u.term_id=$3)
      ORDER BY u.day_of_week,u.period,t.last_name,r.room_name`,
      [req.params.schoolId,req.query.academic_year_id||null,req.query.term_id||null]);
    res.json(q.rows);
  }catch(e){res.status(400).json({error:e.message});}
});
router.post('/:schoolId/unavailability',schoolBoundary,admin,async(req,res)=>{
  try{
    const sid=req.params.schoolId,b=req.body||{};
    const teacherId=b.teacher_id||null,roomId=b.room_id||null;
    if(Boolean(teacherId)===Boolean(roomId))throw Error('Select exactly one teacher or room to block');
    const day=Number(b.day_of_week),period=Number(b.period);
    if(!Number.isInteger(day)||day<1||day>7||!Number.isInteger(period)||period<1||period>12)throw Error('Select a valid timetable day and period');
    if(teacherId)await assertBelongs('teachers',teacherId,sid);
    if(roomId){
      const room=await db.query('SELECT id FROM timetable_rooms WHERE id=$1 AND school_id=$2 AND is_active=true',[roomId,sid]);
      if(!room.rowCount)throw Error('Room does not belong to this school or is inactive');
    }
    if(b.academic_year_id)await assertBelongs('academic_years',b.academic_year_id,sid);
    if(b.term_id){
      await assertBelongs('terms',b.term_id,sid);
      if(b.academic_year_id){
        const term=await db.query('SELECT id FROM terms WHERE id=$1 AND school_id=$2 AND academic_year_id=$3',[b.term_id,sid,b.academic_year_id]);
        if(!term.rowCount)throw Error('Selected term does not belong to the selected academic year');
      }
    }
    const existing=await db.query(`SELECT id FROM timetable_unavailability WHERE school_id=$1
      AND academic_year_id IS NOT DISTINCT FROM $2::uuid AND term_id IS NOT DISTINCT FROM $3::uuid
      AND teacher_id IS NOT DISTINCT FROM $4::uuid AND room_id IS NOT DISTINCT FROM $5::uuid
      AND day_of_week=$6 AND period=$7 AND is_active=true LIMIT 1`,
      [sid,b.academic_year_id||null,b.term_id||null,teacherId,roomId,day,period]);
    if(existing.rowCount)return res.status(409).json({error:'That unavailable period is already recorded'});
    const q=await db.query(`INSERT INTO timetable_unavailability(school_id,academic_year_id,term_id,teacher_id,room_id,day_of_week,period,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [sid,b.academic_year_id||null,b.term_id||null,teacherId,roomId,day,period,String(b.reason||'')]);
    res.status(201).json(q.rows[0]);
  }catch(e){res.status(e.status||400).json({error:e.message});}
});
router.delete('/:schoolId/unavailability/:unavailabilityId',schoolBoundary,admin,async(req,res)=>{
  try{
    const q=await db.query(`DELETE FROM timetable_unavailability WHERE id=$1 AND school_id=$2 RETURNING id`,
      [req.params.unavailabilityId,req.params.schoolId]);
    if(!q.rowCount)return res.status(404).json({error:'Unavailable period not found'});
    res.json({ok:true,id:q.rows[0].id});
  }catch(e){res.status(400).json({error:e.message});}
});
module.exports=router;
