const express=require('express');
const db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {assertBelongs}=require('../services/tenant');
const router=express.Router();router.use(authenticate);
const ADMIN=['PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'];

router.get('/:schoolId/overview',schoolBoundary,async(req,res)=>{
  try{
    const sid=req.params.schoolId,y=req.query.academic_year_id||null,t=req.query.term_id||null;
    const [attendance,discipline,inventory,timetable,audit,parents,comms,assess,marks,learners,teachers]=await Promise.all([
      db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE status='PRESENT')::int present,count(*) FILTER(WHERE status='ABSENT')::int absent,count(*) FILTER(WHERE status='LATE')::int late FROM attendance_records WHERE school_id=$1 AND ($2::uuid IS NULL OR academic_year_id=$2) AND ($3::uuid IS NULL OR term_id=$3)`,[sid,y,t]),
      db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE status='OPEN')::int open,count(*) FILTER(WHERE severity IN ('HIGH','CRITICAL'))::int serious FROM discipline_cases WHERE school_id=$1`,[sid]),
      db.query(`SELECT count(*)::int items,COALESCE(sum(quantity),0)::numeric quantity,COALESCE(sum(quantity*unit_cost),0)::numeric value FROM inventory_items WHERE school_id=$1 AND is_active`,[sid]),
      db.query(`SELECT count(*)::int entries FROM timetable_entries WHERE school_id=$1 AND ($2::uuid IS NULL OR academic_year_id=$2) AND ($3::uuid IS NULL OR term_id=$3)`,[sid,y,t]),
      db.query(`SELECT count(*)::int events FROM audit_log WHERE school_id=$1 AND created_at>=now()-interval '30 days'`,[sid]),
      db.query(`SELECT count(*)::int guardians,count(*) FILTER(WHERE sms_enabled AND communication_consent)::int sms_ready FROM parent_guardians WHERE school_id=$1 AND is_active`,[sid]),
      db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE status='SENT')::int sent,count(*) FILTER(WHERE status='FAILED')::int failed FROM communication_messages WHERE school_id=$1`,[sid]),
      db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE status='OPEN')::int open FROM assessments WHERE school_id=$1 AND ($2::uuid IS NULL OR academic_year_id=$2) AND ($3::uuid IS NULL OR term_id=$3)`,[sid,y,t]),
      db.query(`SELECT count(*)::int entries FROM marks WHERE school_id=$1 AND ($2::uuid IS NULL OR academic_year_id=$2) AND ($3::uuid IS NULL OR term_id=$3) AND mark IS NOT NULL`,[sid,y,t]),
      db.query(`SELECT count(*)::int n FROM learners WHERE school_id=$1 AND is_active`,[sid]),
      db.query(`SELECT count(*)::int n FROM teachers WHERE school_id=$1 AND is_active`,[sid])
    ]);
    res.json({attendance:attendance.rows[0],discipline:discipline.rows[0],inventory:inventory.rows[0],timetable:timetable.rows[0],audit:audit.rows[0],parents:parents.rows[0],communications:comms.rows[0],assessments:assess.rows[0],marks:marks.rows[0],learners:learners.rows[0].n,teachers:teachers.rows[0].n});
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

router.get('/:schoolId/mark-progress',schoolBoundary,roles(...ADMIN,'HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
  try{
    const sid=req.params.schoolId,{academic_year_id:y,term_id:t,assessment_id:a,class_id:c}=req.query;
    if(['CLASS_TEACHER','TEACHER'].includes(req.user.role)){
      if(!c)return res.status(400).json({error:'Class Teacher monitoring requires a class.'});
      const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments cta JOIN teachers t ON t.id=cta.teacher_id WHERE cta.school_id=$1 AND cta.class_id=$2 AND cta.academic_year_id=$3 AND t.user_id=$4 AND COALESCE(t.is_active,true)=true LIMIT 1`,[sid,c,y,req.user.user_id])).rows[0];
      if(!ok)return res.status(403).json({error:'You can only monitor marks for your assigned class.'});
    }
    if(y)await assertBelongs('academic_years',y,sid); if(t)await assertBelongs('terms',t,sid); if(c)await assertBelongs('classes',c,sid); if(a)await assertBelongs('assessments',a,sid);
    const rows=(await db.query(`
      WITH roster AS (
        SELECT e.class_id,e.learner_id FROM learner_enrollments e
        WHERE e.school_id=$1 AND e.academic_year_id=$2 AND COALESCE(e.status,'ACTIVE')='ACTIVE'
          AND ($3::uuid IS NULL OR e.class_id=$3)
      ), scope AS (
        SELECT a.id assessment_id,a.class_id,a.subject_id,a.name assessment_name,a.assessment_type,a.max_mark,s.code subject_code,s.name subject_name,
               COALESCE(NULLIF(trim(coalesce(th.first_name,'') || ' ' || coalesce(th.last_name,'')),''),'Not assigned') teacher_name
        FROM assessments a LEFT JOIN subjects s ON s.id=a.subject_id
        LEFT JOIN LATERAL (
          SELECT t.first_name,t.last_name
          FROM teacher_subject_assignments tsa JOIN teachers t ON t.id=tsa.teacher_id
          WHERE tsa.school_id=a.school_id AND tsa.class_id=a.class_id AND tsa.subject_id=a.subject_id AND tsa.academic_year_id=a.academic_year_id
            AND (tsa.term_id=a.term_id OR tsa.term_id IS NULL) AND COALESCE(tsa.is_active,true)=true
          ORDER BY (tsa.term_id IS NOT NULL) DESC,tsa.created_at DESC,tsa.id DESC LIMIT 1
        ) th ON true
        WHERE a.school_id=$1 AND a.academic_year_id=$2 AND a.term_id=$4
          AND ($5::uuid IS NULL OR a.id=$5)
      ), expected AS (
        SELECT sc.class_id,sc.assessment_id,sc.subject_id,sc.assessment_name,sc.assessment_type,sc.max_mark,sc.subject_code,sc.subject_name,sc.teacher_name,
               count(r.learner_id)::int expected,
               count(m.id) FILTER(WHERE m.mark IS NOT NULL)::int entered
        FROM scope sc JOIN roster r ON r.class_id=sc.class_id
        LEFT JOIN marks m ON m.school_id=$1 AND m.learner_id=r.learner_id AND m.class_id=r.class_id AND m.assessment_id=sc.assessment_id AND m.subject_id=sc.subject_id
        GROUP BY sc.class_id,sc.assessment_id,sc.subject_id,sc.assessment_name,sc.assessment_type,sc.max_mark,sc.subject_code,sc.subject_name,sc.teacher_name
      )
      SELECT e.*,c.name class_name,c.stream FROM expected e JOIN classes c ON c.id=e.class_id ORDER BY c.name,c.stream,e.subject_name,e.assessment_name`,[sid,y,c||null,t,a||null])).rows;
    res.json(rows.map(x=>({...x,missing:Math.max(0,x.expected-x.entered),percent:x.expected?Math.round(x.entered/x.expected*100):0,status:x.entered===0?'NOT STARTED':x.entered>=x.expected?'COMPLETE':'IN PROGRESS'})));
  }catch(e){res.status(e.status||400).json({error:e.message});}
});

router.get('/:schoolId/attendance',schoolBoundary,roles(...ADMIN,'CLASS_TEACHER','TEACHER'),async(req,res)=>{try{const {date,academic_year_id:y,term_id:t,class_id:c}=req.query;let classId=c||null;if(req.user.role==='CLASS_TEACHER'){if(!classId)return res.status(400).json({error:'Select your assigned class.'});const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND t.user_id=$4 LIMIT 1`,[req.params.schoolId,classId,y,req.user.user_id])).rows[0];if(!ok)return res.status(403).json({error:'You can only view attendance for your assigned class.'});}const q=await db.query(`SELECT ar.*,l.admission_no,l.first_name,l.middle_name,l.last_name,c.name class_name,c.stream FROM attendance_records ar JOIN learners l ON l.id=ar.learner_id JOIN classes c ON c.id=ar.class_id WHERE ar.school_id=$1 AND ($2::date IS NULL OR ar.attendance_date=$2) AND ($3::uuid IS NULL OR ar.academic_year_id=$3) AND ($4::uuid IS NULL OR ar.term_id=$4) AND ($5::uuid IS NULL OR ar.class_id=$5) ORDER BY c.name,l.last_name,l.first_name`,[req.params.schoolId,date||null,y||null,t||null,classId]);res.json(q.rows);}catch(e){res.status(400).json({error:e.message})}});
router.post('/:schoolId/attendance/bulk',schoolBoundary,roles(...ADMIN,'CLASS_TEACHER','TEACHER'),async(req,res)=>{const b=req.body||{},sid=req.params.schoolId;try{if(!b.attendance_date||!b.class_id||!b.academic_year_id||!Array.isArray(b.rows))throw Error('Date, class, academic year and attendance rows are required');await assertBelongs('classes',b.class_id,sid);await assertBelongs('academic_years',b.academic_year_id,sid);if(b.term_id)await assertBelongs('terms',b.term_id,sid);if(!/^\d{4}-\d{2}-\d{2}$/.test(b.attendance_date))return res.status(400).json({error:'Attendance date must be YYYY-MM-DD'});if(!b.rows.length)return res.status(400).json({error:'At least one learner is required'});if(b.rows.length>1000)return res.status(400).json({error:'Attendance batch exceeds 1000 learners'});const ids=b.rows.map(r=>r.learner_id);if(ids.some(id=>!id)||new Set(ids).size!==ids.length)return res.status(400).json({error:'Missing or duplicate learner in attendance batch'});if(b.rows.some(r=>!['PRESENT','ABSENT','LATE','EXCUSED'].includes(String(r.status||'PRESENT').toUpperCase())))return res.status(400).json({error:'Invalid attendance status'});const roster=await db.query(`SELECT DISTINCT learner_id FROM learner_enrollments WHERE school_id=$1 AND class_id=$2 AND academic_year_id=$3 AND COALESCE(status,'ACTIVE')='ACTIVE' AND learner_id=ANY($4::uuid[])`,[sid,b.class_id,b.academic_year_id,ids]);if(roster.rows.length!==ids.length)return res.status(403).json({error:'Some learners are not enrolled in this school, class and academic year'});if(req.user.role==='CLASS_TEACHER'){const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND t.user_id=$4 LIMIT 1`,[sid,b.class_id,b.academic_year_id,req.user.user_id])).rows[0];if(!ok)throw Object.assign(new Error('You can only record attendance for your assigned class.'),{status:403});}const c=await db.pool.connect();try{await c.query('BEGIN');for(const r of b.rows){if(!r.learner_id)continue;await c.query(`INSERT INTO attendance_records(school_id,learner_id,class_id,academic_year_id,term_id,attendance_date,status,reason,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(school_id,learner_id,attendance_date) DO UPDATE SET class_id=EXCLUDED.class_id,academic_year_id=EXCLUDED.academic_year_id,term_id=EXCLUDED.term_id,status=EXCLUDED.status,reason=EXCLUDED.reason,recorded_by=EXCLUDED.recorded_by,updated_at=now()`,[sid,r.learner_id,b.class_id,b.academic_year_id,b.term_id||null,b.attendance_date,String(r.status||'PRESENT').toUpperCase(),r.reason||null,req.user.user_id]);}await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}res.status(201).json({saved:b.rows.length});}catch(e){res.status(e.status||400).json({error:e.message})}});

router.get('/:schoolId/discipline',schoolBoundary,roles(...ADMIN,'CLASS_TEACHER','TEACHER'),async(req,res)=>{try{const q=await db.query(`SELECT d.*,l.admission_no,l.first_name,l.last_name,c.name class_name,c.stream FROM discipline_cases d JOIN learners l ON l.id=d.learner_id LEFT JOIN classes c ON c.id=d.class_id WHERE d.school_id=$1 ORDER BY d.case_date DESC,d.created_at DESC`,[req.params.schoolId]);res.json(q.rows)}catch(e){res.status(400).json({error:e.message})}});
router.post('/:schoolId/discipline',schoolBoundary,roles(...ADMIN,'CLASS_TEACHER','TEACHER'),async(req,res)=>{try{const b=req.body||{};if(!b.learner_id||!b.title)return res.status(400).json({error:'Learner and incident title are required'});const q=await db.query(`INSERT INTO discipline_cases(school_id,learner_id,class_id,case_date,title,category,severity,description,action_taken,status,reported_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[req.params.schoolId,b.learner_id,b.class_id||null,b.case_date||new Date().toISOString().slice(0,10),b.title,b.category||'GENERAL',b.severity||'LOW',b.description||'',b.action_taken||'',b.status||'OPEN',req.user.user_id]);res.status(201).json(q.rows[0])}catch(e){res.status(400).json({error:e.message})}});

router.get('/:schoolId/inventory',schoolBoundary,roles(...ADMIN),async(req,res)=>{try{res.json((await db.query(`SELECT * FROM inventory_items WHERE school_id=$1 ORDER BY category,name`,[req.params.schoolId])).rows)}catch(e){res.status(400).json({error:e.message})}});
router.post('/:schoolId/inventory',schoolBoundary,roles(...ADMIN),async(req,res)=>{try{const b=req.body||{};if(!b.name)return res.status(400).json({error:'Item name is required'});const q=await db.query(`INSERT INTO inventory_items(school_id,asset_code,name,category,unit,quantity,unit_cost,location,condition_status,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[req.params.schoolId,b.asset_code||null,b.name,b.category||'GENERAL',b.unit||'unit',Number(b.quantity||0),Number(b.unit_cost||0),b.location||'',b.condition_status||'GOOD',b.notes||'',req.user.user_id]);res.status(201).json(q.rows[0])}catch(e){res.status(400).json({error:e.message})}});

router.get('/:schoolId/timetable/workspace',schoolBoundary,roles(...ADMIN,'HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'),async(req,res)=>{
  try{
    const sid=req.params.schoolId;
    const [classes,subjects,teachers,rooms,entries]=await Promise.all([
      db.query(`SELECT c.id,c.name,c.stream,lv.name level_name
        FROM classes c
        JOIN school_levels lv ON lv.id=c.school_level_id
        WHERE c.school_id=$1 AND c.is_active=true
        ORDER BY lv.sort_order,c.name,c.stream`,[sid]),
      db.query(`SELECT id,code,name FROM subjects
        WHERE school_id=$1 AND is_active=true
        ORDER BY name`,[sid]),
      db.query(`SELECT id,staff_no,first_name,last_name FROM teachers
        WHERE school_id=$1 AND COALESCE(is_active,true)=true
        ORDER BY last_name,first_name`,[sid]),
      db.query(`SELECT id,room_name,room_code,room_type,capacity,features FROM timetable_rooms
        WHERE school_id=$1 AND is_active=true
        ORDER BY room_type,room_name`,[sid]),
      db.query(`SELECT te.*,c.name class_name,c.stream,s.name subject_name,s.code subject_code,
          t.first_name teacher_first_name,t.last_name teacher_last_name
        FROM timetable_entries te
        JOIN classes c ON c.id=te.class_id
        JOIN subjects s ON s.id=te.subject_id
        LEFT JOIN teachers t ON t.id=te.teacher_id
        WHERE te.school_id=$1
          AND ($2::uuid IS NULL OR te.academic_year_id=$2)
          AND ($3::uuid IS NULL OR te.term_id=$3)
        ORDER BY te.day_of_week,te.start_time,c.name,c.stream`,[sid,req.query.academic_year_id||null,req.query.term_id||null])
    ]);
    res.json({
      classes:classes.rows,
      subjects:subjects.rows,
      teachers:teachers.rows,
      rooms:rooms.rows,
      entries:entries.rows
    });
  }catch(e){res.status(e.status||500).json({error:e.message});}
});
router.post('/:schoolId/timetable/rooms',schoolBoundary,roles('PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'),async(req,res)=>{
  try{
    const b=req.body||{},name=String(b.room_name||'').trim();
    if(!name)return res.status(400).json({error:'Room name is required'});
    const capacity=b.capacity===''||b.capacity===undefined||b.capacity===null?null:Number(b.capacity);
    if(capacity!==null&&(!Number.isInteger(capacity)||capacity<1))return res.status(400).json({error:'Room capacity must be a positive whole number'});
    const features=Array.isArray(b.features)?b.features:String(b.features||'').split(',').map(x=>x.trim()).filter(Boolean);
    const q=await db.query(`INSERT INTO timetable_rooms(school_id,room_name,room_code,room_type,capacity,features)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [req.params.schoolId,name,String(b.room_code||'').trim()||null,String(b.room_type||'CLASSROOM').trim().toUpperCase(),capacity,JSON.stringify(features)]);
    res.status(201).json(q.rows[0]);
  }catch(e){res.status(e.code==='23505'?409:400).json({error:e.code==='23505'?'A room with that name already exists.':e.message});}
});
router.patch('/:schoolId/timetable/:entryId/lock',schoolBoundary,roles('PLATFORM_OWNER','SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'),async(req,res)=>{
  try{
    const locked=req.body?.is_locked===true;
    const q=await db.query(`UPDATE timetable_entries SET is_locked=$3,updated_at=now()
      WHERE id=$1 AND school_id=$2 RETURNING *`,
      [req.params.entryId,req.params.schoolId,locked]);
    if(!q.rowCount)return res.status(404).json({error:'Timetable entry not found'});
    res.json(q.rows[0]);
  }catch(e){res.status(400).json({error:e.message});}
});
router.get('/:schoolId/timetable',schoolBoundary,roles(...ADMIN,'HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'),async(req,res)=>{try{res.json((await db.query(`SELECT te.*,c.name class_name,c.stream,s.name subject_name,s.code subject_code,t.first_name teacher_first_name,t.last_name teacher_last_name FROM timetable_entries te JOIN classes c ON c.id=te.class_id JOIN subjects s ON s.id=te.subject_id LEFT JOIN teachers t ON t.id=te.teacher_id WHERE te.school_id=$1 ORDER BY te.day_of_week,te.start_time,c.name`,[req.params.schoolId])).rows)}catch(e){res.status(400).json({error:e.message})}});
router.post('/:schoolId/timetable',schoolBoundary,roles(...ADMIN),async(req,res)=>{try{const b=req.body||{};if(!b.class_id||!b.subject_id||!b.day_of_week||!b.start_time||!b.end_time)return res.status(400).json({error:'Class, subject, day and time are required'});const sid=req.params.schoolId;await assertBelongs('classes',b.class_id,sid);await assertBelongs('subjects',b.subject_id,sid);if(b.teacher_id)await assertBelongs('teachers',b.teacher_id,sid);if(b.academic_year_id)await assertBelongs('academic_years',b.academic_year_id,sid);if(b.term_id)await assertBelongs('terms',b.term_id,sid);if(Number(b.day_of_week)<1||Number(b.day_of_week)>7||b.start_time>=b.end_time)return res.status(400).json({error:'Invalid timetable day or time interval'});const clash=await db.query(`SELECT id FROM timetable_entries WHERE school_id=$1 AND day_of_week=$2 AND start_time<$4::time AND end_time>$3::time AND academic_year_id IS NOT DISTINCT FROM $5::uuid AND term_id IS NOT DISTINCT FROM $6::uuid AND (class_id=$7 OR ($8::uuid IS NOT NULL AND teacher_id=$8) OR ($9::text<>'' AND room=$9)) LIMIT 1`,[sid,b.day_of_week,b.start_time,b.end_time,b.academic_year_id||null,b.term_id||null,b.class_id,b.teacher_id||null,b.room||'']);if(clash.rows.length)return res.status(409).json({error:'Timetable conflict: class, teacher or room already scheduled in this period'});const q=await db.query(`INSERT INTO timetable_entries(school_id,academic_year_id,term_id,class_id,subject_id,teacher_id,day_of_week,start_time,end_time,room,notes,is_locked) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[req.params.schoolId,b.academic_year_id||null,b.term_id||null,b.class_id,b.subject_id,b.teacher_id||null,b.day_of_week,b.start_time,b.end_time,b.room||'',b.notes||'',b.is_locked===true]);res.status(201).json(q.rows[0])}catch(e){res.status(400).json({error:e.message})}});

router.get('/:schoolId/audit',schoolBoundary,roles(...ADMIN),async(req,res)=>{try{const q=await db.query(`SELECT a.*,u.email,u.first_name,u.last_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.school_id=$1 ORDER BY a.created_at DESC LIMIT 500`,[req.params.schoolId]);res.json(q.rows)}catch(e){res.status(400).json({error:e.message})}});
router.get('/:schoolId/export/summary',schoolBoundary,roles(...ADMIN),async(req,res)=>{try{const sid=req.params.schoolId;const [school,years,classes,subjects,teachers,learners,assignments]=await Promise.all([db.query(`SELECT s.*,si.motto,si.contact_phone,si.contact_email FROM schools s LEFT JOIN school_identity si ON si.school_id=s.id WHERE s.id=$1`,[sid]),db.query(`SELECT * FROM academic_years WHERE school_id=$1 ORDER BY year_label`,[sid]),db.query(`SELECT * FROM classes WHERE school_id=$1 ORDER BY name,stream`,[sid]),db.query(`SELECT * FROM subjects WHERE school_id=$1 ORDER BY name`,[sid]),db.query(`SELECT id,staff_no,first_name,last_name,email,is_active FROM teachers WHERE school_id=$1 ORDER BY last_name,first_name`,[sid]),db.query(`SELECT id,admission_no,assessment_no,first_name,middle_name,last_name,gender,class_id,status,is_active FROM learners WHERE school_id=$1 ORDER BY last_name,first_name`,[sid]),db.query(`SELECT * FROM teacher_subject_assignments WHERE school_id=$1`,[sid])]);res.json({exported_at:new Date().toISOString(),school:school.rows[0],academic_years:years.rows,classes:classes.rows,subjects:subjects.rows,teachers:teachers.rows,learners:learners.rows,assignments:assignments.rows});}catch(e){res.status(400).json({error:e.message})}});
module.exports=router;
