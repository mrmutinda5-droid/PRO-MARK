'use strict';

const express=require('express');
const PDFDocument=require('pdfkit');
const crypto=require('crypto');
const db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {source:assetSource}=require('../services/assets');
const {documentTemplate}=require('../services/document-templates');
const {validateCertificateDraft,assertCertificateTransition}=require('../services/school-certificates');

const router=express.Router();
const VIEW=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'];
const WRITE=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'];
const ISSUE=['SCHOOL_ADMIN','ADMIN','HEADTEACHER'];
const certificateNumber=/^ZAC-\d{4}-[A-F0-9]{24}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean=(value,max=250)=>String(value??'').trim().slice(0,max);
const safeColor=(value,fallback)=>/^#[0-9a-f]{6}$/i.test(String(value||''))?String(value):fallback;

function drawLogo(pdf,url,x,y,width,height){
 const logo=assetSource(url);
 if(logo){try{pdf.image(logo,x,y,{fit:[width,height],align:'center',valign:'center'})}catch{}}
}

function drawCertificateStatement(pdf,row,x,y,width){
 const text=String(row.achievement_statement||'');
 let fontSize=12;
 while(fontSize>8&&pdf.heightOfString(text,{width,font:'Helvetica',fontSize,lineGap:3})>100)fontSize--;
 const height=pdf.heightOfString(text,{width,font:'Helvetica',fontSize,lineGap:3});
 pdf.fillColor('#334155').font('Helvetica').fontSize(fontSize).text(text,x,y,{width,align:'center',lineGap:3});
 return y+height;
}

function renderCertificate(pdf,row,template){
 const primary=safeColor(row.primary_color,'#17365d');
 const accent=safeColor(row.secondary_color,'#d9a441');
 const schoolDetails=[row.motto,row.address,row.contact_phone,row.contact_email].filter(Boolean).join(' · ');
 const learner=[row.first_name,row.middle_name,row.last_name].filter(Boolean).join(' ');
 const context=[row.year_label,row.term_no?`Term ${row.term_no}`:row.term_name,[row.class_name,row.stream].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
 const draftLabel=row.status==='DRAFT'?'DRAFT PREVIEW':row.status==='REVOKED'?'REVOKED':`Issued: ${String(row.issued_on).slice(0,10)}`;
 const issuer=row.issuer_first_name?[row.issuer_first_name,row.issuer_last_name].filter(Boolean).join(' '):'Authorised school officer';
 const stamp=assetSource(row.stamp_url);

 pdf.rect(0,0,842,595).fill('#ffffff');
 if(template==='classic'){
  pdf.rect(18,18,806,559).lineWidth(3).strokeColor(primary).stroke();
  pdf.rect(27,27,788,541).lineWidth(1).strokeColor(accent).stroke();
  pdf.rect(36,36,770,523).lineWidth(.5).strokeColor(primary).stroke();
  [[38,38,1,1],[804,38,-1,1],[38,557,1,-1],[804,557,-1,-1]].forEach(([x,y,sx,sy])=>{
   pdf.moveTo(x,y+24*sy).lineTo(x,y).lineTo(x+24*sx,y).lineWidth(3).strokeColor(accent).stroke();
  });
  drawLogo(pdf,row.logo_url,394,45,54,54);
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(18).text(row.school_name,76,108,{width:690,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(schoolDetails,{width:690,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor(accent).font('Helvetica-Bold').fontSize(10).text(String(row.category||'ACADEMIC_ACHIEVEMENT').replaceAll('_',' '),80,160,{width:682,align:'center',lineBreak:false});
  pdf.fillColor(primary).font('Times-Bold').fontSize(29).text(row.title,80,190,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('This certificate is proudly presented to',80,240,{width:682,align:'center'});
  pdf.fillColor(primary).font('Times-Italic').fontSize(28).text(learner,80,272,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(`Admission number: ${row.admission_no}`,80,304,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.moveTo(240,322).lineTo(602,322).lineWidth(1).strokeColor(accent).stroke();
  var contentY=drawCertificateStatement(pdf,row,105,338,632);
 }else if(template==='modern'){
  pdf.rect(0,0,166,595).fill(primary);
  pdf.rect(157,0,9,595).fill(accent);
  pdf.circle(83,78,30).lineWidth(1.5).strokeColor('#ffffff').stroke();
  drawLogo(pdf,row.logo_url,59,54,48,48);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(row.school_name,20,133,{width:126,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#e2e8f0').font('Helvetica').fontSize(8).text(row.school_code||'SCHOOL',20,153,{width:126,align:'center'});
  pdf.fillColor('#ffffff').font('Helvetica').fontSize(7).text('LEARN · LEAD · ACHIEVE',18,548,{width:130,align:'center'});
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(10).text(String(row.category||'ACADEMIC_ACHIEVEMENT').replaceAll('_',' '),207,88,{width:588,align:'left',lineBreak:false,ellipsis:true});
  pdf.fillColor('#17365d').font('Helvetica-Bold').fontSize(30).text(row.title,207,122,{width:588,align:'left',lineBreak:false,ellipsis:true});
  pdf.moveTo(207,165).lineTo(794,165).lineWidth(1).strokeColor('#dce5ec').stroke();
  pdf.fillColor('#526176').font('Helvetica').fontSize(12).text('Presented to',207,193);
  pdf.fillColor(primary).font('Times-Italic').fontSize(28).text(learner,207,219,{width:588,align:'left',lineBreak:false,ellipsis:true});
  pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(`Admission number: ${row.admission_no}`,207,252,{width:588,align:'left',lineBreak:false,ellipsis:true});
  pdf.moveTo(207,274).lineTo(515,274).lineWidth(2).strokeColor(accent).stroke();
  var contentY=drawCertificateStatement(pdf,row,207,291,585);
 }else{
  pdf.rect(18,18,806,559).lineWidth(2).strokeColor(primary).stroke();
  pdf.rect(27,27,788,541).lineWidth(1).strokeColor(accent).stroke();
  pdf.rect(18,18,806,13).fill(primary);
  pdf.rect(18,564,806,13).fill(primary);
  drawLogo(pdf,row.logo_url,394,48,54,54);
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(18).text(row.school_name,76,111,{width:690,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(schoolDetails,{width:690,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor(accent).font('Helvetica-Bold').fontSize(10).text(String(row.category||'ACADEMIC_ACHIEVEMENT').replaceAll('_',' '),80,157,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor(primary).font('Times-Bold').fontSize(27).text(row.title,80,190,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('is proudly presented to',80,237,{width:682,align:'center'});
  pdf.fillColor(primary).font('Times-Italic').fontSize(28).text(learner,80,269,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(`Admission number: ${row.admission_no}`,80,301,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.moveTo(165,322).lineTo(677,322).lineWidth(.8).strokeColor(accent).stroke();
  var contentY=drawCertificateStatement(pdf,row,105,338,632);
 }
 if(context)pdf.fillColor('#52647a').font('Helvetica').fontSize(9).text(context,90,Math.max(contentY+10,447),{width:662,align:'center',lineBreak:false,ellipsis:true});
 pdf.fillColor('#52647a').font('Helvetica').fontSize(8).text(`${draftLabel}  ·  Reference: ${row.certificate_no}`,90,469,{width:662,align:'center',lineBreak:false,ellipsis:true});
 pdf.moveTo(83,520).lineTo(269,520).lineWidth(.8).strokeColor('#94a3b8').stroke();
 pdf.fillColor('#334155').font('Helvetica').fontSize(9).text(issuer,83,528,{width:186,align:'center',lineBreak:false,ellipsis:true});
 if(stamp){try{pdf.image(stamp,685,477,{fit:[66,44],align:'center',valign:'center'})}catch{}}
 pdf.moveTo(574,520).lineTo(760,520).lineWidth(.8).strokeColor('#94a3b8').stroke();
 pdf.fillColor('#334155').font('Helvetica').fontSize(9).text('Official school stamp',574,528,{width:186,align:'center'});
 pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text(`Verify with reference ${row.certificate_no} and learner admission number.`,80,560,{width:682,align:'center',lineBreak:false,ellipsis:true});
 if(row.status==='DRAFT'||row.status==='REVOKED'){
  pdf.save().rotate(-22,{origin:[421,300]}).fillColor(row.status==='DRAFT'?'#64748b':'#b91c1c').opacity(.12).font('Helvetica-Bold').fontSize(64).text(row.status,{x:180,y:266,width:480,align:'center'}).restore();
 }
}

function renderIdCard(pdf,learner,template){
 const primary=safeColor(learner.primary_color,'#17365d');
 const accent=safeColor(learner.secondary_color,'#d9a441');
 const fullName=[learner.first_name,learner.middle_name,learner.last_name].filter(Boolean).join(' ');
 const className=[learner.class_name,learner.stream].filter(Boolean).join(' · ')||'Not assigned';
 const photo=assetSource(learner.passport_photo_url);
 pdf.rect(0,0,340,216).fill('#ffffff');
 pdf.roundedRect(4,4,332,208,10).lineWidth(1.5).strokeColor(primary).stroke();
 if(template==='classic'){
  pdf.roundedRect(4,4,332,52,9).fill(primary);
  drawLogo(pdf,learner.logo_url,13,12,34,34);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(learner.school_name,52,15,{width:272,align:'center',lineBreak:false,ellipsis:true});
  pdf.font('Helvetica').fontSize(7).text(learner.school_code||'OFFICIAL LEARNER IDENTIFICATION',52,32,{width:272,align:'center',lineBreak:false,ellipsis:true});
  pdf.roundedRect(18,70,78,103,4).fill('#eef2f7').strokeColor('#cbd5e1').stroke();
  if(photo){try{pdf.image(photo,21,73,{fit:[72,97],align:'center',valign:'center'})}catch{}}
  else pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text('PHOTO NOT ON FILE',20,117,{width:74,align:'center'});
  pdf.fillColor(accent).font('Helvetica-Bold').fontSize(7).text('LEARNER NAME',112,72);
  pdf.fillColor(primary).fontSize(12).text(fullName,112,85,{width:210,height:34,ellipsis:true});
  pdf.fillColor('#475569').fontSize(7).text('ADMISSION NUMBER',112,129);
  pdf.fillColor('#111827').fontSize(10).text(learner.admission_no,112,141,{width:210,lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').fontSize(7).text('CLASS / STREAM',112,163);
  pdf.fillColor('#111827').font('Helvetica').fontSize(8).text(className,112,175,{width:210,lineBreak:false,ellipsis:true});
  pdf.rect(4,192,332,20).fill('#f3ead4');
  pdf.fillColor('#73581f').font('Helvetica').fontSize(7).text('If found, please return to the school office',20,198,{width:300,align:'center'});
 }else if(template==='modern'){
  pdf.roundedRect(4,4,332,48,9).fill(primary);
  pdf.rect(322,4,14,48).fill(accent);
  drawLogo(pdf,learner.logo_url,14,10,35,35);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(learner.school_name,55,14,{width:258,align:'center',lineBreak:false,ellipsis:true});
  pdf.font('Helvetica').fontSize(7).text('LEARNER ID · OFFICIAL SCHOOL CARD',55,31,{width:258,align:'center'});
  pdf.roundedRect(18,66,88,119,8).fill('#edf4f6');
  if(photo){try{pdf.image(photo,21,69,{fit:[82,113],align:'center',valign:'center'})}catch{}}
  else pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text('PHOTO NOT ON FILE',22,123,{width:80,align:'center'});
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(7).text('STUDENT',122,76);
  pdf.fillColor('#111827').fontSize(12).text(fullName,122,91,{width:194,height:34,ellipsis:true});
  pdf.fillColor('#526176').font('Helvetica').fontSize(9).text(learner.admission_no,122,137,{width:194,lineBreak:false,ellipsis:true});
  pdf.roundedRect(122,154,194,27,5).fill('#eff4f6');
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(8).text(className,131,163,{width:178,lineBreak:false,ellipsis:true});
  pdf.fillColor('#718096').font('Helvetica').fontSize(6).text('Return to the school office if found',122,194,{width:194});
 }else{
  pdf.roundedRect(4,4,332,52,9).fill(primary);
  drawLogo(pdf,learner.logo_url,13,12,34,34);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(learner.school_name,54,14,{width:270,align:'center',lineBreak:false,ellipsis:true});
  pdf.font('Helvetica').fontSize(7).text('LEARNER IDENTIFICATION CARD',54,32,{width:270,align:'center'});
  pdf.roundedRect(18,70,78,103,4).fill('#f1edf2');
  if(photo){try{pdf.image(photo,21,73,{fit:[72,97],align:'center',valign:'center'})}catch{}}
  else pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text('PHOTO NOT ON FILE',20,117,{width:74,align:'center'});
  pdf.fillColor(accent).font('Helvetica-Bold').fontSize(7).text('LEARNER',112,72);
  pdf.fillColor(primary).fontSize(12).text(fullName,112,85,{width:210,height:34,ellipsis:true});
  pdf.fillColor('#475569').fontSize(7).text('ADMISSION NUMBER',112,129);
  pdf.fillColor('#111827').fontSize(10).text(learner.admission_no,112,141,{width:210,lineBreak:false,ellipsis:true});
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(8).text(className,112,166,{width:210,lineBreak:false,ellipsis:true});
  pdf.rect(4,192,332,20).fill('#f1edf2');
  pdf.fillColor(primary).font('Helvetica').fontSize(7).text('OFFICIAL SCHOOL IDENTIFICATION  ·  Return if found',12,198,{width:316,align:'center'});
 }
}

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
  const template=documentTemplate(req.query.template);
  if(!template)return res.status(400).json({error:'Select a supported certificate design.'});
  const row=(await db.query(`SELECT c.*,l.admission_no,l.first_name,l.middle_name,l.last_name,l.passport_photo_url,
      cl.name class_name,cl.stream,ay.year_label,t.term_no,t.name term_name,
      s.name school_name,s.code school_code,si.logo_url,si.motto,si.address,si.contact_phone,si.contact_email,
      si.primary_color,si.secondary_color,
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
  const pdf=new PDFDocument({size:'A4',layout:'landscape',margin:0,info:{Title:row.title,Author:row.school_name}});
  const filename=`academic-certificate-${row.certificate_no}-${template}.pdf`;
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`${req.query.download==='1'?'attachment':'inline'}; filename="${filename}"`);
  pdf.pipe(res);renderCertificate(pdf,row,template);
  pdf.end();
 }catch(error){console.error('Generate academic certificate PDF failed:',error);if(!res.headersSent)res.status(500).json({error:'Unable to generate certificate PDF.'});else res.end();}
});

router.get('/:schoolId/learners/:learnerId/id-card.pdf',schoolBoundary,roles(...VIEW),async(req,res)=>{
 try{
  if(!uuid.test(req.params.learnerId))return res.status(400).json({error:'Invalid learner ID.'});
  const template=documentTemplate(req.query.template);
  if(!template)return res.status(400).json({error:'Select a supported ID card design.'});
  const learner=(await db.query(`SELECT l.id,l.admission_no,l.first_name,l.middle_name,l.last_name,l.passport_photo_url,
      cl.name class_name,cl.stream,s.name school_name,s.code school_code,si.logo_url,
      si.primary_color,si.secondary_color
    FROM learners l JOIN schools s ON s.id=l.school_id
    LEFT JOIN classes cl ON cl.id=l.class_id AND cl.school_id=l.school_id
    LEFT JOIN school_identity si ON si.school_id=l.school_id
    WHERE l.school_id=$1 AND l.id=$2 AND COALESCE(l.is_active,true)=true`,[req.params.schoolId,req.params.learnerId])).rows[0];
  if(!learner)return res.status(404).json({error:'Active learner not found in this school.'});
  const pdf=new PDFDocument({size:[340,216],margin:0,info:{Title:`Learner ID ${learner.admission_no}`,Author:learner.school_name}});
  const filename=`learner-id-${clean(learner.admission_no,80).replace(/[^a-zA-Z0-9_-]/g,'-')||'card'}-${template}.pdf`;
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`${req.query.download==='1'?'attachment':'inline'}; filename="${filename}"`);
  pdf.pipe(res);renderIdCard(pdf,learner,template);
  pdf.end();
 }catch(error){console.error('Generate learner ID card failed:',error);if(!res.headersSent)res.status(500).json({error:'Unable to generate learner ID card.'});else res.end();}
});

module.exports=router;
