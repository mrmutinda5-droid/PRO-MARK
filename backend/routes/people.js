const express=require('express'),bcrypt=require('bcryptjs'),db=require('../db'),fs=require('fs'),path=require('path');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {assertBelongs}=require('../services/tenant');
const {source:assetSource}=require('../services/assets');
const {allocateAvailablePayments}=require('../services/school-finance-ledger');
const router=express.Router();
const classListPdfCache=new Map();
function getClassListPdf(key){const hit=classListPdfCache.get(key);if(hit&&hit.expires>Date.now())return hit.value;if(hit)classListPdfCache.delete(key);return null;}
function putClassListPdf(key,value){classListPdfCache.set(key,{value,expires:Date.now()+30000});if(classListPdfCache.size>32){const oldest=[...classListPdfCache.entries()].sort((a,b)=>a[1].expires-b[1].expires)[0];if(oldest)classListPdfCache.delete(oldest[0]);}}
router.use(authenticate);
const clean=v=>String(v??'').trim();
const MANAGED_ROLES=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'];
const UNIQUE_ROLES=new Set(['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER']);
const ADMIN_ROLES=new Set(['SCHOOL_ADMIN','ADMIN']);
async function hasOtherActiveAdmin(c,sid,excludeUserId){
  const q=await c.query(`SELECT 1 FROM user_school_roles r JOIN users u ON u.id=r.user_id
    WHERE r.school_id=$1 AND r.role IN ('SCHOOL_ADMIN','ADMIN') AND COALESCE(u.is_active,true)=true AND r.user_id<>$2 LIMIT 1`,[sid,excludeUserId]);
  return Boolean(q.rows[0]);
}

// USER / ROLE CONTROL
// School administrators can activate/deactivate accounts, enable/disable Mark Entry,
// and move one person between the platform's school roles. PLATFORM_OWNER is allowed
// by the global roles() middleware and can therefore manage any school.
router.get('/:schoolId/user-roles',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  try{
    const q=await db.query(`
      SELECT u.id user_id,u.email,u.first_name,u.last_name,u.is_active,
             r.id role_id,r.role,r.mark_entry_enabled,r.created_at role_created_at,
             t.id teacher_id,t.staff_no,t.is_active teacher_active
      FROM users u
      JOIN user_school_roles r ON r.user_id=u.id AND r.school_id=$1
      LEFT JOIN teachers t ON t.user_id=u.id AND t.school_id=$1
      ORDER BY u.last_name,u.first_name,u.email,r.role`,[req.params.schoolId]);
    res.json(q.rows);
  }catch(e){res.status(500).json({error:'Unable to load user and role control.'});}
});

router.patch('/:schoolId/user-roles/:roleId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  const sid=req.params.schoolId,b=req.body||{},c=await db.pool.connect();
  try{
    const current=(await c.query(`
      SELECT r.id,r.user_id,r.school_id,r.role,u.email
      FROM user_school_roles r JOIN users u ON u.id=r.user_id
      WHERE r.id=$1 AND r.school_id=$2`,[req.params.roleId,sid])).rows[0];
    if(!current)return res.status(404).json({error:'User role not found.'});

    if(String(current.user_id)===String(req.user.user_id)){
      if(typeof b.is_active==='boolean'&&b.is_active===false)
        return res.status(400).json({error:'You cannot deactivate your own account. Ask another administrator.'});
      if(b.role!==undefined&&String(b.role).toUpperCase()!==String(current.role).toUpperCase())
        return res.status(400).json({error:'You cannot change your own role. Ask another administrator or the Platform Owner.'});
    }

    await c.query('BEGIN');

    const currentRole=String(current.role).toUpperCase();
    const willDeactivate=typeof b.is_active==='boolean'&&b.is_active===false;
    const nextRole=b.role!==undefined?String(b.role||'').toUpperCase():currentRole;
    // A school must always keep at least one active administrator. Losing the
    // last one locks every school administrator out of role and staff control.
    if(ADMIN_ROLES.has(currentRole)&&(willDeactivate||!ADMIN_ROLES.has(nextRole))&&!(await hasOtherActiveAdmin(c,sid,current.user_id)))
      throw Object.assign(new Error('This is the last active school administrator. Assign another administrator before changing or deactivating this account.'),{status:400});
    if(willDeactivate){
      const elsewhere=(await c.query('SELECT 1 FROM user_school_roles WHERE user_id=$1 AND school_id<>$2 LIMIT 1',[current.user_id,sid])).rows[0];
      if(elsewhere)throw Object.assign(new Error('This account also belongs to another school or the platform. Deactivate it from the Platform Owner console so access is not removed from other schools accidentally.'),{status:400});
    }

    if(typeof b.is_active==='boolean'){
      await c.query('UPDATE users SET is_active=$2 WHERE id=$1',[current.user_id,b.is_active]);
      await c.query('UPDATE teachers SET is_active=$2 WHERE user_id=$1 AND school_id=$3',[current.user_id,b.is_active,sid]);
    }

    if(typeof b.mark_entry_enabled==='boolean'){
      await c.query('UPDATE user_school_roles SET mark_entry_enabled=$2 WHERE id=$1',[current.id,b.mark_entry_enabled]);
    }

    if(b.role!==undefined){
      const next=String(b.role||'').toUpperCase();
      if(!MANAGED_ROLES.includes(next))throw Object.assign(new Error('Invalid school role.'),{status:400});
      if(UNIQUE_ROLES.has(next)){
        const conflict=(await c.query(`
          SELECT u.email,r.role FROM user_school_roles r JOIN users u ON u.id=r.user_id
          WHERE r.school_id=$1 AND r.role=$2 AND r.id<>$3
          LIMIT 1`,[sid,next,current.id])).rows[0];
        if(conflict)throw Object.assign(new Error(`${next.replaceAll('_',' ')} is already assigned to ${conflict.email}. Remove that role first.`),{status:409});
      }
      // One active school role per person. The person remains a teacher profile
      // and their assignments remain intact when changing leadership role.
      await c.query('DELETE FROM user_school_roles WHERE user_id=$1 AND school_id=$2 AND id<>$3',[current.user_id,sid,current.id]);
      await c.query('UPDATE user_school_roles SET role=$2 WHERE id=$1',[current.id,next]);
    }

    const out=(await c.query(`
      SELECT u.id user_id,u.email,u.first_name,u.last_name,u.is_active,
             r.id role_id,r.role,r.mark_entry_enabled,
             t.id teacher_id,t.staff_no,t.is_active teacher_active
      FROM users u JOIN user_school_roles r ON r.user_id=u.id
      LEFT JOIN teachers t ON t.user_id=u.id AND t.school_id=$2
      WHERE r.id=$1 AND r.school_id=$2`,[current.id,sid])).rows[0];

    await c.query('COMMIT');
    res.json(out);
  }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}
  finally{c.release();}
});

router.delete('/:schoolId/user-roles/:roleId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  const sid=req.params.schoolId,c=await db.pool.connect();
  try{
    const r=(await c.query(`
      SELECT r.id,r.user_id,r.role,u.email
      FROM user_school_roles r JOIN users u ON u.id=r.user_id
      WHERE r.id=$1 AND r.school_id=$2`,[req.params.roleId,sid])).rows[0];
    if(!r)return res.status(404).json({error:'User role not found.'});
    if(r.user_id===req.user.user_id) return res.status(400).json({error:'You cannot remove your own active school role. Another administrator must do this.'});
    if(ADMIN_ROLES.has(String(r.role).toUpperCase())&&!(await hasOtherActiveAdmin(c,sid,r.user_id)))
      return res.status(400).json({error:'This is the last active school administrator. Assign another administrator before removing this role.'});
    await c.query('BEGIN');
    await c.query('DELETE FROM user_school_roles WHERE id=$1 AND school_id=$2',[r.id,sid]);
    // Removing a school role does not delete the person, teacher profile, marks,
    // assignments or audit history. The account can be assigned another role later.
    await c.query('COMMIT');
    res.json({ok:true,removed_role:r.role,email:r.email});
  }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(400).json({error:e.message});}
  finally{c.release();}
});


// Administrator reset for a school user. The existing password is never readable.
router.post('/:schoolId/user-roles/:roleId/reset-password',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  try{
    const r=(await db.query(`SELECT r.user_id,u.email FROM user_school_roles r JOIN users u ON u.id=r.user_id WHERE r.id=$1 AND r.school_id=$2`,[req.params.roleId,req.params.schoolId])).rows[0];
    if(!r)return res.status(404).json({error:'User role not found.'});
    const supplied=String(req.body?.new_password||'').trim();
    const temp=supplied||('PM-'+require('crypto').randomBytes(9).toString('base64url')+'9');
    if(temp.length<10)return res.status(400).json({error:'Password must be at least 10 characters.'});
    const hash=await bcrypt.hash(temp,12);
    await db.query('UPDATE users SET password_hash=$2,is_active=true,updated_at=now() WHERE id=$1',[r.user_id,hash]);
    res.json({ok:true,email:r.email,temporary_password:temp});
  }catch(e){res.status(400).json({error:e.message});}
});

// SCHOOL LEADERSHIP ROLE ROUTES
router.get('/:schoolId/leadership',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'),async(req,res)=>{
 try{res.json((await db.query(`SELECT r.id role_id,r.role,u.id user_id,u.email,u.first_name,u.last_name,t.id teacher_id,t.staff_no FROM user_school_roles r JOIN users u ON u.id=r.user_id LEFT JOIN teachers t ON t.user_id=u.id AND t.school_id=r.school_id WHERE r.school_id=$1 AND r.role IN ('HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER') AND u.is_active=true ORDER BY CASE r.role WHEN 'HEADTEACHER' THEN 1 WHEN 'DEPUTY_HEADTEACHER' THEN 2 ELSE 3 END,u.last_name,u.first_name`,[req.params.schoolId])).rows)}catch(e){res.status(400).json({error:e.message});}
});
router.post('/:schoolId/leadership',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const sid=req.params.schoolId,b=req.body||{},c=await db.pool.connect(); try{
  const role=String(b.role||'').toUpperCase(); if(!['HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'].includes(role))return res.status(400).json({error:'Invalid leadership role.'});
  await assertBelongs('teachers',b.teacher_id,sid); await c.query('BEGIN');
  const t=(await c.query(`SELECT id,user_id,is_active FROM teachers WHERE id=$1 AND school_id=$2`,[b.teacher_id,sid])).rows[0];
  if(!t?.user_id||!t.is_active)throw Object.assign(new Error('The selected teacher must have an active linked login.'),{status:400});
  const conflict=(await c.query(`SELECT u.email FROM user_school_roles r JOIN users u ON u.id=r.user_id WHERE r.school_id=$1 AND r.role=$2 AND r.user_id<>$3 AND u.is_active=true LIMIT 1`,[sid,role,t.user_id])).rows[0];
  if(conflict)throw Object.assign(new Error(`${role.replaceAll('_',' ')} is already assigned to ${conflict.email}. Remove that role first.`),{status:409});
  await c.query(`DELETE FROM user_school_roles WHERE user_id=$1 AND school_id=$2`,[t.user_id,sid]);
  const out=(await c.query(`INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled) VALUES($1,$2,$3,true) RETURNING id role_id,role`,[t.user_id,sid,role])).rows[0]; await c.query('COMMIT'); res.status(201).json(out);
 }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}finally{c.release();}
});

router.get('/:schoolId/teachers',schoolBoundary,async(req,res)=>{try{const q=await db.query(`SELECT t.id,t.staff_no,t.first_name,t.last_name,t.email,t.is_active,t.user_id,COALESCE(string_agg(DISTINCT r.role::text, ', ' ORDER BY r.role::text) FILTER (WHERE r.role IS NOT NULL),NULLIF(t.imported_role::text,''),'NO LOGIN ROLE') account_roles,COALESCE(bool_or(r.mark_entry_enabled),false) mark_entry_enabled FROM teachers t LEFT JOIN user_school_roles r ON r.user_id=t.user_id AND r.school_id=t.school_id WHERE t.school_id=$1 GROUP BY t.id,t.staff_no,t.first_name,t.last_name,t.email,t.is_active,t.user_id ORDER BY t.last_name,t.first_name`,[req.params.schoolId]);res.json(Array.isArray(q?.rows)?q.rows:[])}catch(e){console.error('GET /teachers failed',e);res.status(500).json({error:'Unable to load teachers',detail:e.message});}});
// ZELIMU STAFF API V1 — non-teaching staff, school-scoped and administrator-only.
// ZELIMU STAFF MANAGEMENT V2 — school-scoped unified directory and profile editing.
router.get('/:schoolId/staff-management',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'),async(req,res)=>{
 try{
  const sid=req.params.schoolId;
  const t=await db.query(`SELECT t.id,'TEACHER'::text staff_type,t.staff_no,t.first_name,t.last_name,t.email,
   p.phone,COALESCE(p.designation,'Teacher') designation,p.department,p.employment_type,p.employment_date,
   p.tsc_number,p.qualifications,p.notes,t.is_active
   FROM teachers t LEFT JOIN teacher_staff_profiles p ON p.teacher_id=t.id AND p.school_id=t.school_id
   WHERE t.school_id=$1`,[sid]);
  const n=await db.query(`SELECT id,'NON_TEACHING'::text staff_type,staff_no,first_name,last_name,email,phone,designation,department,
   employment_type,employment_date,NULL::text tsc_number,NULL::text qualifications,NULL::text notes,is_active
   FROM non_teaching_staff WHERE school_id=$1`,[sid]);
  res.json([...t.rows,...n.rows].sort((a,b)=>String(a.last_name).localeCompare(String(b.last_name))));
 }catch(e){console.error('staff-management GET',e);res.status(500).json({error:'Unable to load staff profiles. Apply migration 031.'});}
});
router.patch('/:schoolId/staff-management/:type/:id',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const sid=req.params.schoolId,id=req.params.id,type=req.params.type,b=req.body||{};
 if(!['teacher','non-teaching'].includes(type)||!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:'Invalid staff record.'});
 const str=(v,max=250)=>String(v??'').trim().slice(0,max);
 const name=str(b.first_name),last=str(b.last_name),designation=str(b.designation);
 if(!name||!last||!designation)return res.status(400).json({error:'Names and designation are required.'});
 const date=b.employment_date||null;
 if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:'Invalid employment date.'});
 const c=await db.pool.connect();
 try{
  await c.query('BEGIN');let q;
  if(type==='teacher'){
   q=await c.query('UPDATE teachers SET first_name=$3,last_name=$4,email=$5,is_active=$6 WHERE school_id=$1 AND id=$2 RETURNING id',
    [sid,id,name,last,str(b.email)||null,b.is_active!==false]);
   if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Teacher not found.'});}
   await c.query(`INSERT INTO teacher_staff_profiles(school_id,teacher_id,phone,designation,department,employment_type,employment_date,tsc_number,qualifications,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(teacher_id) DO UPDATE SET phone=EXCLUDED.phone,designation=EXCLUDED.designation,department=EXCLUDED.department,
    employment_type=EXCLUDED.employment_type,employment_date=EXCLUDED.employment_date,tsc_number=EXCLUDED.tsc_number,
    qualifications=EXCLUDED.qualifications,notes=EXCLUDED.notes,updated_at=now()`,
    [sid,id,str(b.phone)||null,designation,str(b.department)||null,str(b.employment_type)||null,date,str(b.tsc_number)||null,str(b.qualifications,2000)||null,str(b.notes,2000)||null]);
  }else{
   q=await c.query(`UPDATE non_teaching_staff SET first_name=$3,last_name=$4,email=$5,phone=$6,designation=$7,department=$8,
    employment_type=$9,employment_date=$10,is_active=$11 WHERE school_id=$1 AND id=$2 RETURNING id`,
    [sid,id,name,last,str(b.email)||null,str(b.phone)||null,designation,str(b.department)||null,str(b.employment_type)||null,date,b.is_active!==false]);
   if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Staff record not found.'});}
  }
  await c.query('COMMIT');res.json({ok:true,id});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});console.error('staff-management PATCH',e);res.status(400).json({error:'Unable to update staff record.'});}
 finally{c.release();}
});
router.get('/:schoolId/staff',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'),async(req,res)=>{
 try{const q=await db.query('SELECT id,staff_no,first_name,last_name,email,phone,designation,department,employment_type,employment_date,is_active,created_at FROM non_teaching_staff WHERE school_id=$1 ORDER BY last_name,first_name',[req.params.schoolId]);res.json(q.rows);}
 catch(e){console.error('GET /staff',e);res.status(500).json({error:'Unable to load staff. Ensure the staff migration has been applied.'});}
});
router.post('/:schoolId/staff',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const b=req.body||{},sid=req.params.schoolId;
 const staffNo=clean(b.staff_no),first=clean(b.first_name),last=clean(b.last_name),designation=clean(b.designation);
 if(!staffNo||!first||!last||!designation)return res.status(400).json({error:'Staff number, first name, last name and designation are required.'});
 if([staffNo,first,last,designation].some(x=>x.length>150))return res.status(400).json({error:'A field is too long.'});
 try{
  const conflict=await db.query('SELECT 1 FROM teachers WHERE school_id=$1 AND lower(staff_no)=lower($2) LIMIT 1',[sid,staffNo]);
  if(conflict.rowCount)return res.status(409).json({error:'Staff number is already used by a teacher.'});
  const q=await db.query(`INSERT INTO non_teaching_staff(school_id,staff_no,first_name,last_name,email,phone,designation,department,employment_type,employment_date)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,staff_no,first_name,last_name,email,phone,designation,department,employment_type,employment_date,is_active`,
    [sid,staffNo,first,last,clean(b.email)||null,clean(b.phone)||null,designation,clean(b.department)||null,clean(b.employment_type)||null,b.employment_date||null]);
  res.status(201).json(q.rows[0]);
 }catch(e){res.status(e.code==='23505'?409:400).json({error:e.code==='23505'?'Staff number already exists.':e.message});}
});
router.post('/:schoolId/teachers',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body;if(!clean(b.staff_no)||!clean(b.first_name)||!clean(b.last_name))return res.status(400).json({error:'Staff number, first name and last name are required'});try{const q=await db.query(`INSERT INTO teachers(school_id,staff_no,first_name,last_name,email) VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.params.schoolId,clean(b.staff_no),clean(b.first_name),clean(b.last_name),clean(b.email)||null]);if(q.rows[0] && [b.phone,b.designation,b.department,b.employment_type,b.employment_date,b.tsc_number,b.qualifications].some(Boolean)){
 await db.query(`INSERT INTO teacher_staff_profiles(school_id,teacher_id,phone,designation,department,employment_type,employment_date,tsc_number,qualifications)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(teacher_id) DO NOTHING`,
 [req.params.schoolId,q.rows[0].id,clean(b.phone)||null,clean(b.designation)||'Teacher',clean(b.department)||null,clean(b.employment_type)||null,b.employment_date||null,clean(b.tsc_number)||null,clean(b.qualifications)||null]);
 }res.status(201).json(q.rows[0]);}catch(e){res.status(400).json({error:e.code==='23505'?'That staff number already exists in this school.':e.message});}});
router.post('/:schoolId/teacher-accounts',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  const b=req.body||{},sid=req.params.schoolId;
  const email=clean(b.email).toLowerCase();
  const password=String(b.password||'');
  const allowed=new Set(['TEACHER','CLASS_TEACHER','SENIOR_TEACHER','HEADTEACHER','DEPUTY_HEADTEACHER']);

  if(!b.teacher_id||!email||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)||password.length<10)
    return res.status(400).json({error:'Select a teacher, enter a valid email and a password of at least 10 characters.'});

  const c=await db.pool.connect();
  try{
    await c.query('BEGIN');

    const t=(await c.query(
      'SELECT id,user_id,first_name,last_name,imported_role,is_active FROM teachers WHERE id=$1 AND school_id=$2 FOR UPDATE',
      [b.teacher_id,sid]
    )).rows[0];

    if(!t)throw Object.assign(new Error('Teacher not found in this school.'),{status:404});
    if(!t.is_active)throw Object.assign(new Error('Activate the teacher record first.'),{status:400});
    if(t.user_id)throw Object.assign(new Error('This teacher already has a linked login. Use account management instead.'),{status:409});

    const role=String(b.role||t.imported_role||'TEACHER').trim().toUpperCase();

    if(!allowed.has(role))
      throw Object.assign(new Error('Invalid teacher account role.'),{status:400});

    const existing=(await c.query(
      'SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1',
      [email]
    )).rows[0];

    if(existing)
      throw Object.assign(new Error('This email already has a login. Link the existing account through a verified account-linking workflow; its password has not been changed.'),{status:409});

    if(['HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'].includes(role)){
      const conflict=(await c.query(
        `SELECT 1 FROM user_school_roles r JOIN users u ON u.id=r.user_id
         WHERE r.school_id=$1 AND r.role=$2 AND u.is_active=true LIMIT 1`,
        [sid,role]
      )).rows[0];

      if(conflict)
        throw Object.assign(new Error('This leadership role is already assigned.'),{status:409});
    }

    const hash=await bcrypt.hash(password,12);

    const u=(await c.query(
      `INSERT INTO users(email,password_hash,first_name,last_name)
       VALUES($1,$2,$3,$4) RETURNING id,email`,
      [email,hash,t.first_name,t.last_name]
    )).rows[0];

    await c.query(
      'UPDATE teachers SET email=$2,user_id=$3 WHERE id=$1 AND school_id=$4',
      [t.id,email,u.id,sid]
    );

    await c.query(
      `INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled)
       VALUES($1,$2,$3,true)`,
      [u.id,sid,role]
    );

    await c.query('COMMIT');
    res.status(201).json({teacher_id:t.id,email:u.email,role});
  }catch(e){
    try{await c.query('ROLLBACK')}catch{}
    res.status(e.status||(e.code==='23505'?409:400)).json({
      error:e.code==='23505'?'Account or role already exists.':e.message
    });
  }finally{
    c.release();
  }
});
// ADMINISTRATOR: request linking to an existing school account.
router.post('/:schoolId/teacher-accounts/link-existing',
  schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
    const sid=req.params.schoolId,b=req.body||{};
    const email=clean(b.email).toLowerCase();
    if(!b.teacher_id||!email)
      return res.status(400).json({error:'Teacher and existing account email are required.'});

    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      const teacher=(await c.query(
        `SELECT id,user_id,is_active FROM teachers
         WHERE id=$1 AND school_id=$2 FOR UPDATE`,
        [b.teacher_id,sid]
      )).rows[0];
      if(!teacher||!teacher.is_active||teacher.user_id)
        throw Object.assign(new Error('Teacher must exist, be active and have no linked account.'),{status:409});

      const user=(await c.query(
        `SELECT u.id,u.is_active FROM users u
         JOIN user_school_roles r ON r.user_id=u.id
         WHERE LOWER(u.email)=$1 AND r.school_id=$2
         AND r.role IN ('TEACHER','CLASS_TEACHER','SENIOR_TEACHER',
                        'HEADTEACHER','DEPUTY_HEADTEACHER')
         LIMIT 1`,[email,sid]
      )).rows[0];

      if(!user||!user.is_active)
        throw Object.assign(new Error('An active teacher-role account was not found in this school.'),{status:404});
      if(String(user.id)===String(req.user.user_id))
        throw Object.assign(new Error('An administrator cannot request linking to their own account.'),{status:403});

      const linked=(await c.query(
        'SELECT id FROM teachers WHERE school_id=$1 AND user_id=$2 LIMIT 1',
        [sid,user.id]
      )).rows[0];
      if(linked)
        throw Object.assign(new Error('This account is already linked to a teacher.'),{status:409});

      await c.query(
        `UPDATE teacher_account_link_requests
         SET status='EXPIRED'
         WHERE school_id=$1 AND status='PENDING' AND expires_at<=NOW()`,
        [sid]
      );

      const q=await c.query(
        `INSERT INTO teacher_account_link_requests
         (school_id,teacher_id,target_user_id,requested_by)
         VALUES($1,$2,$3,$4)
         RETURNING id,expires_at`,
        [sid,teacher.id,user.id,req.user.user_id]
      );

      await c.query('COMMIT');
      res.status(201).json({
        ok:true,request_id:q.rows[0].id,
        expires_at:q.rows[0].expires_at,
        message:'Link request created. The account holder must confirm it.'
      });
    }catch(e){
      try{await c.query('ROLLBACK')}catch{}
      res.status(e.status||(e.code==='23505'?409:400)).json({
        error:e.code==='23505'?'A pending link request already exists.':e.message
      });
    }finally{c.release();}
  }
);

// ACCOUNT HOLDER: view their own pending link requests.
router.get('/:schoolId/teacher-accounts/my-link-requests',
  schoolBoundary,async(req,res)=>{
    try{
      const q=await db.query(
        `SELECT lr.id,lr.teacher_id,lr.created_at,lr.expires_at,
                t.first_name,t.last_name,t.staff_no
         FROM teacher_account_link_requests lr
         JOIN teachers t ON t.id=lr.teacher_id AND t.school_id=lr.school_id
         WHERE lr.school_id=$1 AND lr.target_user_id=$2
           AND lr.status='PENDING' AND lr.expires_at>NOW()
         ORDER BY lr.created_at DESC`,
        [req.params.schoolId,req.user.user_id]
      );
      res.json(q.rows);
    }catch(e){res.status(500).json({error:'Unable to load link requests.'});}
  }
);

// ACCOUNT HOLDER: confirm a link to their own authenticated account.
router.post('/:schoolId/teacher-accounts/link-requests/:requestId/confirm',
  schoolBoundary,async(req,res)=>{
    const sid=req.params.schoolId,c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      const lr=(await c.query(
        `SELECT * FROM teacher_account_link_requests
         WHERE id=$1 AND school_id=$2 AND target_user_id=$3
         FOR UPDATE`,
        [req.params.requestId,sid,req.user.user_id]
      )).rows[0];

      if(!lr||lr.status!=='PENDING'||new Date(lr.expires_at)<=new Date())
        throw Object.assign(new Error('No valid pending request for this account.'),{status:404});

      const teacher=(await c.query(
        `SELECT id,user_id,is_active FROM teachers
         WHERE id=$1 AND school_id=$2 FOR UPDATE`,
        [lr.teacher_id,sid]
      )).rows[0];

      if(!teacher||!teacher.is_active||teacher.user_id)
        throw Object.assign(new Error('Teacher is unavailable for linking.'),{status:409});

      const user=(await c.query(
        `SELECT id,email,is_active FROM users WHERE id=$1 FOR UPDATE`,
        [req.user.user_id]
      )).rows[0];

      if(!user||!user.is_active)
        throw Object.assign(new Error('Account is inactive.'),{status:403});

      const membership=(await c.query(
        `SELECT 1 FROM user_school_roles
         WHERE user_id=$1 AND school_id=$2
           AND role IN ('TEACHER','CLASS_TEACHER','SENIOR_TEACHER',
                        'HEADTEACHER','DEPUTY_HEADTEACHER')
         LIMIT 1`,
        [user.id,sid]
      )).rows[0];

      if(!membership)
        throw Object.assign(new Error('Teacher role is no longer assigned.'),{status:403});

      const linked=(await c.query(
        `SELECT 1 FROM teachers WHERE school_id=$1 AND user_id=$2 LIMIT 1`,
        [sid,user.id]
      )).rows[0];
      if(linked)
        throw Object.assign(new Error('Account is already linked to another teacher.'),{status:409});

      await c.query(
        `UPDATE teachers SET user_id=$3,email=$4
         WHERE id=$1 AND school_id=$2`,
        [teacher.id,sid,user.id,user.email]
      );
      await c.query(
        `UPDATE teacher_account_link_requests
         SET status='CONFIRMED',confirmed_at=NOW() WHERE id=$1`,
        [lr.id]
      );
      await c.query('COMMIT');
      res.json({ok:true,teacher_id:teacher.id,message:'Teacher account linked successfully.'});
    }catch(e){
      try{await c.query('ROLLBACK')}catch{}
      res.status(e.status||(e.code==='23505'?409:400)).json({error:e.message});
    }finally{c.release();}
  }
);

router.patch('/:schoolId/learners/:learnerId/identifiers',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{
 try{
  await assertBelongs('learners',req.params.learnerId,req.params.schoolId);
  if(req.user.role==='CLASS_TEACHER'){
   const allowed=(await db.query(`SELECT 1 FROM learners l
     WHERE l.id=$1 AND l.school_id=$2 AND EXISTS (
       SELECT 1 FROM class_teacher_assignments cta
       JOIN teachers t ON t.id=cta.teacher_id AND t.school_id=cta.school_id
       WHERE cta.school_id=l.school_id AND cta.class_id=l.class_id AND t.user_id=$3
         AND cta.academic_year_id=(SELECT id FROM academic_years WHERE school_id=l.school_id ORDER BY year_label DESC LIMIT 1)
     ) LIMIT 1`,[req.params.learnerId,req.params.schoolId,req.user.user_id])).rows[0];
   if(!allowed)return res.status(403).json({error:'You can only edit admission and assessment numbers for learners in your assigned class.'});
  }
  const q=await db.query(`UPDATE learners SET admission_no=$3,assessment_no=$4 WHERE id=$1 AND school_id=$2 RETURNING *`,[req.params.learnerId,req.params.schoolId,clean(req.body?.admission_no)||null,clean(req.body?.assessment_no)||null]);
  res.json(q.rows[0]);
 }catch(e){res.status(e.status||400).json({error:e.code==='23505'?'That admission number already exists in this school.':e.message});}
});
// Return JSON for the academic-year promotion roster. A missing route previously
// fell through to the dashboard HTML fallback, producing invalid JSON (HTTP 200).
// Year-scoped register: historical completed enrollments remain visible in their source year.
router.get('/:schoolId/year-registers/:yearId',schoolBoundary,
 roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,yearId=req.params.yearId;
  await assertBelongs('academic_years',yearId,sid);
  const params=[sid,yearId];let scope='';
  if(req.user.role==='CLASS_TEACHER'){
   params.push(req.user.user_id);
   scope=` AND EXISTS (SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id AND t.school_id=a.school_id WHERE a.school_id=e.school_id AND a.class_id=e.class_id AND a.academic_year_id=e.academic_year_id AND t.user_id=$3)`;
  }
  const rows=(await db.query(`SELECT e.learner_id AS id,e.class_id,e.academic_year_id,e.status AS enrollment_status,l.first_name,l.middle_name,l.last_name,l.admission_no,l.assessment_no,l.is_active
    FROM learner_enrollments e JOIN learners l ON l.id=e.learner_id AND l.school_id=e.school_id
    WHERE e.school_id=$1 AND e.academic_year_id=$2${scope}
    ORDER BY l.last_name,l.first_name,l.id`,params)).rows;
  res.setHeader('Cache-Control','no-store');res.json(rows);
 }catch(e){res.status(e.status||500).json({error:e.message||'Year register unavailable'});}
});

router.get('/:schoolId/enrollments/:yearId',schoolBoundary,
  roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER'),
  async(req,res)=>{
    const sid=req.params.schoolId, yearId=req.params.yearId;
    try{
      await assertBelongs('academic_years',yearId,sid);
      const params=[sid,yearId];
      let scope='';
      if(req.user.role==='CLASS_TEACHER'){
        params.push(req.user.user_id);
        scope=` AND EXISTS (
          SELECT 1 FROM class_teacher_assignments cta
          JOIN teachers t ON t.id=cta.teacher_id AND t.school_id=cta.school_id
          WHERE cta.school_id=e.school_id AND cta.class_id=e.class_id
            AND cta.academic_year_id=e.academic_year_id AND t.user_id=$3
        )`;
      }
      const q=await db.query(`
        SELECT e.learner_id,e.academic_year_id,e.class_id,e.status,
               l.first_name,l.middle_name,l.last_name,l.admission_no,
               c.name AS class_name,c.stream
        FROM learner_enrollments e
        JOIN learners l ON l.id=e.learner_id AND l.school_id=e.school_id
        JOIN classes c ON c.id=e.class_id AND c.school_id=e.school_id
        WHERE e.school_id=$1 AND e.academic_year_id=$2
          AND COALESCE(e.status,'ACTIVE')='ACTIVE'${scope}
        ORDER BY c.name,c.stream,l.last_name,l.first_name,l.id`,params);
      res.json(q.rows);
    }catch(e){
      console.error('Promotion roster load failed:',e);
      res.status(e.status||500).json({error:e.message||'Unable to load promotion learners.'});
    }
  });

// Bulk learner promotion / progression engine. Historical enrolments and marks remain untouched.
router.post('/:schoolId/promote',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','CLASS_TEACHER'),async(req,res)=>{
 const sid=req.params.schoolId,b=req.body||{}; const c=await db.pool.connect();
 try{
  const ids=Array.isArray(b.learner_ids)?[...new Set(b.learner_ids.filter(Boolean))]:[];
  if(!ids.length||!b.source_year_id||!b.source_class_id||!b.destination_year_id||!b.destination_class_id)
    return res.status(400).json({error:'Learners, source year/class and destination year/class are required.'});
  if(String(b.source_year_id)===String(b.destination_year_id)) return res.status(400).json({error:'Promotion must move learners into a different academic year.'});
  await assertBelongs('academic_years',b.source_year_id,sid); await assertBelongs('academic_years',b.destination_year_id,sid);
  await assertBelongs('classes',b.source_class_id,sid); await assertBelongs('classes',b.destination_class_id,sid);
  if(req.user.role==='CLASS_TEACHER'){
    const assigned=(await c.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND t.user_id=$4 AND COALESCE(t.is_active,true)=true LIMIT 1`,[sid,b.source_class_id,b.source_year_id,req.user.user_id])).rows[0];
    if(!assigned)return res.status(403).json({error:'You can only promote learners from your assigned class.'});
  }
  const sourceYear=(await c.query('SELECT id,year_label,start_date,end_date FROM academic_years WHERE id=$1 AND school_id=$2',[b.source_year_id,sid])).rows[0];
  const destYear=(await c.query('SELECT id,year_label,start_date,end_date FROM academic_years WHERE id=$1 AND school_id=$2',[b.destination_year_id,sid])).rows[0];
  const srcClass=(await c.query('SELECT id,name,stream FROM classes WHERE id=$1 AND school_id=$2',[b.source_class_id,sid])).rows[0];
  const dstClass=(await c.query('SELECT id,name,stream FROM classes WHERE id=$1 AND school_id=$2',[b.destination_class_id,sid])).rows[0];
  if(!sourceYear||!destYear||!srcClass||!dstClass)return res.status(404).json({error:'Promotion academic context not found.'});
  const learners=(await c.query(`SELECT l.id,l.first_name,l.middle_name,l.last_name,l.admission_no,
      e.class_id,e.status enrollment_status
    FROM learners l JOIN learner_enrollments e ON e.learner_id=l.id AND e.school_id=$1 AND e.academic_year_id=$2
    WHERE l.school_id=$1 AND l.id=ANY($3::uuid[]) AND e.class_id=$4 AND COALESCE(e.status,'ACTIVE')='ACTIVE'`,[sid,b.source_year_id,ids,b.source_class_id])).rows;
  if(learners.length!==ids.length)return res.status(400).json({error:'One or more selected learners are not actively enrolled in the selected source class/year.'});
  await c.query('BEGIN');
  const effective=(destYear.start_date||new Date().toISOString().slice(0,10));
  for(const l of learners){
    await c.query(`UPDATE learner_enrollments SET status='COMPLETED',ended_at=COALESCE(ended_at,$5) WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND class_id=$4`,[sid,l.id,b.source_year_id,b.source_class_id,effective]);
    await c.query(`INSERT INTO learner_enrollments(school_id,learner_id,academic_year_id,class_id,previous_class_id,status,enrolled_at)
      VALUES($1,$2,$3,$4,$5,'ACTIVE',$6)
      ON CONFLICT(learner_id,academic_year_id) DO UPDATE SET class_id=EXCLUDED.class_id,previous_class_id=EXCLUDED.previous_class_id,status='ACTIVE',enrolled_at=EXCLUDED.enrolled_at,ended_at=NULL`,[sid,l.id,b.destination_year_id,b.destination_class_id,b.source_class_id,effective]);
    await c.query(`UPDATE learners SET class_id=$3 WHERE id=$1 AND school_id=$2`,[l.id,sid,b.destination_class_id]);
    await c.query(`INSERT INTO learner_movement_events(school_id,learner_id,academic_year_id,from_class_id,to_class_id,event_type,reason,status,requested_by,approved_by,effective_date,approved_at,action_note)
      VALUES($1,$2,$3,$4,$5,'PROMOTION',$6,'APPROVED',$7,$7,$8,now(),$9)`,[sid,l.id,b.destination_year_id,b.source_class_id,b.destination_class_id,b.reason||`Promoted from ${srcClass.name}${srcClass.stream?' '+srcClass.stream:''} to ${dstClass.name}${dstClass.stream?' '+dstClass.stream:''}`,req.user.user_id,effective,b.action_note||'Bulk academic-year promotion']);
  }
  try{await c.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,'LEARNERS_PROMOTED','LEARNER_BULK',gen_random_uuid(),$3::jsonb)`,[sid,req.user.user_id,JSON.stringify({count:learners.length,source_year_id:b.source_year_id,destination_year_id:b.destination_year_id,source_class_id:b.source_class_id,destination_class_id:b.destination_class_id})]);}catch{}
  await c.query('COMMIT');
  res.status(201).json({promoted:learners.length,source:{year:sourceYear.year_label,class:srcClass.name,stream:srcClass.stream||''},destination:{year:destYear.year_label,class:dstClass.name,stream:dstClass.stream||''},effective_date:effective,learners:learners.map(l=>({id:l.id,name:[l.first_name,l.middle_name,l.last_name].filter(Boolean).join(' '),admission_no:l.admission_no}))});
 }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}finally{c.release();}
});


router.patch('/:schoolId/learners/:learnerId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{
 const sid=req.params.schoolId,learnerId=req.params.learnerId,b=req.body||{};
 try{
  const current=(await db.query(`SELECT l.*,e.academic_year_id,e.class_id AS enrollment_class_id
    FROM learners l LEFT JOIN learner_enrollments e ON e.learner_id=l.id AND e.school_id=l.school_id
      AND e.academic_year_id=COALESCE($3,e.academic_year_id)
    WHERE l.id=$1 AND l.school_id=$2
    ORDER BY e.enrolled_at DESC NULLS LAST LIMIT 1`,[learnerId,sid,b.academic_year_id||null])).rows[0];
  if(!current)return res.status(404).json({error:'Learner not found in this school.'});
  const classId=b.class_id||current.class_id||current.enrollment_class_id;
  if(b.class_id)await assertBelongs('classes',b.class_id,sid);
  if(req.user.role==='CLASS_TEACHER'){
    if(String(classId)!==String(current.class_id||current.enrollment_class_id))return res.status(403).json({error:'A Class Teacher can only edit a learner within the assigned class.'});
    const yearId=b.academic_year_id||current.academic_year_id;
    const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id
      WHERE a.school_id=$1 AND t.user_id=$2 AND a.class_id=$3 AND a.academic_year_id=$4 LIMIT 1`,
      [sid,req.user.user_id,classId,yearId])).rows[0];
    if(!ok)return res.status(403).json({error:'You can only edit learners in your assigned class.'});
  }
  // PATCH must not silently erase fields the caller did not send.
  const firstName=b.first_name===undefined?current.first_name:clean(b.first_name);
  const lastName=b.last_name===undefined?current.last_name:clean(b.last_name);
  if(!clean(firstName)||!clean(lastName))return res.status(400).json({error:'Learner first name and last name are required.'});
  const admissionNo=b.admission_no===undefined?current.admission_no:(clean(b.admission_no)||null);
  const assessmentNo=b.assessment_no===undefined?current.assessment_no:(clean(b.assessment_no)||null);
  const middleName=b.middle_name===undefined?current.middle_name:(clean(b.middle_name)||null);
  const dob=b.date_of_birth===undefined?current.date_of_birth:(b.date_of_birth||null);
  const gender=b.gender===undefined?current.gender:(clean(b.gender)||null);
  const parentPhone=b.parent_phone===undefined?current.parent_phone:(clean(b.parent_phone)||null);
  const active=b.is_active===undefined?null:(b.is_active===true||b.is_active==='true');
  const q=await db.query(`UPDATE learners SET admission_no=$3,assessment_no=$4,first_name=$5,middle_name=$6,last_name=$7,date_of_birth=$8,gender=$9,parent_phone=$10,class_id=$11,is_active=COALESCE($12::boolean,is_active)
    WHERE id=$1 AND school_id=$2 RETURNING *`,
    [learnerId,sid,admissionNo,assessmentNo,firstName,middleName,lastName,dob,gender,parentPhone,classId,active]);
  if(!q.rows[0])return res.status(404).json({error:'Learner not found.'});
  if(b.academic_year_id&&classId){
    await db.query(`INSERT INTO learner_enrollments(school_id,learner_id,academic_year_id,class_id,status)
      VALUES($1,$2,$3,$4,'ACTIVE')
      ON CONFLICT(learner_id,academic_year_id) DO UPDATE SET class_id=EXCLUDED.class_id,status='ACTIVE',ended_at=NULL`,
      [sid,learnerId,b.academic_year_id,classId]);
  }
  res.json(q.rows[0]);
 }catch(e){res.status(e.status||400).json({error:e.code==='23505'?'That admission number already exists in this school.':e.message});}
});

router.post('/:schoolId/learners/bulk',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{
 const sid=req.params.schoolId,b=req.body||{},rows=Array.isArray(b.rows)?b.rows:[],c=await db.pool.connect();
 try{
  if(!rows.length)return res.status(400).json({error:'Paste at least one learner row.'});
  if(!b.academic_year_id||!b.class_id)return res.status(400).json({error:'Academic year and class are required.'});
  await assertBelongs('academic_years',b.academic_year_id,sid); await assertBelongs('classes',b.class_id,sid);
  if(req.user.role==='CLASS_TEACHER'){
   const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id
     WHERE a.school_id=$1 AND t.user_id=$2 AND a.class_id=$3 AND a.academic_year_id=$4 LIMIT 1`,
     [sid,req.user.user_id,b.class_id,b.academic_year_id])).rows[0];
   if(!ok)return res.status(403).json({error:'You can only bulk-add learners to your assigned class.'});
  }
  await c.query('BEGIN');
  let created=0,updated=0,enrolled=0,skipped=0;
  for(const raw of rows){
   const r=raw||{}, first=clean(r.first_name), last=clean(r.last_name);
   if(!first||!last){skipped++;continue;}
   const adm=clean(r.admission_no)||null, ass=clean(r.assessment_no)||null;
   let learner;
   if(adm){
    learner=(await c.query(`SELECT * FROM learners WHERE school_id=$1 AND admission_no=$2 LIMIT 1`,[sid,adm])).rows[0];
   }
   if(!learner && ass){
    learner=(await c.query(`SELECT * FROM learners WHERE school_id=$1 AND assessment_no=$2 LIMIT 1`,[sid,ass])).rows[0];
   }
   if(!learner){
    const exact=(await c.query(`SELECT * FROM learners WHERE school_id=$1 AND LOWER(TRIM(first_name))=LOWER(TRIM($2))
      AND LOWER(TRIM(last_name))=LOWER(TRIM($3)) AND (middle_name IS NOT DISTINCT FROM $4 OR LOWER(COALESCE(middle_name,''))=LOWER(COALESCE($4,''))) LIMIT 1`,
      [sid,first,last,clean(r.middle_name)||null])).rows[0];
    learner=exact;
   }
   if(learner){
    const photo=clean(r.passport_photo_url)||clean(r.photo_url)||clean(r.photo)||null;
    const pathway=clean(r.cbc_pathway)||clean(r.pathway)||clean(r.track)||null;
    const upd=(await c.query(`UPDATE learners SET admission_no=COALESCE($3,admission_no),assessment_no=COALESCE($4,assessment_no),
      first_name=$5,middle_name=$6,last_name=$7,date_of_birth=COALESCE($8,date_of_birth),gender=COALESCE($9,gender),
      parent_phone=COALESCE($10,parent_phone),class_id=$11,
      passport_photo_url=COALESCE($12,passport_photo_url),cbc_pathway=COALESCE($13,cbc_pathway),
      is_active=true WHERE id=$1 AND school_id=$2 RETURNING *`,
      [learner.id,sid,adm,ass,first,clean(r.middle_name)||null,last,r.date_of_birth||null,clean(r.gender)||null,clean(r.parent_phone)||null,b.class_id,photo,pathway])).rows[0];
    learner=upd;updated++;
   }else{
    learner=(await c.query(`INSERT INTO learners(school_id,admission_no,assessment_no,first_name,middle_name,last_name,date_of_birth,gender,class_id,parent_phone,passport_photo_url,cbc_pathway)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [sid,adm,ass,first,clean(r.middle_name)||null,last,r.date_of_birth||null,clean(r.gender)||null,b.class_id,clean(r.parent_phone)||null,photo,pathway])).rows[0];
    created++;
   }
   await c.query(`INSERT INTO learner_enrollments(school_id,learner_id,academic_year_id,class_id,status)
     VALUES($1,$2,$3,$4,'ACTIVE')
     ON CONFLICT(learner_id,academic_year_id) DO UPDATE SET class_id=EXCLUDED.class_id,status='ACTIVE',ended_at=NULL`,
     [sid,learner.id,b.academic_year_id,b.class_id]); enrolled++;
   const pName = clean(r.parent_name)||clean(r.guardian_name)||null;
   const pPhone = clean(r.parent_phone)||null;
   if (pName || pPhone) {
     try {
       const pParts = (pName || 'Parent').split(/\s+/).filter(Boolean);
       const pFirst = pParts[0] || 'Parent', pLast = pParts.slice(1).join(' ') || 'Guardian';
       let pg = null;
       if (pPhone) {
         pg = (await c.query(`SELECT id FROM parent_guardians WHERE school_id=$1 AND phone=$2 LIMIT 1`, [sid, pPhone])).rows[0];
       }
       if (!pg) {
         pg = (await c.query(`INSERT INTO parent_guardians(school_id, first_name, last_name, phone, relationship) VALUES($1, $2, $3, $4, 'Parent/Guardian') RETURNING id`, [sid, pFirst, pLast, pPhone])).rows[0];
       }
       if (pg) {
         await c.query(`INSERT INTO learner_guardians(learner_id, parent_guardian_id, is_primary) VALUES($1, $2, true) ON CONFLICT DO NOTHING`, [learner.id, pg.id]);
       }
     } catch(e) {}
   }
   if (pathway) {
     try {
       await c.query(
         `INSERT INTO report_pathway_guidance (
            school_id, learner_id, academic_year_id, selected_pathway, track_specialisation
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (school_id, learner_id, academic_year_id)
          DO UPDATE SET selected_pathway = EXCLUDED.selected_pathway, track_specialisation = EXCLUDED.track_specialisation`,
         [sid, learner.id, b.academic_year_id, pathway, clean(r.pathway_track) || (pathway === 'STEM' ? 'Pure Sciences' : 'General')]
       );
     } catch(e) {}
   }
  }
  await c.query('COMMIT');
  res.status(201).json({ok:true,created,updated,enrolled,skipped,total:rows.length});
 }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.code==='23505'?'A learner with that admission/assessment number already exists.':e.message});}
 finally{c.release();}
});

router.post('/:schoolId/learners/:learnerId/remove-from-class',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{
 const sid=req.params.schoolId,learnerId=req.params.learnerId,b=req.body||{},c=await db.pool.connect();
 try{
  if(!b.academic_year_id)return res.status(400).json({error:'Academic year is required when removing a learner from a class.'});
  await assertBelongs('learners',learnerId,sid);
  await assertBelongs('academic_years',b.academic_year_id,sid);
  const enr=(await c.query(`SELECT le.*,l.first_name,l.middle_name,l.last_name,l.class_id AS learner_class_id FROM learner_enrollments le JOIN learners l ON l.id=le.learner_id WHERE le.school_id=$1 AND le.learner_id=$2 AND le.academic_year_id=$3`,[sid,learnerId,b.academic_year_id])).rows[0];
  if(!enr)return res.status(404).json({error:'This learner has no enrollment in the selected academic year.'});
  if(req.user.role==='CLASS_TEACHER'){
   const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id WHERE a.school_id=$1 AND t.user_id=$2 AND a.class_id=$3 AND a.academic_year_id=$4 LIMIT 1`,[sid,req.user.user_id,enr.class_id,b.academic_year_id])).rows[0];
   if(!ok)return res.status(403).json({error:'You can only remove learners from your assigned class.'});
  }
  await c.query('BEGIN');
  await c.query(`UPDATE learner_enrollments SET status='TRANSFERRED_OUT',ended_at=COALESCE(ended_at,now()) WHERE id=$1 AND school_id=$2`,[enr.id,sid]);
  if(String(enr.learner_class_id)===String(enr.class_id)){
   await c.query('UPDATE learners SET class_id=NULL WHERE id=$1 AND school_id=$2',[learnerId,sid]);
  }
  try{await c.query(`INSERT INTO learner_movement_events(school_id,learner_id,academic_year_id,from_class_id,event_type,reason,status,requested_by,approved_by,approved_at) VALUES($1,$2,$3,$4,'REMOVED_FROM_CLASS',$5,'APPROVED',$6,$6,now())`,[sid,learnerId,b.academic_year_id,enr.class_id,clean(b.reason)||'Removed from class',req.user.user_id]);}catch(eventError){if(eventError.code!=='42P01')throw eventError;}
  await c.query('COMMIT');
  res.json({ok:true,learner_id:learnerId,academic_year_id:b.academic_year_id,class_id:enr.class_id,status:'TRANSFERRED_OUT',message:'Learner removed from the class. Historical marks and reports remain preserved.'});
 }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}finally{c.release();}
});
// Admissions Phase 2: applications are separate from learner records until confirmation.
const admissionRoles=roles('SCHOOL_ADMIN','ADMIN');
router.get('/:schoolId/admission-applications',schoolBoundary,admissionRoles,async(req,res)=>{
 try{const q=await db.query(`SELECT id,status,payload->>'first_name' first_name,payload->>'last_name' last_name,payload->>'admission_no' admission_no,learner_id,review_note,created_at,updated_at FROM learner_admission_applications WHERE school_id=$1 ORDER BY updated_at DESC LIMIT 300`,[req.params.schoolId]);res.json(q.rows);}catch(e){res.status(500).json({error:e.message});}
});
router.get('/:schoolId/admission-applications/:id',schoolBoundary,admissionRoles,async(req,res)=>{
 try{const q=await db.query(`SELECT * FROM learner_admission_applications WHERE id=$1 AND school_id=$2`,[req.params.id,req.params.schoolId]);if(!q.rows[0])return res.status(404).json({error:'Application not found'});res.json(q.rows[0]);}catch(e){res.status(500).json({error:e.message});}
});
router.post('/:schoolId/admission-applications',schoolBoundary,admissionRoles,async(req,res)=>{
 const b=req.body||{},sid=req.params.schoolId;
 try{const status=b.submit_for_review?'PENDING_REVIEW':'DRAFT';const payload={...b};delete payload.submit_for_review;delete payload.passport_photo;
 if(JSON.stringify(payload).length>30000)return res.status(413).json({error:'Application is too large'});
 const q=await db.query(`INSERT INTO learner_admission_applications(school_id,status,payload,created_by) VALUES($1,$2,$3::jsonb,$4) RETURNING id,status`,[sid,status,JSON.stringify(payload),req.user.user_id]);res.status(201).json(q.rows[0]);
 }catch(e){res.status(400).json({error:e.message});}
});
router.patch('/:schoolId/admission-applications/:id',schoolBoundary,admissionRoles,async(req,res)=>{
 const b=req.body||{},sid=req.params.schoolId;
 try{const current=(await db.query(`SELECT * FROM learner_admission_applications WHERE id=$1 AND school_id=$2`,[req.params.id,sid])).rows[0];
 if(!current)return res.status(404).json({error:'Application not found'});
 if(current.status==='CONFIRMED')return res.status(409).json({error:'Confirmed applications cannot be edited'});
 const status=b.status||current.status;if(!['DRAFT','PENDING_REVIEW','RETURNED'].includes(status))return res.status(400).json({error:'Invalid application status'});
 const payload=b.payload&&typeof b.payload==='object'&&!Array.isArray(b.payload)?b.payload:current.payload;
 if(JSON.stringify(payload).length>30000)return res.status(413).json({error:'Application is too large'});
 const q=await db.query(`UPDATE learner_admission_applications SET status=$3,payload=$4::jsonb,review_note=$5,updated_at=now() WHERE id=$1 AND school_id=$2 RETURNING id,status`,[req.params.id,sid,status,JSON.stringify(payload),clean(b.review_note)||current.review_note]);res.json(q.rows[0]);
 }catch(e){res.status(400).json({error:e.message});}
});
router.get('/:schoolId/learners',schoolBoundary,async(req,res)=>{
 try{
  const role=String(req.user.role||'').toUpperCase();
  let extra='';
  const params=[req.params.schoolId];
  if(role==='CLASS_TEACHER'||role==='TEACHER'){
   params.push(req.user.user_id);
   const latestYear=`(SELECT id FROM academic_years WHERE school_id=l.school_id ORDER BY year_label DESC LIMIT 1)`;
   const classTeacher=`EXISTS (SELECT 1 FROM class_teacher_assignments cta JOIN teachers ct ON ct.id=cta.teacher_id AND ct.school_id=cta.school_id WHERE cta.school_id=l.school_id AND cta.class_id=l.class_id AND ct.user_id=$2 AND cta.academic_year_id=${latestYear})`;
   const subjectTeacher=`EXISTS (SELECT 1 FROM teacher_subject_assignments tsa JOIN teachers tt ON tt.id=tsa.teacher_id AND tt.school_id=tsa.school_id WHERE tsa.school_id=l.school_id AND tsa.class_id=l.class_id AND tt.user_id=$2 AND tsa.academic_year_id=${latestYear} AND COALESCE(tsa.is_active,true)=true)`;
   extra=role==='CLASS_TEACHER'?` AND ${classTeacher}`:` AND (${classTeacher} OR ${subjectTeacher})`;
  }
  res.json((await db.query(`SELECT l.*,cl.name class_name,cl.stream,lv.name level_name,ss.name section_name FROM learners l LEFT JOIN classes cl ON cl.id=l.class_id LEFT JOIN school_levels lv ON lv.id=cl.school_level_id LEFT JOIN school_sections ss ON ss.id=lv.school_section_id WHERE l.school_id=$1${extra} ORDER BY l.last_name,l.first_name`,params)).rows);
 }catch(e){res.status(500).json({error:'Unable to load learners'});}
});
router.post('/:schoolId/learners',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{const b=req.body,sid=req.params.schoolId,c=await db.pool.connect();try{if(!clean(b.first_name)||!clean(b.last_name))return res.status(400).json({error:'First name and last name are required'});if(b.class_id)await assertBelongs('classes',b.class_id,sid);if(req.user.role==='CLASS_TEACHER'){if(!b.class_id)return res.status(400).json({error:'Class Teacher must select the assigned class.'});const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id WHERE a.school_id=$1 AND t.user_id=$2 AND a.class_id=$3 AND a.academic_year_id=$4 AND (a.term_id=$5 OR a.term_id IS NULL) LIMIT 1`,[sid,req.user.user_id,b.class_id,b.academic_year_id,b.term_id||null])).rows[0];if(!ok)return res.status(403).json({error:'You can only add learners to a class assigned to you as Class Teacher.'});}if(b.academic_year_id)await assertBelongs('academic_years',b.academic_year_id,sid);
if(b.admission_workflow==='CONFIRMED'&&(!b.academic_year_id||!b.class_id))return res.status(400).json({error:'Academic year and class are required for admission.'});
if(b.admission_no||b.assessment_no){const dup=await c.query(`SELECT id,admission_no,assessment_no,first_name,last_name FROM learners WHERE school_id=$1 AND ((NULLIF(trim($2::text),'') IS NOT NULL AND lower(trim(admission_no))=lower(trim($2::text))) OR (NULLIF(trim($3::text),'') IS NOT NULL AND lower(trim(assessment_no))=lower(trim($3::text)))) LIMIT 1`,[sid,b.admission_no||'',b.assessment_no||'']);if(dup.rows.length)return res.status(409).json({error:'An existing learner has this admission or assessment number. Search Learner Enrollment & Promotion before registering.',existing_learner_id:dup.rows[0].id});}
if(b.guardian_first_name||b.guardian_last_name||b.guardian_phone){if(!clean(b.guardian_first_name)||!clean(b.guardian_last_name)||!clean(b.guardian_phone))return res.status(400).json({error:'Provide guardian first name, last name and phone together.'});}
await c.query('BEGIN');
if(b.admission_application_id){const app=(await c.query(`SELECT id,status FROM learner_admission_applications WHERE id=$1 AND school_id=$2 FOR UPDATE`,[b.admission_application_id,sid])).rows[0];if(!app||app.status==='CONFIRMED')throw Object.assign(new Error('Application not found or already confirmed'),{status:409});}
const l=(await c.query(`INSERT INTO learners(school_id,admission_no,assessment_no,first_name,middle_name,last_name,date_of_birth,gender,class_id,parent_phone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[sid,clean(b.admission_no)||null,clean(b.assessment_no)||null,clean(b.first_name),clean(b.middle_name),clean(b.last_name),b.date_of_birth||null,clean(b.gender)||null,b.class_id||null,clean(b.parent_phone)||null])).rows[0];if(b.academic_year_id&&b.class_id){await c.query(`INSERT INTO learner_enrollments(school_id,learner_id,academic_year_id,class_id) VALUES($1,$2,$3,$4) ON CONFLICT(learner_id,academic_year_id) DO UPDATE SET class_id=EXCLUDED.class_id`,[sid,l.id,b.academic_year_id,b.class_id]);}
// AUTO_ASSIGN_ADMISSION_FEES_V1
// Use the same transaction as learner admission and enrolment.
// Only active, class-specific structures for the selected year qualify.
if (b.academic_year_id && b.class_id) {
  await c.query(`
    INSERT INTO school_fee_charges
      (school_id, learner_id, fee_structure_id,
       description, amount, due_on, academic_year_id, created_by)
    SELECT
      fs.school_id, $2, fs.id,
      fs.name, fs.amount, fs.due_on, fs.academic_year_id, $5
    FROM school_fee_structures fs
    WHERE fs.school_id = $1
      AND fs.class_id = $3
      AND fs.academic_year_id = $4
      AND fs.is_active = true
      AND fs.currency = 'KES'
    ON CONFLICT (school_id, learner_id, fee_structure_id)
    DO NOTHING
  `, [
    sid,
    l.id,
    b.class_id,
    b.academic_year_id,
    req.user.user_id
  ]);
  await allocateAvailablePayments(c,sid,l.id);
}

// Admissions details and guardian are committed with the learner and enrollment.
const metaFields=['admission_date','admission_type','previous_school','county','sub_county','home_address','emergency_name','emergency_phone','allergies','medical_notes','learning_support','residence_type','transport_route','documents_pending','guardian_relationship','guardian_alt_phone','guardian_occupation'];
const admissionType=['NEW','TRANSFER','READMISSION'].includes(String(b.admission_type||'NEW'))?String(b.admission_type||'NEW'):'NEW';
const meta=metaFields.map(k=>k==='admission_type'?admissionType:(clean(b[k])||null));
await c.query(`INSERT INTO learner_admission_profiles(learner_id,school_id,${metaFields.join(',')},transport_required,created_by) VALUES($1,$2,${metaFields.map((_,i)=>'$'+(i+3)).join(',')},$20,$21)`,[l.id,sid,...meta,b.transport_required==='true'||b.transport_required===true,req.user.user_id]);
if(clean(b.guardian_phone)){
 const phone=clean(b.guardian_phone),first=clean(b.guardian_first_name),last=clean(b.guardian_last_name);
 let guardian=(await c.query(`SELECT id FROM parent_guardians WHERE school_id=$1 AND lower(trim(phone))=lower($2) AND lower(trim(first_name))=lower($3) AND lower(trim(last_name))=lower($4) LIMIT 1`,[sid,phone,first,last])).rows[0];
 if(!guardian){guardian=(await c.query(`INSERT INTO parent_guardians(school_id,first_name,last_name,relationship,phone,email,communication_consent,sms_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,[sid,first,last,clean(b.guardian_relationship)||null,phone,clean(b.guardian_email)||null,b.guardian_consent===true||b.guardian_consent==='true'])).rows[0];}
 await c.query(`INSERT INTO learner_guardians(learner_id,parent_guardian_id,is_primary) VALUES($1,$2,true) ON CONFLICT(learner_id,parent_guardian_id) DO UPDATE SET is_primary=true`,[l.id,guardian.id]);
}
if(b.admission_application_id)await c.query(`UPDATE learner_admission_applications SET status='CONFIRMED',learner_id=$3,confirmed_at=now(),updated_at=now() WHERE id=$1 AND school_id=$2`,[b.admission_application_id,sid,l.id]);
await c.query('COMMIT');res.status(201).json(l);}catch(e){await c.query('ROLLBACK');res.status(e.status||400).json({error:e.code==='23505'?'That admission number already exists in this school.':e.message});}finally{c.release();}});
router.get('/:schoolId/classes',schoolBoundary,async(req,res)=>{try{res.json((await db.query(`SELECT c.*,lv.name level_name,ss.name section_name,(SELECT count(*) FROM learners l WHERE l.class_id=c.id AND l.is_active) learner_count FROM classes c JOIN school_levels lv ON lv.id=c.school_level_id JOIN school_sections ss ON ss.id=lv.school_section_id WHERE c.school_id=$1 AND c.is_active=true ORDER BY ss.sort_order,lv.sort_order,c.name,c.stream`,[req.params.schoolId])).rows)}catch(e){res.status(500).json({error:'Unable to load classes'});}});
router.post('/:schoolId/classes',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body;try{await assertBelongs('school_levels',b.school_level_id,req.params.schoolId);if(!clean(b.name))return res.status(400).json({error:'Class name is required'});const q=await db.query(`INSERT INTO classes(school_id,school_level_id,name,stream) VALUES($1,$2,$3,$4) RETURNING *`,[req.params.schoolId,b.school_level_id,clean(b.name),clean(b.stream)]);res.status(201).json(q.rows[0]);}catch(e){res.status(e.status||400).json({error:e.code==='23505'?'That class and stream already exist.':e.message});}});
// Remove an incorrectly-created class safely. A class with historical/current data is archived instead of hard-deleted.
router.patch('/:schoolId/classes/:classId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body||{},sid=req.params.schoolId;try{await assertBelongs('classes',req.params.classId,sid);const name=clean(b.name),stream=clean(b.stream);if(!name)return res.status(400).json({error:'Class name is required'});if(b.school_level_id)await assertBelongs('school_levels',b.school_level_id,sid);const q=await db.query(`UPDATE classes SET name=$3,stream=$4,school_level_id=COALESCE($5,school_level_id) WHERE id=$1 AND school_id=$2 RETURNING *`,[req.params.classId,sid,name,stream||null,b.school_level_id||null]);if(!q.rows[0])return res.status(404).json({error:'Class not found'});res.json(q.rows[0]);}catch(e){res.status(e.status||400).json({error:e.code==='23505'?'That class and stream already exist.':e.message});}});

router.delete('/:schoolId/classes/:classId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const sid=req.params.schoolId,c=await db.pool.connect();
 try{
  const cls=(await c.query('SELECT id,name,stream,is_active FROM classes WHERE id=$1 AND school_id=$2',[req.params.classId,sid])).rows[0];
  if(!cls)return res.status(404).json({error:'Class not found'});
  const counts=(await c.query(`SELECT
    (SELECT count(*) FROM learners WHERE class_id=$1) learners,
    (SELECT count(*) FROM learner_enrollments WHERE class_id=$1) enrollments,
    (SELECT count(*) FROM marks WHERE class_id=$1) marks,
    (SELECT count(*) FROM teacher_subject_assignments WHERE class_id=$1) assignments,
    (SELECT count(*) FROM class_teacher_assignments WHERE class_id=$1) class_teachers,
    (SELECT count(*) FROM learner_movement_events WHERE from_class_id=$1 OR to_class_id=$1) movements`,[cls.id])).rows[0];
  const used=Object.values(counts).some(v=>Number(v)>0);
  if(used){
    await c.query('UPDATE classes SET is_active=false WHERE id=$1 AND school_id=$2',[cls.id,sid]);
    return res.json({ok:true,action:'ARCHIVED',message:'This class has academic/history records, so it was archived rather than deleted.'});
  }
  await c.query('DELETE FROM classes WHERE id=$1 AND school_id=$2',[cls.id,sid]);
  res.json({ok:true,action:'DELETED',message:'Class removed successfully.'});
 }catch(e){res.status(400).json({error:e.message});}finally{c.release();}
});
router.patch('/:schoolId/classes/:classId/status',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const active=req.body.is_active!==false;const q=await db.query('UPDATE classes SET is_active=$3 WHERE id=$1 AND school_id=$2 RETURNING *',[req.params.classId,req.params.schoolId,active]);if(!q.rows[0])return res.status(404).json({error:'Class not found'});res.json(q.rows[0]);}catch(e){res.status(400).json({error:e.message});}});

router.get('/:schoolId/subjects',schoolBoundary,async(req,res)=>{try{res.json((await db.query(`SELECT * FROM subjects WHERE school_id=$1 AND is_active ORDER BY name`,[req.params.schoolId])).rows)}catch(e){res.status(500).json({error:'Unable to load subjects'});}});
router.post('/:schoolId/subjects',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body;try{const code=clean(b.code).toUpperCase(),name=clean(b.name);if(!code||!name)return res.status(400).json({error:'Subject code and name are required'});const q=await db.query(`INSERT INTO subjects(school_id,code,name,subject_type) VALUES($1,$2,$3,$4) RETURNING *`,[req.params.schoolId,code,name,clean(b.subject_type)||'LEARNING_AREA']);res.status(201).json(q.rows[0]);}catch(e){res.status(400).json({error:e.code==='23505'?'That subject code already exists.':e.message});}});
router.get('/:schoolId/assignments',schoolBoundary,async(req,res)=>{try{const sid=req.params.schoolId;let teacherId=null;if(['TEACHER','CLASS_TEACHER'].includes(req.user.role)){const teacher=(await db.query(`SELECT id FROM teachers WHERE school_id=$1 AND user_id=$2 AND COALESCE(is_active,true)=true LIMIT 1`,[sid,req.user.user_id])).rows[0];if(!teacher)return res.status(403).json({error:'No active teacher profile is linked to this account.'});teacherId=teacher.id;}res.json((await db.query(`SELECT a.*,t.staff_no,t.first_name teacher_first_name,t.last_name teacher_last_name,s.code subject_code,s.name subject_name,c.name class_name,c.stream,lv.name level_name,ay.year_label,tm.name term_name FROM teacher_subject_assignments a JOIN teachers t ON t.id=a.teacher_id JOIN subjects s ON s.id=a.subject_id JOIN classes c ON c.id=a.class_id JOIN school_levels lv ON lv.id=c.school_level_id JOIN academic_years ay ON ay.id=a.academic_year_id LEFT JOIN terms tm ON tm.id=a.term_id WHERE a.school_id=$1 AND ($2::uuid IS NULL OR a.teacher_id=$2) ORDER BY ay.year_label DESC,c.name,s.name,t.last_name`,[sid,teacherId])).rows)}catch(e){res.status(e.status||500).json({error:'Unable to load assignments'});}});
router.post('/:schoolId/assignments',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body||{},sid=req.params.schoolId;try{if(!b.teacher_id||!b.subject_id||!b.class_id||!b.academic_year_id)return res.status(400).json({error:'Teacher, subject, class and academic year are required.'});await assertBelongs('teachers',b.teacher_id,sid);await assertBelongs('subjects',b.subject_id,sid);await assertBelongs('classes',b.class_id,sid);await assertBelongs('academic_years',b.academic_year_id,sid);if(b.term_id)await assertBelongs('terms',b.term_id,sid);const existing=(await db.query(`SELECT id FROM teacher_subject_assignments WHERE school_id=$1 AND teacher_id=$2 AND subject_id=$3 AND class_id=$4 AND academic_year_id=$5 AND term_id IS NOT DISTINCT FROM $6::uuid LIMIT 1`,[sid,b.teacher_id,b.subject_id,b.class_id,b.academic_year_id,b.term_id||null])).rows[0];let q;if(existing){q=await db.query(`UPDATE teacher_subject_assignments SET is_active=true WHERE id=$1 RETURNING *`,[existing.id]);}else{q=await db.query(`INSERT INTO teacher_subject_assignments(school_id,teacher_id,subject_id,class_id,academic_year_id,term_id,is_class_teacher,is_active) VALUES($1,$2,$3,$4,$5,$6,false,true) RETURNING *`,[sid,b.teacher_id,b.subject_id,b.class_id,b.academic_year_id,b.term_id||null]);}res.status(201).json(q.rows[0]);}catch(e){res.status(e.status||400).json({error:e.message});}});
router.get('/:schoolId/class-teachers',schoolBoundary,async(req,res)=>{try{const sid=req.params.schoolId;let teacherId=null;if(req.user.role==='CLASS_TEACHER'){const teacher=(await db.query(`SELECT id FROM teachers WHERE school_id=$1 AND user_id=$2 AND COALESCE(is_active,true)=true LIMIT 1`,[sid,req.user.user_id])).rows[0];if(!teacher)return res.status(403).json({error:'No active teacher profile is linked to this account.'});teacherId=teacher.id;}res.json((await db.query(`SELECT * FROM (SELECT DISTINCT ON (a.class_id,a.academic_year_id) a.*,t.staff_no,t.first_name teacher_first_name,t.last_name teacher_last_name,c.name class_name,c.stream,lv.name level_name,ay.year_label,tm.name term_name FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id JOIN classes c ON c.id=a.class_id JOIN school_levels lv ON lv.id=c.school_level_id JOIN academic_years ay ON ay.id=a.academic_year_id LEFT JOIN terms tm ON tm.id=a.term_id WHERE a.school_id=$1 AND ($2::uuid IS NULL OR a.teacher_id=$2) ORDER BY a.class_id,a.academic_year_id,a.created_at DESC,a.id DESC) z ORDER BY year_label DESC,class_name,teacher_last_name`,[sid,teacherId])).rows)}catch(e){res.status(e.status||500).json({error:'Unable to load class teachers'});}});
router.post('/:schoolId/class-teachers',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body||{},sid=req.params.schoolId,c=await db.pool.connect();try{if(!b.teacher_id||!b.class_id||!b.academic_year_id)return res.status(400).json({error:'Teacher, class and academic year are required.'});await assertBelongs('teachers',b.teacher_id,sid);await assertBelongs('classes',b.class_id,sid);await assertBelongs('academic_years',b.academic_year_id,sid);if(b.term_id)await assertBelongs('terms',b.term_id,sid);await c.query('BEGIN');const t=(await c.query(`SELECT id,user_id,is_active FROM teachers WHERE id=$1 AND school_id=$2`,[b.teacher_id,sid])).rows[0];if(!t?.is_active)throw Object.assign(new Error('The selected teacher is inactive.'),{status:400});if(!t.user_id)throw Object.assign(new Error('The selected teacher must have a linked ZELIMU CBC login before becoming a Class Teacher.'),{status:400});
// A Class Teacher is one school role, not a second parallel role. Existing subject assignments remain intact.
await c.query(`DELETE FROM user_school_roles WHERE user_id=$1 AND school_id=$2`,[t.user_id,sid]);
await c.query(`INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled) VALUES($1,$2,'CLASS_TEACHER',true)`,[t.user_id,sid]);
// Exactly one Class Teacher per class/year/term. Reassigning replaces the previous one.
await c.query(`DELETE FROM class_teacher_assignments WHERE school_id=$1 AND class_id=$2 AND academic_year_id=$3`,[sid,b.class_id,b.academic_year_id]);
const q=await c.query(`INSERT INTO class_teacher_assignments(school_id,teacher_id,class_id,academic_year_id,term_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,[sid,b.teacher_id,b.class_id,b.academic_year_id,b.term_id||null]);
// A Class Teacher remains a single school role; the teacher's subject assignments are not deleted.
await c.query('COMMIT');res.status(201).json(q.rows[0]);}catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}finally{c.release();}});

router.get('/:schoolId/my-class-teacher-assignments',schoolBoundary,roles('CLASS_TEACHER','TEACHER','SENIOR_TEACHER'),async(req,res)=>{try{
 const q=await db.query(`SELECT * FROM (SELECT DISTINCT ON (a.class_id,a.academic_year_id) a.id,a.teacher_id,a.class_id,a.academic_year_id,a.term_id,c.name class_name,c.stream,lv.name level_name,ay.year_label,tm.name term_name FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id JOIN classes c ON c.id=a.class_id JOIN school_levels lv ON lv.id=c.school_level_id JOIN academic_years ay ON ay.id=a.academic_year_id LEFT JOIN terms tm ON tm.id=a.term_id WHERE a.school_id=$1 AND t.user_id=$2 ORDER BY a.class_id,a.academic_year_id,a.created_at DESC,a.id DESC) z ORDER BY year_label DESC,class_name`,[req.params.schoolId,req.user.user_id]);res.json(q.rows);
}catch(e){res.status(e.status||400).json({error:e.message});}});

router.get('/:schoolId/teacher-assignments/:teacherId',schoolBoundary,async(req,res)=>{
  try{
    await assertBelongs('teachers',req.params.teacherId,req.params.schoolId);
    const q=await db.query(`
      SELECT a.id,a.school_id,a.teacher_id,a.subject_id,a.class_id,a.academic_year_id,
             a.term_id,
             s.code subject_code,s.name subject_name,c.name class_name,c.stream,
             lv.name level_name,ay.year_label,tm.name AS term_name
      FROM teacher_subject_assignments a
      JOIN subjects s ON s.id=a.subject_id
      JOIN classes c ON c.id=a.class_id
      JOIN school_levels lv ON lv.id=c.school_level_id
      JOIN academic_years ay ON ay.id=a.academic_year_id LEFT JOIN terms tm ON tm.id=a.term_id
      WHERE a.school_id=$1 AND a.teacher_id=$2
      ORDER BY ay.year_label DESC,c.name,s.name`,
      [req.params.schoolId,req.params.teacherId]
    );
    res.json(q.rows);
  }catch(e){res.status(e.status||400).json({error:e.message});}
});

router.get('/:schoolId/classes/:classId/pdf',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,cid=req.params.classId;
  const c=(await db.query(`SELECT c.id,c.name,c.stream,lv.name level_name,sc.name school_name,si.motto,si.address,si.contact_phone,si.primary_color,si.secondary_color,si.logo_url,COALESCE(si.watermark_enabled,true) watermark_enabled
    FROM classes c JOIN school_levels lv ON lv.id=c.school_level_id JOIN schools sc ON sc.id=c.school_id
    LEFT JOIN school_identity si ON si.school_id=c.school_id WHERE c.id=$1 AND c.school_id=$2`,[cid,sid])).rows[0];
  if(!c)return res.status(404).json({error:'Class not found'});
  const yearId=req.query.academic_year_id;
  if(!yearId)return res.status(400).json({error:'Academic year is required for a class register PDF.'});
  await assertBelongs('academic_years',yearId,sid);
  const cachedPdf=null;if(cachedPdf){res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Length',String(cachedPdf.length));res.setHeader('Content-Disposition',`inline; filename="class-list-${String(c.name||'class').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.pdf"`);return res.end(cachedPdf);}
  if(req.user.role==='CLASS_TEACHER'){
   const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND t.user_id=$3 LIMIT 1`,[sid,cid,req.user.user_id])).rows[0];
   if(!ok)return res.status(403).json({error:'You can only print a class list for a class assigned to you.'});
  }
  const rows=(await db.query(`SELECT l.admission_no,l.assessment_no,l.first_name,l.middle_name,l.last_name,l.gender,e.status
    FROM learner_enrollments e JOIN learners l ON l.id=e.learner_id AND l.school_id=e.school_id
    WHERE e.school_id=$1 AND e.class_id=$2 AND e.academic_year_id=$3
    ORDER BY l.last_name,l.first_name,l.id`,[sid,cid,yearId])).rows;
  const PDFDocument=require('pdfkit');
  const doc=new PDFDocument({size:'A4',layout:'landscape',margin:28});
  const chunks=[];doc.on('data',x=>chunks.push(x));
  const done=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const W=doc.page.width-doc.page.margins.left-doc.page.margins.right,X=doc.page.margins.left;
  const navy=c.primary_color||'#17365D',gold=c.secondary_color||'#B8860B';
  const logo=assetSource(c.logo_url);
  const drawBranding=()=>{if(c.watermark_enabled!==false){try{if(logo){doc.save().opacity(.045);doc.image(logo,doc.page.width/2-130,doc.page.height/2-130,{fit:[260,260],align:'center',valign:'center'});doc.restore();}else{doc.save().opacity(.04).fillColor('#334155').font('Helvetica-Bold').fontSize(30).text(c.school_name||'SCHOOL',X,doc.page.height/2-20,{width:W,align:'center',lineBreak:false});doc.restore();}}catch{try{doc.restore()}catch{}}}if(logo){try{doc.image(logo,X,28,{fit:[48,48],align:'left',valign:'center'});}catch{}}};
  const headers=['#','ADM. NO.','ASSES. NO.','LEARNER NAME','SEX','STATUS','TERM 1','TERM 2','TERM 3','ATTENDANCE','REMARKS'];
  const raw=[28,72,72,185,45,55,62,62,62,72,90],scale=W/raw.reduce((a,b)=>a+b,0),widths=raw.map(v=>v*scale);
  let pageNo=0,rowIndex=0;
  const pageHeader=()=>{
   pageNo++;
   drawBranding();
   doc.save().strokeColor(gold).lineWidth(1.1).roundedRect(18,18,doc.page.width-36,doc.page.height-36,6).stroke().restore();
   doc.fillColor(navy).font('Helvetica-Bold').fontSize(15).text(c.school_name||'SCHOOL',X,32,{width:W,align:'center'});
   doc.fillColor('#374151').font('Helvetica').fontSize(8).text(c.motto||'',X,51,{width:W,align:'center'});
   doc.fillColor(navy).font('Helvetica-Bold').fontSize(10).text(`CLASS REGISTER · ${c.level_name||''} ${c.name||''}${c.stream?' · '+c.stream:''}`,X,67,{width:W,align:'center'});
   doc.fillColor('#374151').font('Helvetica').fontSize(7).text(`${rows.length} learner(s) · Page ${pageNo}`,X,82,{width:W,align:'center'});
   let y=98,xx=X;doc.fillColor(navy).rect(X,y,W,21).fill();
   headers.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(6.5).text(h,xx+3,y+7,{width:widths[i]-6,align:i===0?'center':'left',lineBreak:false});xx+=widths[i];});
   return y+21;
  };
  let y=pageHeader();
  rows.forEach((r,i)=>{
   if(y+21>doc.page.height-36){doc.addPage({size:'A4',layout:'landscape',margin:28});y=pageHeader();}
   const vals=[String(i+1),r.admission_no||'',r.assessment_no||'',[r.first_name,r.middle_name,r.last_name].filter(Boolean).join(' '),r.gender||'',r.status||'ACTIVE','','','','',''];
   let xx=X;doc.font('Helvetica').fontSize(7.1);
   vals.forEach((v,j)=>{doc.fillColor('#111827').text(String(v),xx+3,y+7,{width:widths[j]-6,height:15,align:j===0?'center':'left',lineBreak:false});doc.strokeColor('#111827').lineWidth(.55).rect(xx,y,widths[j],21).stroke();xx+=widths[j];});
   y+=21;rowIndex++;
  });
  doc.fillColor('#475569').font('Helvetica').fontSize(6.5).text(`ZELIMU CBC · ${c.school_name||'School'} · Class Register · Total learners: ${rows.length}`,X,doc.page.height-28,{width:W,align:'right'});
  doc.end();
  const pdf=await done;if(!pdf||!pdf.length)throw new Error('The class register PDF was generated empty.');
  putClassListPdf(`${sid}|${cid}`,pdf);
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Length',String(pdf.length));res.setHeader('Content-Disposition',`inline; filename="class-list-${String(c.name||'class').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.pdf"`);res.end(pdf);
 }catch(e){console.error('Class list PDF failed:',e);if(!res.headersSent)res.status(e.status||500).json({error:e.message||'Unable to create class list PDF'});}
});
module.exports=router;