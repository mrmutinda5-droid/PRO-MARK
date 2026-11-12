'use strict';

const express=require('express');
const PDFDocument=require('pdfkit');
const crypto=require('crypto');
const db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {source:assetSource}=require('../services/assets');
const {validateCertificateDraft,assertCertificateTransition}=require('../services/school-certificates');

const router=express.Router();
const VIEW=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'];
const WRITE=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'];
const ISSUE=['SCHOOL_ADMIN','ADMIN','HEADTEACHER'];
const certificateNumber=/^ZAC-\d{4}-[A-F0-9]{24}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean=(value,max=250)=>String(value??'').trim().slice(0,max);

router.get('/verify',async(req,res)=>{
 try{
  const number=clean(req.query.certificate_no,40).toUpperCase();
  const admission=clean(req.query.admission_no,100);
  if(!certificateNumber.test(number)||!admission)return res.status(400).json({error:'Enter the certificate reference and learner admission number.'});
  const record=(await db.query(`SELECT c.certificate_no,c.title,c.issued_on,c.status,s.name school_name
    FROM school_academic_certificates c
    JOIN schools s ON s.id=c.school_id
    JOIN learners l ON l.id=c.learner_id AND l.school_id=c.school_id
    WHERE c.certificate_no=$1 AND upper(l.admission_no)=upper($2)
      AND c.status IN ('ISSUED','REVOKED')`,[number,admission])).rows[0];
  if(!record)return res.status(404).json({valid:false,error:'No matching issued certificate was found.'});
  res.json({valid:record.status==='ISSUED',status:record.status,certificate_no:record.certificate_no,title:record.title,issued_on:record.issued_on,school_name:record.school_name});
 }catch(error){console.error('Verify academic certificate failed:',error);res.status(500).json({error:'Unable to verify this certificate right now.'});}
});

router.use(authenticate);

router.get('/:schoolId/academic-certificates',schoolBoundary,roles(...VIEW),async(req,res)=>{
 try{
  const status=String(req.query.status||'').toUpperCase();
  if(status&&!['DRAFT','ISSUED','REVOKED'].includes(status))return res.status(400).json({error:'Invalid certificate status filter.'});
  const rows=await db.query(`SELECT c.id,c.learner_id,c.certificate_no,c.category,c.title,c.achievement_statement,c.status,c.issued_on,
      c.academic_year_id,c.term_id,c.created_at,c.issued_at,c.revoked_at,c.revocation_reason,
      l.admission_no,l.first_name,l.middle_name,l.last_name,
      ay.year_label,t.term_no,t.name term_name,
      creator.first_name creator_first_name,creator.last_name creator_last_name,
      issuer.first_name issuer_first_name,issuer.last_name issuer_last_name
    FROM school_academic_certificates c
    JOIN learners l ON l.id=c.learner_id AND l.school_id=c.school_id
    LEFT JOIN academic_years ay ON ay.id=c.academic_year_id AND ay.school_id=c.school_id
    LEFT JOIN terms t ON t.id=c.term_id AND t.school_id=c.school_id
    LEFT JOIN users creator ON creator.id=c.created_by
    LEFT JOIN users issuer ON issuer.id=c.issued_by
    WHERE c.school_id=$1 AND ($2::text IS NULL OR c.status=$2)
    ORDER BY c.created_at DESC LIMIT 500`,[req.params.schoolId,status||null]);
  res.json(rows.rows);
 }catch(error){console.error('Load academic certificates failed:',error);res.status(500).json({error:'Unable to load academic certificates. Apply migration 040_academic_certificates.sql.'});}
});

router.post('/:schoolId/academic-certificates',schoolBoundary,roles(...WRITE),async(req,res)=>{
 let input;
 try{input=validateCertificateDraft(req.body);}catch(error){return res.status(error.status||400).json({error:error.message});}
 try{
  const sid=req.params.schoolId;
  const learner=await db.query('SELECT id FROM learners WHERE school_id=$1 AND id=$2',[sid,input.learner_id]);
  if(!learner.rowCount)return res.status(404).json({error:'Learner not found in this school.'});
  if(input.academic_year_id){
   const year=await db.query('SELECT id FROM academic_years WHERE school_id=$1 AND id=$2',[sid,input.academic_year_id]);
   if(!year.rowCount)return res.status(400).json({error:'Academic year does not belong to this school.'});
  }
  if(input.term_id){
   const term=await db.query('SELECT academic_year_id FROM terms WHERE school_id=$1 AND id=$2',[sid,input.term_id]);
   if(!term.rowCount)return res.status(400).json({error:'Term does not belong to this school.'});
   if(input.academic_year_id&&String(term.rows[0].academic_year_id)!==String(input.academic_year_id))
    return res.status(400).json({error:'Selected term does not belong to the selected academic year.'});
   input.academic_year_id=input.academic_year_id||term.rows[0].academic_year_id;
  }
  const client=await db.pool.connect();
  try{
   await client.query('BEGIN');
   const number=`ZAC-${new Date().getUTCFullYear()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
   const row=(await client.query(`INSERT INTO school_academic_certificates
      (school_id,learner_id,academic_year_id,term_id,certificate_no,category,title,achievement_statement,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [sid,input.learner_id,input.academic_year_id,input.term_id,number,input.category,input.title,input.achievement_statement,req.user.user_id])).rows[0];
   await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
      VALUES($1,$2,'ACADEMIC_CERTIFICATE_DRAFT_CREATED','school_academic_certificate',$3,$4::jsonb)`,
    [sid,req.user.user_id,row.id,JSON.stringify({certificate_no:number,learner_id:input.learner_id,title:input.title})]);
   await client.query('COMMIT');
   res.status(201).json(row);
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
  finally{client.release();}
 }catch(error){console.error('Create academic certificate draft failed:',error);res.status(500).json({error:'Unable to create certificate draft.'});}
});

router.patch('/:schoolId/academic-certificates/:certificateId',schoolBoundary,roles(...WRITE),async(req,res)=>{
 if(!uuid.test(req.params.certificateId))return res.status(400).json({error:'Invalid certificate ID.'});
 let input;
 try{input=validateCertificateDraft(req.body);}catch(error){return res.status(error.status||400).json({error:error.message});}
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');
  const current=(await client.query('SELECT * FROM school_academic_certificates WHERE school_id=$1 AND id=$2 FOR UPDATE',[req.params.schoolId,req.params.certificateId])).rows[0];
  if(!current){await client.query('ROLLBACK');return res.status(404).json({error:'Certificate not found.'});}
  if(current.status!=='DRAFT')throw Object.assign(new Error('Only draft certificates can be edited.'),{status:409});
  const learner=await client.query('SELECT id FROM learners WHERE school_id=$1 AND id=$2',[req.params.schoolId,input.learner_id]);
  if(!learner.rowCount)throw Object.assign(new Error('Learner not found in this school.'),{status:400});
  if(input.academic_year_id&&!((await client.query('SELECT id FROM academic_years WHERE school_id=$1 AND id=$2',[req.params.schoolId,input.academic_year_id])).rowCount))
   throw Object.assign(new Error('Academic year does not belong to this school.'),{status:400});
  if(input.term_id){
   const term=(await client.query('SELECT academic_year_id FROM terms WHERE school_id=$1 AND id=$2',[req.params.schoolId,input.term_id])).rows[0];
   if(!term)throw Object.assign(new Error('Term does not belong to this school.'),{status:400});
   if(input.academic_year_id&&String(term.academic_year_id)!==String(input.academic_year_id))throw Object.assign(new Error('Selected term does not belong to the selected academic year.'),{status:400});
   input.academic_year_id=input.academic_year_id||term.academic_year_id;
  }
  const updated=(await client.query(`UPDATE school_academic_certificates SET learner_id=$3,academic_year_id=$4,term_id=$5,category=$6,title=$7,achievement_statement=$8,updated_at=now()
    WHERE school_id=$1 AND id=$2 RETURNING *`,
   [req.params.schoolId,current.id,input.learner_id,input.academic_year_id,input.term_id,input.category,input.title,input.achievement_statement])).rows[0];
  await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
    VALUES($1,$2,'ACADEMIC_CERTIFICATE_DRAFT_UPDATED','school_academic_certificate',$3,$4::jsonb)`,
   [req.params.schoolId,req.user.user_id,current.id,JSON.stringify({certificate_no:current.certificate_no,previous_title:current.title,title:input.title})]);
  await client.query('COMMIT');res.json(updated);
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  if(error.status)return res.status(error.status).json({error:error.message});
  console.error('Update academic certificate draft failed:',error);res.status(500).json({error:'Unable to update certificate draft.'});
 }finally{client.release();}
});

router.post('/:schoolId/academic-certificates/:certificateId/issue',schoolBoundary,roles(...ISSUE),async(req,res)=>{
 if(!uuid.test(req.params.certificateId))return res.status(400).json({error:'Invalid certificate ID.'});
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');
  const current=(await client.query('SELECT * FROM school_academic_certificates WHERE school_id=$1 AND id=$2 FOR UPDATE',[req.params.schoolId,req.params.certificateId])).rows[0];
  if(!current){await client.query('ROLLBACK');return res.status(404).json({error:'Certificate not found.'});}
  assertCertificateTransition(current.status,'ISSUED');
  const issued=(await client.query(`UPDATE school_academic_certificates SET status='ISSUED',issued_on=CURRENT_DATE,issued_by=$3,issued_at=now(),updated_at=now()
    WHERE school_id=$1 AND id=$2 RETURNING *`,[req.params.schoolId,current.id,req.user.user_id])).rows[0];
  await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
    VALUES($1,$2,'ACADEMIC_CERTIFICATE_ISSUED','school_academic_certificate',$3,$4::jsonb)`,
   [req.params.schoolId,req.user.user_id,current.id,JSON.stringify({certificate_no:current.certificate_no})]);
  await client.query('COMMIT');res.json(issued);
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  if(error.status)return res.status(error.status).json({error:error.message});
  console.error('Issue academic certificate failed:',error);res.status(500).json({error:'Unable to issue certificate.'});
 }finally{client.release();}
});

router.post('/:schoolId/academic-certificates/:certificateId/revoke',schoolBoundary,roles(...ISSUE),async(req,res)=>{
 if(!uuid.test(req.params.certificateId))return res.status(400).json({error:'Invalid certificate ID.'});
 const reason=clean(req.body?.reason,500);
 if(reason.length<4)return res.status(400).json({error:'Provide a revocation reason of at least four characters.'});
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');
  const current=(await client.query('SELECT * FROM school_academic_certificates WHERE school_id=$1 AND id=$2 FOR UPDATE',[req.params.schoolId,req.params.certificateId])).rows[0];
  if(!current){await client.query('ROLLBACK');return res.status(404).json({error:'Certificate not found.'});}
  assertCertificateTransition(current.status,'REVOKED');
  const revoked=(await client.query(`UPDATE school_academic_certificates SET status='REVOKED',revoked_by=$3,revoked_at=now(),revocation_reason=$4,updated_at=now()
    WHERE school_id=$1 AND id=$2 RETURNING *`,[req.params.schoolId,current.id,req.user.user_id,reason])).rows[0];
  await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
    VALUES($1,$2,'ACADEMIC_CERTIFICATE_REVOKED','school_academic_certificate',$3,$4::jsonb)`,
   [req.params.schoolId,req.user.user_id,current.id,JSON.stringify({certificate_no:current.certificate_no,reason})]);
  await client.query('COMMIT');res.json(revoked);
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  if(error.status)return res.status(error.status).json({error:error.message});
  console.error('Revoke academic certificate failed:',error);res.status(500).json({error:'Unable to revoke certificate.'});
 }finally{client.release();}
});

router.get('/:schoolId/academic-certificates/:certificateId/pdf',schoolBoundary,roles(...VIEW),async(req,res)=>{
 try{
  if(!uuid.test(req.params.certificateId))return res.status(400).json({error:'Invalid certificate ID.'});
  const row=(await db.query(`SELECT c.*,l.admission_no,l.first_name,l.middle_name,l.last_name,l.passport_photo_url,
      cl.name class_name,cl.stream,ay.year_label,t.term_no,t.name term_name,
      s.name school_name,s.code school_code,si.logo_url,si.motto,si.address,si.contact_phone,si.contact_email,
      issuer.first_name issuer_first_name,issuer.last_name issuer_last_name,
      (SELECT file_url FROM school_document_assets a WHERE a.school_id=c.school_id AND a.asset_type='STAMP' AND a.is_active=true
       AND a.effective_from<=CURRENT_DATE AND (a.effective_to IS NULL OR a.effective_to>=CURRENT_DATE)
       ORDER BY a.effective_from DESC,a.created_at DESC LIMIT 1) stamp_url
    FROM school_academic_certificates c
    JOIN learners l ON l.id=c.learner_id AND l.school_id=c.school_id
    LEFT JOIN classes cl ON cl.id=l.class_id AND cl.school_id=c.school_id
    LEFT JOIN academic_years ay ON ay.id=c.academic_year_id AND ay.school_id=c.school_id
    LEFT JOIN terms t ON t.id=c.term_id AND t.school_id=c.school_id
    JOIN schools s ON s.id=c.school_id
    LEFT JOIN school_identity si ON si.school_id=c.school_id
    LEFT JOIN users issuer ON issuer.id=c.issued_by
    WHERE c.school_id=$1 AND c.id=$2`,[req.params.schoolId,req.params.certificateId])).rows[0];
  if(!row)return res.status(404).json({error:'Certificate not found.'});
  const pdf=new PDFDocument({size:'A4',margin:52,info:{Title:row.title,Author:row.school_name}});
  const filename=`academic-certificate-${row.certificate_no}.pdf`;
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`inline; filename="${filename}"`);pdf.pipe(res);
  pdf.rect(0,0,595,14).fill('#17365d');
  const logo=assetSource(row.logo_url);
  if(logo){try{pdf.image(logo,275,35,{fit:[45,45]})}catch{}}
  pdf.moveDown(3).fillColor('#17365d').font('Helvetica-Bold').fontSize(21).text(row.school_name,{align:'center'});
  pdf.fillColor('#52647a').font('Helvetica').fontSize(9).text([row.motto,row.address,row.contact_phone,row.contact_email].filter(Boolean).join(' · '),{align:'center'});
  pdf.moveDown(1).fillColor('#52647a').font('Helvetica-Bold').fontSize(9).text(String(row.category||'ACADEMIC_ACHIEVEMENT').replaceAll('_',' '),{align:'center'});
  pdf.moveDown(1).strokeColor('#d9a441').lineWidth(2).moveTo(90,pdf.y).lineTo(505,pdf.y).stroke();
  pdf.moveDown(1.7).fillColor('#17365d').font('Helvetica-Bold').fontSize(24).text(row.title,{align:'center',width:490});
  pdf.moveDown(1.4).fillColor('#334155').font('Helvetica').fontSize(13).text('This certificate is awarded to',{align:'center'});
  pdf.moveDown(.5).fillColor('#111827').font('Helvetica-Bold').fontSize(24).text([row.first_name,row.middle_name,row.last_name].filter(Boolean).join(' '),{align:'center'});
  pdf.moveDown(.4).fillColor('#475569').font('Helvetica').fontSize(10).text(`Admission number: ${row.admission_no}`,{align:'center'});
  pdf.moveDown(1.2).fillColor('#334155').font('Helvetica').fontSize(12).text(row.achievement_statement,{align:'center',width:465,lineGap:5});
  const context=[row.year_label,row.term_no?`Term ${row.term_no}`:row.term_name,[row.class_name,row.stream].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  if(context)pdf.moveDown(1).fontSize(10).fillColor('#52647a').text(context,{align:'center'});
  pdf.moveDown(1.4).fontSize(10).text(`${row.status==='DRAFT'?'DRAFT PREVIEW':`Issued: ${String(row.issued_on).slice(0,10)}`}  ·  Reference: ${row.certificate_no}`,{align:'center'});
  pdf.moveDown(3).strokeColor('#94a3b8').lineWidth(.8).moveTo(85,pdf.y).lineTo(250,pdf.y).stroke();
  pdf.font('Helvetica').fontSize(9).fillColor('#334155').text(row.issuer_first_name?[row.issuer_first_name,row.issuer_last_name].filter(Boolean).join(' '):'Authorised school officer',85,pdf.y+6,{width:165,align:'center'});
  pdf.moveTo(355,pdf.y-12).lineTo(510,pdf.y-12).stroke();
  const stamp=assetSource(row.stamp_url);
  if(stamp){try{pdf.image(stamp,397,pdf.y-70,{fit:[70,48]})}catch{}}
  pdf.font('Helvetica').fontSize(9).fillColor('#334155').text('Official school stamp',355,pdf.y+6,{width:155,align:'center'});
  pdf.moveDown(4).fontSize(8).fillColor('#64748b').text(`Verify at the school portal: certificate-verification.html · Enter reference ${row.certificate_no} and admission number.`,{align:'center'});
  if(row.status==='DRAFT'||row.status==='REVOKED')pdf.save().rotate(-25,{origin:[300,410]}).fillColor(row.status==='DRAFT'?'#64748b':'#b91c1c').opacity(.16).font('Helvetica-Bold').fontSize(48).text(row.status,{x:80,y:390,width:440,align:'center'}).restore();
  pdf.end();
 }catch(error){console.error('Generate academic certificate PDF failed:',error);if(!res.headersSent)res.status(500).json({error:'Unable to generate certificate PDF.'});else res.end();}
});

router.get('/:schoolId/learners/:learnerId/id-card.pdf',schoolBoundary,roles(...VIEW),async(req,res)=>{
 try{
  if(!uuid.test(req.params.learnerId))return res.status(400).json({error:'Invalid learner ID.'});
  const learner=(await db.query(`SELECT l.id,l.admission_no,l.first_name,l.middle_name,l.last_name,l.passport_photo_url,
      cl.name class_name,cl.stream,s.name school_name,s.code school_code,si.logo_url
    FROM learners l JOIN schools s ON s.id=l.school_id
    LEFT JOIN classes cl ON cl.id=l.class_id AND cl.school_id=l.school_id
    LEFT JOIN school_identity si ON si.school_id=l.school_id
    WHERE l.school_id=$1 AND l.id=$2 AND COALESCE(l.is_active,true)=true`,[req.params.schoolId,req.params.learnerId])).rows[0];
  if(!learner)return res.status(404).json({error:'Active learner not found in this school.'});
  const pdf=new PDFDocument({size:[340,216],margin:11,info:{Title:`Learner ID ${learner.admission_no}`,Author:learner.school_name}});
  const filename=`learner-id-${clean(learner.admission_no,80).replace(/[^a-zA-Z0-9_-]/g,'-')||'card'}.pdf`;
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`inline; filename="${filename}"`);pdf.pipe(res);
  pdf.roundedRect(4,4,332,208,10).lineWidth(1).strokeColor('#17365d').stroke();
  pdf.roundedRect(4,4,332,49,9).fill('#17365d');
  const logo=assetSource(learner.logo_url);
  if(logo){try{pdf.image(logo,13,11,{fit:[34,34]})}catch{}}
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text(learner.school_name,54,15,{width:267,align:'center',lineBreak:false,ellipsis:true});
  pdf.font('Helvetica').fontSize(7).text(learner.school_code||'OFFICIAL LEARNER IDENTIFICATION',54,34,{width:267,align:'center'});
  pdf.roundedRect(252,68,68,86,4).fill('#eef2f7').strokeColor('#cbd5e1').stroke();
  const photo=assetSource(learner.passport_photo_url);
  if(photo){try{pdf.image(photo,256,72,{fit:[60,78],align:'center',valign:'center'})}catch{}}
  else pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text('PHOTO NOT ON FILE',257,107,{width:58,align:'center'});
  pdf.fillColor('#17365d').font('Helvetica-Bold').fontSize(7).text('LEARNER NAME',18,69);
  pdf.fillColor('#111827').fontSize(13).text([learner.first_name,learner.middle_name,learner.last_name].filter(Boolean).join(' '),18,82,{width:220,height:40,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(7).text('ADMISSION NUMBER',18,132);
  pdf.fillColor('#111827').font('Helvetica-Bold').fontSize(11).text(learner.admission_no,18,144,{width:220,lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(7).text('CLASS / STREAM',18,166);
  pdf.fillColor('#111827').font('Helvetica').fontSize(9).text([learner.class_name,learner.stream].filter(Boolean).join(' · ')||'Not assigned',18,177,{width:300,lineBreak:false,ellipsis:true});
  pdf.end();
 }catch(error){console.error('Generate learner ID card failed:',error);if(!res.headersSent)res.status(500).json({error:'Unable to generate learner ID card.'});else res.end();}
});

module.exports=router;
