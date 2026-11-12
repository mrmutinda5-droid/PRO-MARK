const express=require('express');
const db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const router=express.Router();
const ADMIN=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'];
router.use(authenticate);
const permitted=[schoolBoundary,roles(...ADMIN)];
const fail=(res,e)=>res.status(e.status||400).json({error:e.message});
router.get('/:schoolId/summary',...permitted,async(req,res)=>{try{
 const sid=req.params.schoolId;
 const [devices,events,links]=await Promise.all([
 db.query('SELECT id,name,manufacturer,model,connection_type,status,last_seen_at,created_at FROM biometric_devices WHERE school_id=$1 ORDER BY created_at DESC',[sid]),
 db.query('SELECT id,person_type,person_id,event_type,event_time,source,device_id,verification_status,created_at FROM biometric_attendance_events WHERE school_id=$1 ORDER BY event_time DESC LIMIT 100',[sid]),
 db.query('SELECT person_type,count(*)::int count FROM biometric_person_links WHERE school_id=$1 GROUP BY person_type',[sid])]);
 res.json({integration_status:'NOT_CONNECTED',devices:devices.rows,events:events.rows,linked_people:links.rows,privacy:'No fingerprint images, face images or biometric templates are stored by this module.'});
 }catch(e){fail(res,e)}});
router.post('/:schoolId/devices',...permitted,async(req,res)=>{try{
 const b=req.body||{},name=String(b.name||'').trim(),manufacturer=String(b.manufacturer||'').trim(),model=String(b.model||'').trim();
 if(!name||name.length>100||manufacturer.length>100||model.length>100)return res.status(400).json({error:'Device name is required; fields must be under 100 characters.'});
 const q=await db.query(`INSERT INTO biometric_devices(school_id,name,manufacturer,model,connection_type,status,created_by) VALUES($1,$2,$3,$4,'UNCONFIGURED','PLANNED',$5) RETURNING id,name,manufacturer,model,connection_type,status,created_at`,[req.params.schoolId,name,manufacturer,model,req.user.user_id]);
 res.status(201).json(q.rows[0]);
 }catch(e){fail(res,e)}});
router.patch('/:schoolId/devices/:deviceId',...permitted,async(req,res)=>{try{
 const b=req.body||{},name=String(b.name||'').trim();if(!name||name.length>100)return res.status(400).json({error:'Valid device name required.'});
 const q=await db.query(`UPDATE biometric_devices SET name=$3,manufacturer=$4,model=$5,updated_at=now() WHERE school_id=$1 AND id=$2 RETURNING id,name,manufacturer,model,status`,[req.params.schoolId,req.params.deviceId,name,String(b.manufacturer||'').slice(0,100),String(b.model||'').slice(0,100)]);
 if(!q.rows.length)return res.status(404).json({error:'Device not found in this school'});res.json(q.rows[0]);
 }catch(e){fail(res,e)}});
router.delete('/:schoolId/devices/:deviceId',...permitted,async(req,res)=>{try{
 const q=await db.query('DELETE FROM biometric_devices WHERE school_id=$1 AND id=$2 AND status=\'PLANNED\' RETURNING id',[req.params.schoolId,req.params.deviceId]);
 if(!q.rows.length)return res.status(409).json({error:'Only planned devices can be removed.'});res.json({deleted:true});
 }catch(e){fail(res,e)}});
router.post('/:schoolId/manual-attendance',...permitted,async(req,res)=>{try{
 const b=req.body||{},type=String(b.person_type||'').toUpperCase(),kind=String(b.event_type||'').toUpperCase();
 if(!['LEARNER','STAFF'].includes(type)||!['CHECK_IN','CHECK_OUT'].includes(kind))return res.status(400).json({error:'Select learner/staff and check-in/check-out.'});
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(String(b.person_id||'')))return res.status(400).json({error:'A valid learner or teacher ID is required.'});
 const table=type==='LEARNER'?'learners':'teachers';
 const found=await db.query(`SELECT id FROM ${table} WHERE school_id=$1 AND id=$2 AND is_active=true`,[req.params.schoolId,b.person_id]);
 if(!found.rows.length)return res.status(404).json({error:'Person not found in this school'});
 const q=await db.query(`INSERT INTO biometric_attendance_events(school_id,person_type,person_id,event_type,event_time,source,verification_status,recorded_by) VALUES($1,$2,$3,$4,now(),'MANUAL','NOT_BIOMETRIC',$5) RETURNING id,person_type,person_id,event_type,event_time,source,verification_status`,[req.params.schoolId,type,b.person_id,kind,req.user.user_id]);
 res.status(201).json(q.rows[0]);
 }catch(e){fail(res,e)}});
// Deliberately no public device-ingestion endpoint until a specific device adapter,
// signed authentication, replay protection and consent/retention controls are implemented.
module.exports=router;
