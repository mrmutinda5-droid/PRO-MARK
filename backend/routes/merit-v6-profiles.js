'use strict';
// Opt-in profile administration. Does not alter existing merit/report endpoints.
const express=require('express'),db=require('../db');
const {authenticate,schoolBoundary,roles}=require('../middleware/auth');
const {parseProfileInput}=require('../services/merit-v6-profiles');
const router=express.Router();
router.use(authenticate);
const admins=roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER');
const viewers=roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER');
function fail(res,e){res.status(e.status||500).json({error:e.status?e.message:'Unable to process merit weighting profiles.'});}
async function verifyScope(client,sid,yearId,termId,classId){
 const year=(await client.query('SELECT 1 FROM academic_years WHERE id=$1 AND school_id=$2',[yearId,sid])).rowCount;
 const term=(await client.query('SELECT 1 FROM terms WHERE id=$1 AND academic_year_id=$2 AND school_id=$3',[termId,yearId,sid])).rowCount;
 if(!year||!term)throw Object.assign(new Error('Academic year or term does not belong to this school.'),{status:400});
 if(classId){const cls=(await client.query('SELECT 1 FROM classes WHERE id=$1 AND school_id=$2',[classId,sid])).rowCount;
  if(!cls)throw Object.assign(new Error('Class does not belong to this school.'),{status:400});}
}
router.get('/:schoolId',schoolBoundary,viewers,async(req,res)=>{
 try{const sid=req.params.schoolId,{academic_year_id:y,term_id:t}=req.query;
  if(!y||!t)return res.status(400).json({error:'Academic year and term are required.'});
  await verifyScope(db,sid,y,t,null);
  const q=await db.query('SELECT id,school_id,academic_year_id,term_id,class_id,weights,updated_at FROM merit_weight_profiles WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 ORDER BY class_id NULLS FIRST',[sid,y,t]);
  res.json({profiles:q.rows});
 }catch(e){fail(res,e);}
});
router.put('/:schoolId',schoolBoundary,admins,async(req,res)=>{
 const client=await db.pool.connect().catch(()=>null);
 if(!client)return res.status(503).json({error:'Database unavailable.'});
 try{const sid=req.params.schoolId,p=parseProfileInput(req.body);
  await client.query('BEGIN');await verifyScope(client,sid,p.academic_year_id,p.term_id,p.class_id);
  // Advisory transaction lock prevents simultaneous inserts into the same scope.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[sid,p.academic_year_id+'|'+p.term_id+'|'+(p.class_id||'default')]);
  const old=await client.query('SELECT id FROM merit_weight_profiles WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND class_id IS NOT DISTINCT FROM $4::uuid FOR UPDATE',[sid,p.academic_year_id,p.term_id,p.class_id]);
  const q=old.rows.length
   ?await client.query('UPDATE merit_weight_profiles SET weights=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING id,school_id,academic_year_id,term_id,class_id,weights,updated_at',[old.rows[0].id,JSON.stringify(p.weights)])
   :await client.query('INSERT INTO merit_weight_profiles(school_id,academic_year_id,term_id,class_id,weights) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,school_id,academic_year_id,term_id,class_id,weights,updated_at',[sid,p.academic_year_id,p.term_id,p.class_id,JSON.stringify(p.weights)]);
  await client.query('COMMIT');res.json({profile:q.rows[0]});
 }catch(e){await client.query('ROLLBACK').catch(()=>{});fail(res,e);}finally{client.release();}
});
module.exports=router;
