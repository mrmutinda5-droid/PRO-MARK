'use strict';

const express=require('express');
const PDFDocument=require('pdfkit');
const {PDFDocument:PDFLibDocument}=require('pdf-lib');
const {ZipArchive}=require('archiver');
const QRCode=require('qrcode');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {source:assetSource}=require('../services/assets');
const {documentTemplate,documentTemplates,validDocumentCategory}=require('../services/document-templates');
const {randomDocumentToken,documentTokenHash,encryptDocumentToken,decryptDocumentToken}=require('../services/document-security');
const {validateCertificateDraft,assertCertificateTransition}=require('../services/school-certificates');

const router=express.Router();
const VIEW=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'];
const WRITE=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'];
const ISSUE=['SCHOOL_ADMIN','ADMIN','HEADTEACHER'];
const certificateNumber=/^ZAC-\d{4}-[A-F0-9]{24}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean=(value,max=250)=>String(value??'').trim().slice(0,max);
const safeColor=(value,fallback)=>/^#[0-9a-f]{6}$/i.test(String(value||''))?String(value):fallback;
const CARD_WIDTH=85.6*72/25.4,CARD_HEIGHT=53.98*72/25.4;

function verificationUrl(req,path,token){
 const base=process.env.PUBLIC_APP_URL||`${req.protocol}://${req.get('host')}`;
 const origin=new URL(base);
 if(!['http:','https:'].includes(origin.protocol))throw Error('PUBLIC_APP_URL must use HTTP or HTTPS.');
 const url=new URL(path,origin);
 url.searchParams.set('token',token);
 return url.toString();
}

function snapshotImage(url){
 if(!url)return null;
 const value=String(url);
 if(/^data:image\/(png|jpe?g|webp);base64,/i.test(value)){
  if(Buffer.byteLength(value,'utf8')>6*1024*1024)throw Error('A certificate image exceeds the 4 MB snapshot limit.');
  return value;
 }
 const source=assetSource(value);
 if(!source)return null;
 const extension=path.extname(String(source)).toLowerCase();
 const mime=extension==='.jpg'||extension==='.jpeg'?'image/jpeg':extension==='.webp'?'image/webp':'image/png';
 const buffer=Buffer.isBuffer(source)?source:fs.readFileSync(source);
 if(buffer.length>4*1024*1024)throw Error('A certificate image exceeds the 4 MB snapshot limit.');
 return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function loadCertificateIssueSnapshot(client,schoolId,certificateId,issuerId,issuerRole,template){
 const row=(await client.query(`SELECT c.*,l.admission_no,l.first_name,l.middle_name,l.last_name,
      COALESCE(le.class_id,l.class_id) resolved_class_id,cl.name class_name,cl.stream,
      ay.year_label,t.term_no,t.name term_name,
      s.name school_name,s.code school_code,si.logo_url,si.motto,si.address,si.contact_phone,si.contact_email,
      si.primary_color,si.secondary_color,
      issuer.first_name issuer_first_name,issuer.last_name issuer_last_name,
      signer.signature_url signer_signature_url,
      (SELECT file_url FROM school_document_assets a WHERE a.school_id=c.school_id AND a.asset_type='STAMP' AND a.is_active=true
       AND a.effective_from<=CURRENT_DATE AND (a.effective_to IS NULL OR a.effective_to>=CURRENT_DATE)
       ORDER BY a.effective_from DESC,a.created_at DESC LIMIT 1) stamp_url
    FROM school_academic_certificates c
    JOIN learners l ON l.id=c.learner_id AND l.school_id=c.school_id
    LEFT JOIN learner_enrollments le ON le.school_id=c.school_id AND le.learner_id=l.id
      AND le.academic_year_id=c.academic_year_id AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
    LEFT JOIN classes cl ON cl.id=COALESCE(le.class_id,l.class_id) AND cl.school_id=c.school_id
    LEFT JOIN academic_years ay ON ay.id=c.academic_year_id AND ay.school_id=c.school_id
    LEFT JOIN terms t ON t.id=c.term_id AND t.school_id=c.school_id
    JOIN schools s ON s.id=c.school_id
    LEFT JOIN school_identity si ON si.school_id=c.school_id
    LEFT JOIN users issuer ON issuer.id=$3
    LEFT JOIN teachers signer ON signer.user_id=$3 AND signer.school_id=c.school_id AND signer.is_active=true
    WHERE c.school_id=$1 AND c.id=$2`,[schoolId,certificateId,issuerId])).rows[0];
 if(!row)throw Error('Certificate details could not be loaded for issue snapshot.');
 row.class_id=row.resolved_class_id;
 row.signer_name=row.signer_name||[row.issuer_first_name,row.issuer_last_name].filter(Boolean).join(' ');
 row.signer_title=row.signer_title||String(issuerRole||'Authorised school officer').replaceAll('_',' ');
 row.issuer_signature_url=snapshotImage(row.signer_signature_url);
 delete row.signer_signature_url;
 row.logo_url=snapshotImage(row.logo_url);
 row.stamp_url=snapshotImage(row.stamp_url);
 row.template_id=template;
 return row;
}

async function validateCertificateReplacement(client,schoolId,replacesId,currentId=null){
 if(!replacesId)return;
 const original=(await client.query(`SELECT status FROM school_academic_certificates
   WHERE school_id=$1 AND id=$2 FOR UPDATE`,[schoolId,replacesId])).rows[0];
 if(!original)throw Object.assign(new Error('The certificate being replaced was not found in this school.'),{status:400});
 if(original.status!=='REVOKED')throw Object.assign(new Error('Only a revoked certificate can be replaced.'),{status:409});
 const prior=(await client.query(`SELECT id FROM school_academic_certificates
   WHERE school_id=$1 AND replaces_certificate_id=$2 AND id<>COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`,
 [schoolId,replacesId,currentId])).rows[0];
 if(prior)throw Object.assign(new Error('A replacement certificate already exists for this reference.'),{status:409});
}

function learnerCardSnapshot(learner){
 return {
  school_name:learner.school_name,school_code:learner.school_code,motto:learner.motto,
  logo_url:snapshotImage(learner.logo_url),primary_color:learner.primary_color,secondary_color:learner.secondary_color,
  address:learner.address,contact_phone:learner.contact_phone,
  learner_id:learner.id,admission_no:learner.admission_no,
  first_name:learner.first_name,middle_name:learner.middle_name,last_name:learner.last_name,
  class_name:learner.class_name,stream:learner.stream,year_label:learner.year_label,
  passport_photo_url:snapshotImage(learner.passport_photo_url)
 };
}

async function issueOrReprintLearnerCard(req,learner,template,academicYearId,replaceActive=false,clientOverride=null,replaceReason=null){
 const sid=req.params.schoolId,client=clientOverride||await db.pool.connect(),ownsClient=!clientOverride;
 try{
  if(ownsClient)await client.query('BEGIN');
  const active=await client.query(`SELECT * FROM school_learner_cards
    WHERE school_id=$1 AND learner_id=$2 AND status='ACTIVE' FOR UPDATE`,
  [sid,learner.id]);
  let card,token,action,previousCardId=null,cardSnapshot;
  if(active.rowCount&&!replaceActive){
   card=active.rows[0];token=decryptDocumentToken(card.verification_token_ciphertext);
   cardSnapshot=card.snapshot;
   action='LEARNER_ID_CARD_REPRINTED';
  }else{
   const snapshot=JSON.stringify(learnerCardSnapshot(learner));
   if(active.rowCount){
    previousCardId=active.rows[0].id;
    await client.query(`UPDATE school_learner_cards SET status='REPLACED' WHERE school_id=$1 AND id=$2`,
    [sid,previousCardId]);
   }
   token=randomDocumentToken();
   const year=(String(learner.year_label||new Date().getUTCFullYear()).match(/\d{4}/)||[])[0]||String(new Date().getUTCFullYear());
   const reference=`ZID-${year}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
   card=(await client.query(`INSERT INTO school_learner_cards
       (school_id,learner_id,academic_year_id,card_reference,verification_token_hash,
        verification_token_ciphertext,template_id,snapshot,issued_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
   [sid,learner.id,academicYearId,reference,documentTokenHash(token),encryptDocumentToken(token),template,snapshot,req.user.user_id])).rows[0];
   cardSnapshot=card.snapshot;
   if(previousCardId){
    await client.query(`UPDATE school_learner_cards SET replaced_by=$3 WHERE school_id=$1 AND id=$2`,
    [sid,previousCardId,card.id]);
    action='LEARNER_ID_CARD_REPLACED';
   }else action='LEARNER_ID_CARD_ISSUED';
  }
  await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
    VALUES($1,$2,$3,'school_learner_card',$4,$5::jsonb)`,
  [sid,req.user.user_id,action,card.id,JSON.stringify({card_reference:card.card_reference,learner_id:learner.id,template_id:template,reason:replaceReason})]);
  if(ownsClient)await client.query('COMMIT');
  return {card,token,snapshot:cardSnapshot};
 }catch(error){if(ownsClient)await client.query('ROLLBACK').catch(()=>{});throw error}
 finally{if(ownsClient)client.release();}
}

async function loadLearnerForCard(schoolId,learnerId,academicYearId,yearLabel){
 return (await db.query(`SELECT l.id,l.admission_no,l.first_name,l.middle_name,l.last_name,l.passport_photo_url,
      cl.name class_name,cl.stream,s.name school_name,s.code school_code,si.logo_url,si.motto,
      si.primary_color,si.secondary_color,si.address,si.contact_phone,$3::text year_label
    FROM learners l JOIN schools s ON s.id=l.school_id
    LEFT JOIN learner_enrollments le ON le.school_id=l.school_id AND le.learner_id=l.id
      AND le.academic_year_id=$4 AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
    LEFT JOIN classes cl ON cl.id=COALESCE(le.class_id,l.class_id) AND cl.school_id=l.school_id
    LEFT JOIN school_identity si ON si.school_id=l.school_id
    WHERE l.school_id=$1 AND l.id=$2 AND COALESCE(l.is_active,true)=true`,
 [schoolId,learnerId,yearLabel,academicYearId])).rows[0];
}

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
 const fallbackPrimary=template==='sports-achievement'?'#166534':template==='subject-champion'?'#1456a0':template==='participation'?'#583556':'#071f49';
 const primary=safeColor(row.primary_color,fallbackPrimary);
 const accent=safeColor(row.secondary_color,'#d4a52c');
 const schoolDetails=[row.motto,row.address,row.contact_phone,row.contact_email].filter(Boolean).join(' · ');
 const learner=[row.first_name,row.middle_name,row.last_name].filter(Boolean).join(' ');
 const context=[row.year_label,row.term_no?`Term ${row.term_no}`:row.term_name,[row.class_name,row.stream].filter(Boolean).join(' '),row.achievement_date?`Achievement date: ${String(row.achievement_date).slice(0,10)}`:null].filter(Boolean).join(' · ');
 const draftLabel=row.status==='DRAFT'?'DRAFT PREVIEW':row.status==='REVOKED'?'REVOKED':`Issued: ${String(row.issued_on).slice(0,10)}`;
 const issuer=row.signer_name||(row.issuer_first_name?[row.issuer_first_name,row.issuer_last_name].filter(Boolean).join(' '):'Authorised school officer');
 const stamp=assetSource(row.stamp_url);
 const issuerSignature=assetSource(row.issuer_signature_url);

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
 }else if(template==='subject-champion'){
  pdf.rect(18,18,806,559).lineWidth(3).strokeColor(primary).stroke();
  pdf.rect(18,18,806,66).fill(primary);
  pdf.circle(421,122,31).fill(accent);
  pdf.circle(421,122,23).lineWidth(2).strokeColor('#fff').stroke();
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text('1',409,113,{width:24,align:'center'});
  drawLogo(pdf,row.logo_url,394,35,54,38);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(row.school_name,76,45,{width:690,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(11).text('CERTIFICATE OF SUBJECT CHAMPION',80,171,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('Awarded to',80,204,{width:682,align:'center'});
  pdf.fillColor(primary).font('Times-Bold').fontSize(30).text(learner,80,229,{width:682,align:'center',lineBreak:false,ellipsis:true});
  const subject=String(row.subject_or_activity||row.subject_name||'Academic subject');
  pdf.roundedRect(242,274,358,37,8).fill('#fff6dc').strokeColor(accent).stroke();
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(14).text(subject,252,285,{width:338,align:'center',lineBreak:false,ellipsis:true});
  var contentY=drawCertificateStatement(pdf,row,105,327,632);
 }else if(template==='most-improved'){
  pdf.rect(18,18,806,559).lineWidth(3).strokeColor(primary).stroke();
  pdf.rect(28,28,786,539).lineWidth(1).strokeColor(accent).stroke();
  pdf.circle(421,83,29).fill(accent);
  for(let i=0;i<5;i++){
   const angle=-Math.PI/2+i*2*Math.PI/5,inner=12,outer=23;
   const x1=421+Math.cos(angle)*outer,y1=83+Math.sin(angle)*outer;
   const x2=421+Math.cos(angle+Math.PI/5)*inner,y2=83+Math.sin(angle+Math.PI/5)*inner;
   if(i===0)pdf.moveTo(x1,y1);else pdf.lineTo(x1,y1);pdf.lineTo(x2,y2);
  }
  pdf.closePath().fill('#fff');
  drawLogo(pdf,row.logo_url,394,38,54,54);
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(17).text(row.school_name,76,112,{width:690,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor(accent).font('Helvetica-Bold').fontSize(11).text('MOST IMPROVED LEARNER',80,166,{width:682,align:'center',lineBreak:false});
  pdf.fillColor(primary).font('Times-Bold').fontSize(29).text(learner,80,205,{width:682,align:'center',lineBreak:false,ellipsis:true});
  var contentY=drawCertificateStatement(pdf,row,105,253,632);
 }else if(template==='sports-achievement'){
  pdf.rect(0,0,842,595).fill('#fff');
  pdf.rect(18,18,806,559).lineWidth(3).strokeColor(primary).stroke();
  pdf.rect(18,18,806,64).fill(primary);
  pdf.circle(421,127,30).fill(accent);
  pdf.rect(412,119,18,22).fill('#fff');pdf.rect(404,115,8,7).fill('#fff');pdf.rect(430,115,8,7).fill('#fff');
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(row.school_name,76,42,{width:690,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(12).text('SPORTS ACHIEVEMENT',80,178,{width:682,align:'center',lineBreak:false});
  pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('This award is presented to',80,212,{width:682,align:'center'});
  pdf.fillColor(primary).font('Times-Bold').fontSize(30).text(learner,80,238,{width:682,align:'center',lineBreak:false,ellipsis:true});
  const activity=String(row.subject_or_activity||row.subject_name||'Sport or activity');
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(14).text(activity,80,287,{width:682,align:'center',lineBreak:false,ellipsis:true});
  var contentY=drawCertificateStatement(pdf,row,105,319,632);
 }else if(template==='participation'){
  pdf.rect(18,18,806,559).lineWidth(2).strokeColor(primary).stroke();
  pdf.rect(26,26,790,543).lineWidth(1).strokeColor(accent).stroke();
  pdf.polygon([18,18],[82,18],[18,82]).fill(primary);
  pdf.polygon([824,18],[760,18],[824,82]).fill(accent);
  pdf.polygon([18,577],[82,577],[18,513]).fill(accent);
  pdf.polygon([824,577],[760,577],[824,513]).fill(primary);
  drawLogo(pdf,row.logo_url,394,49,54,54);
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(17).text(row.school_name,76,116,{width:690,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor(primary).font('Times-Bold').fontSize(26).text('CERTIFICATE OF PARTICIPATION',80,177,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica').fontSize(12).text('Presented to',80,220,{width:682,align:'center'});
  pdf.fillColor(primary).font('Times-Italic').fontSize(29).text(learner,80,247,{width:682,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(13).text(String(row.subject_or_activity||'Co-curricular participation'),80,292,{width:682,align:'center',lineBreak:false,ellipsis:true});
  var contentY=drawCertificateStatement(pdf,row,105,321,632);
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
 if(issuerSignature){try{pdf.image(issuerSignature,116,487,{fit:[120,30],align:'center',valign:'center'})}catch{}}
 pdf.fillColor('#334155').font('Helvetica').fontSize(9).text(issuer,83,528,{width:186,align:'center',lineBreak:false,ellipsis:true});
 if(row.signer_title)pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text(row.signer_title,83,541,{width:186,align:'center',lineBreak:false,ellipsis:true});
 if(stamp){try{pdf.image(stamp,685,477,{fit:[66,44],align:'center',valign:'center'})}catch{}}
 pdf.moveTo(328,520).lineTo(514,520).lineWidth(.8).strokeColor('#94a3b8').stroke();
 pdf.fillColor('#334155').font('Helvetica').fontSize(9).text(row.second_signer_name||'Second authorised signatory',328,528,{width:186,align:'center',lineBreak:false,ellipsis:true});
 if(row.second_signer_title)pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text(row.second_signer_title,328,541,{width:186,align:'center',lineBreak:false,ellipsis:true});
 pdf.moveTo(574,520).lineTo(760,520).lineWidth(.8).strokeColor('#94a3b8').stroke();
 pdf.fillColor('#334155').font('Helvetica').fontSize(9).text('Official school stamp',574,528,{width:186,align:'center'});
 const verifyInstruction=row.qrBuffer?`Scan QR or verify reference ${row.certificate_no} and learner admission number.`:`Verify with reference ${row.certificate_no} and learner admission number.`;
 pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text(verifyInstruction,80,560,{width:682,align:'center',lineBreak:false,ellipsis:true});
 if(row.qrBuffer)pdf.image(row.qrBuffer,779,510,{width:42,height:42});
 if(row.status==='DRAFT'||row.status==='REVOKED'){
  pdf.save().rotate(-22,{origin:[421,300]}).fillColor(row.status==='DRAFT'?'#64748b':'#b91c1c').opacity(.12).font('Helvetica-Bold').fontSize(64).text(row.status,{x:180,y:266,width:480,align:'center'}).restore();
 }
}

function renderIdCard(pdf,learner,template,card={}){
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
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(learner.school_name,52,15,{width:230,align:'center',lineBreak:false,ellipsis:true});
  pdf.font('Helvetica').fontSize(6).text(learner.school_code||'OFFICIAL LEARNER IDENTIFICATION',52,29,{width:230,align:'center',lineBreak:false,ellipsis:true});
  pdf.font('Helvetica-Oblique').fontSize(6).text(learner.motto||'STUDENT ID CARD',52,40,{width:230,align:'center',lineBreak:false,ellipsis:true});
  pdf.roundedRect(18,70,78,103,4).fill('#eef2f7').strokeColor('#cbd5e1').stroke();
  if(photo){try{pdf.image(photo,21,73,{cover:[72,97],align:'center',valign:'center'})}catch{}}
  else pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text('PHOTO NOT ON FILE',20,117,{width:74,align:'center'});
  pdf.fillColor(accent).font('Helvetica-Bold').fontSize(6).text('LEARNER NAME',112,69);
  pdf.fillColor(primary).fontSize(10).text(fullName,112,79,{width:210,height:27,ellipsis:true});
  pdf.fillColor('#475569').fontSize(6).text('STUDENT ID / ADMISSION NO.',112,110);
  pdf.fillColor('#111827').fontSize(8).text(learner.admission_no,112,119,{width:210,lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').fontSize(6).text('CLASS / GRADE',112,138);
  pdf.fillColor('#111827').font('Helvetica').fontSize(8).text(learner.class_name||'Not assigned',112,147,{width:210,lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text('STREAM',112,164);
  pdf.fillColor('#111827').font('Helvetica').fontSize(8).text(learner.stream||'—',112,173,{width:105,lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text('ACADEMIC YEAR',225,164);
  pdf.fillColor('#111827').font('Helvetica').fontSize(8).text(learner.year_label||'—',225,173,{width:97,lineBreak:false,ellipsis:true});
  pdf.rect(4,192,332,20).fill('#f3ead4');
  pdf.fillColor('#73581f').font('Helvetica-Bold').fontSize(7).text(`STUDENT ID CARD${learner.year_label?'  ·  '+learner.year_label:''}`,20,198,{width:300,align:'center',lineBreak:false,ellipsis:true});
 }else if(template==='modern'){
  pdf.roundedRect(4,4,332,48,9).fill(primary);
  pdf.rect(322,4,14,48).fill(accent);
  drawLogo(pdf,learner.logo_url,14,10,35,35);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(learner.school_name,55,14,{width:230,align:'center',lineBreak:false,ellipsis:true});
  pdf.font('Helvetica').fontSize(6).text(learner.school_code||'LEARNER ID',55,27,{width:230,align:'center'});
  pdf.font('Helvetica-Oblique').fontSize(6).text(learner.motto||'OFFICIAL SCHOOL CARD',55,37,{width:230,align:'center'});
  pdf.roundedRect(18,66,88,119,8).fill('#edf4f6');
  if(photo){try{pdf.image(photo,21,69,{cover:[82,113],align:'center',valign:'center'})}catch{}}
  else pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text('PHOTO NOT ON FILE',22,123,{width:80,align:'center'});
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(6).text('LEARNER NAME',122,69);
  pdf.fillColor('#111827').fontSize(10).text(fullName,122,78,{width:194,height:28,ellipsis:true});
  pdf.fillColor('#526176').font('Helvetica-Bold').fontSize(6).text('STUDENT ID / ADMISSION NO.',122,109);
  pdf.fillColor('#111827').font('Helvetica').fontSize(8).text(learner.admission_no,122,118,{width:194,lineBreak:false,ellipsis:true});
  pdf.fillColor('#526176').font('Helvetica-Bold').fontSize(6).text('CLASS / GRADE',122,137);
  pdf.fillColor(primary).font('Helvetica').fontSize(8).text(learner.class_name||'Not assigned',122,146,{width:110,lineBreak:false,ellipsis:true});
  pdf.fillColor('#526176').font('Helvetica-Bold').fontSize(6).text('STREAM',239,137);
  pdf.fillColor(primary).font('Helvetica').fontSize(8).text(learner.stream||'—',239,146,{width:77,lineBreak:false,ellipsis:true});
  pdf.roundedRect(122,162,194,23,5).fill('#eff4f6');
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(7).text(`STUDENT ID CARD${learner.year_label?'  ·  '+learner.year_label:''}`,130,170,{width:178,align:'center',lineBreak:false,ellipsis:true});
  pdf.fillColor('#718096').font('Helvetica').fontSize(6).text('Return to the school office if found',122,196,{width:194});
 }else{
  pdf.roundedRect(4,4,332,52,9).fill(primary);
  drawLogo(pdf,learner.logo_url,13,12,34,34);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(learner.school_name,54,14,{width:230,align:'center',lineBreak:false,ellipsis:true});
  pdf.font('Helvetica').fontSize(6).text(learner.school_code||'LEARNER IDENTIFICATION CARD',54,28,{width:230,align:'center'});
  pdf.font('Helvetica-Oblique').fontSize(6).text(learner.motto||'STUDENT ID CARD',54,39,{width:230,align:'center'});
  pdf.roundedRect(18,70,78,103,4).fill('#f1edf2');
  if(photo){try{pdf.image(photo,21,73,{cover:[72,97],align:'center',valign:'center'})}catch{}}
  else pdf.fillColor('#64748b').font('Helvetica').fontSize(7).text('PHOTO NOT ON FILE',20,117,{width:74,align:'center'});
  pdf.fillColor(accent).font('Helvetica-Bold').fontSize(6).text('LEARNER NAME',112,69);
  pdf.fillColor(primary).fontSize(10).text(fullName,112,79,{width:210,height:27,ellipsis:true});
  pdf.fillColor('#475569').fontSize(6).text('STUDENT ID / ADMISSION NO.',112,110);
  pdf.fillColor('#111827').fontSize(8).text(learner.admission_no,112,119,{width:210,lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').fontSize(6).text('CLASS / GRADE',112,138);
  pdf.fillColor(primary).font('Helvetica').fontSize(8).text(learner.class_name||'Not assigned',112,147,{width:110,lineBreak:false,ellipsis:true});
  pdf.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text('STREAM',229,138);
  pdf.fillColor(primary).font('Helvetica').fontSize(8).text(learner.stream||'—',229,147,{width:93,lineBreak:false,ellipsis:true});
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(7).text(`ACADEMIC YEAR  ·  ${learner.year_label||'—'}`,112,171,{width:210,align:'center',lineBreak:false,ellipsis:true});
  pdf.rect(4,192,332,20).fill('#f1edf2');
  pdf.fillColor(primary).font('Helvetica-Bold').fontSize(7).text('STUDENT ID CARD  ·  OFFICIAL SCHOOL IDENTIFICATION',12,198,{width:316,align:'center',lineBreak:false,ellipsis:true});
 }
 if(card.qrBuffer){
  pdf.image(card.qrBuffer,292,8,{width:34,height:34});
  pdf.fillColor('#ffffff').font('Helvetica').fontSize(4).text(card.cardReference||'VERIFY',288,44,{width:43,align:'center',lineBreak:false,ellipsis:true});
 }
}

function renderIdCardBack(pdf,learner,card={}){
 const primary=safeColor(learner.primary_color,'#17365d'),accent=safeColor(learner.secondary_color,'#d9a441');
 pdf.rect(0,0,340,216).fill('#ffffff');
 pdf.roundedRect(4,4,332,208,10).lineWidth(1.5).strokeColor(primary).stroke();
 pdf.roundedRect(4,4,332,43,9).fill(primary);
 drawLogo(pdf,learner.logo_url,13,9,30,30);
 pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(learner.school_name,49,12,{width:270,align:'center',lineBreak:false,ellipsis:true});
 pdf.fillColor('#e2e8f0').font('Helvetica').fontSize(6).text('IDENTITY VERIFICATION',49,27,{width:270,align:'center'});
 pdf.fillColor(primary).font('Helvetica-Bold').fontSize(7).text('IF FOUND, PLEASE RETURN THIS CARD TO',102,69,{width:220,align:'center'});
 pdf.fillColor('#475569').font('Helvetica').fontSize(7).text(learner.school_name,102,84,{width:220,align:'center',lineBreak:false,ellipsis:true});
 if(learner.contact_phone)pdf.text(learner.contact_phone,102,98,{width:220,align:'center',lineBreak:false,ellipsis:true});
 if(learner.address)pdf.text(learner.address,102,111,{width:220,align:'center',lineBreak:false,ellipsis:true});
 if(card.qrBuffer)pdf.image(card.qrBuffer,18,61,{width:70,height:70});
 pdf.roundedRect(101,137,221,31,5).fill('#f1f5f9');
 pdf.fillColor(primary).font('Helvetica-Bold').fontSize(6).text('CARD REFERENCE',108,144);
 pdf.fillColor('#334155').font('Helvetica').fontSize(7).text(card.cardReference||'Preview only',108,155,{width:205,lineBreak:false,ellipsis:true});
 pdf.moveTo(18,183).lineTo(322,183).lineWidth(1).strokeColor(accent).stroke();
 pdf.fillColor('#64748b').font('Helvetica').fontSize(6).text('Scan the QR code to check whether this card is current.',18,190,{width:304,align:'center',lineBreak:false,ellipsis:true});
}

function createIdCardPdf(learner,template,card={},side='front'){
 return new Promise((resolve,reject)=>{
  const pdf=new PDFDocument({size:[CARD_WIDTH,CARD_HEIGHT],margin:0,info:{Title:`Learner ID ${learner.admission_no}`,Author:learner.school_name}});
  const chunks=[];
  pdf.on('data',chunk=>chunks.push(chunk));
  pdf.on('error',reject);
  pdf.on('end',()=>resolve(Buffer.concat(chunks)));
  pdf.scale(CARD_WIDTH/340);renderIdCard(pdf,learner,template,card);
  if(side==='both'){
   pdf.addPage({size:[CARD_WIDTH,CARD_HEIGHT],margin:0});
   pdf.scale(CARD_WIDTH/340);renderIdCardBack(pdf,learner,card);
  }
  pdf.end();
 });
}

function createIdCardArchive(files){
 return new Promise((resolve,reject)=>{
  const archive=new ZipArchive({zlib:{level:6}}),chunks=[];
  archive.on('data',chunk=>chunks.push(chunk));
  archive.on('error',reject);
  archive.on('end',()=>resolve(Buffer.concat(chunks)));
  files.forEach(file=>archive.append(file.buffer,{name:file.name}));
  archive.finalize().catch(reject);
 });
}

async function createCombinedIdCardPdf(files){
 const combined=await PDFLibDocument.create();
 for(const file of files){
  const source=await PDFLibDocument.load(file.buffer);
  const pages=await combined.copyPages(source,source.getPageIndices());
  pages.forEach(page=>combined.addPage(page));
 }
 return Buffer.from(await combined.save());
}

async function buildBulkIdCards(req,format){
 const learnerIds=req.body?.learner_ids;
 if(!Array.isArray(learnerIds)||learnerIds.length<1||learnerIds.length>25||learnerIds.some(id=>!uuid.test(String(id)))||new Set(learnerIds).size!==learnerIds.length)
  throw Object.assign(new Error('Select between 1 and 25 unique valid learners.'),{status:400});
 const template=documentTemplate(req.body?.template_id,'ID_CARD');
 if(!template)throw Object.assign(new Error('Select a supported ID card design.'),{status:400});
 const academicYearId=req.body?.academic_year_id||null;
 if(academicYearId&&!uuid.test(academicYearId))throw Object.assign(new Error('Invalid academic year.'),{status:400});
 const side=req.body?.side==='both'?'both':'front',issue=req.body?.issue!==false;
 let yearLabel=null,client=null;
 try{
  if(academicYearId){
   yearLabel=(await db.query('SELECT year_label FROM academic_years WHERE school_id=$1 AND id=$2',[req.params.schoolId,academicYearId])).rows[0]?.year_label;
   if(!yearLabel)throw Object.assign(new Error('Academic year does not belong to this school.'),{status:400});
  }
  const learners=[];
  for(const learnerId of learnerIds){
   const learner=await loadLearnerForCard(req.params.schoolId,learnerId,academicYearId,yearLabel);
   if(!learner)throw Object.assign(new Error('One or more selected learners are not active in this school.'),{status:404});
   learners.push(learner);
  }
  if(issue){client=await db.pool.connect();await client.query('BEGIN');}
  const files=[];
  for(const learner of learners){
   let card={cardReference:'PREVIEW'},renderLearner=learner,selectedTemplate=template;
   if(issue){
    const issued=await issueOrReprintLearnerCard(req,learner,template,academicYearId,false,client);
    card={cardReference:issued.card.card_reference};
    renderLearner=issued.snapshot;selectedTemplate=issued.card.template_id;
    card.qrBuffer=await QRCode.toBuffer(verificationUrl(req,'/verify-id-card.html',issued.token),{errorCorrectionLevel:'M',margin:1,width:180});
   }
   const admission=clean(renderLearner.admission_no,80).replace(/[^a-zA-Z0-9_-]/g,'-')||'learner';
   files.push({
    name:`ID_${admission}${issue?`_${card.cardReference}`:'_PREVIEW'}.pdf`,
    buffer:await createIdCardPdf(renderLearner,selectedTemplate,card,side)
   });
  }
  const output=format==='zip'?await createIdCardArchive(files):await createCombinedIdCardPdf(files);
  if(issue)await client.query('COMMIT');
  if(client){client.release();client=null;}
  return output;
 }catch(error){
  if(client){await client.query('ROLLBACK').catch(()=>{});client.release();client=null;}
  throw error;
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

router.get('/verify-token',async(req,res)=>{
 try{
  const token=clean(req.query.token,100);
  if(!/^[A-Za-z0-9_-]{40,50}$/.test(token))return res.json({valid:false,status:'INVALID'});
  const record=(await db.query(`SELECT c.certificate_no,c.title,c.issued_on,c.status,s.name school_name
    FROM school_academic_certificates c JOIN schools s ON s.id=c.school_id
    WHERE c.verification_token_hash=$1 AND c.status IN ('ISSUED','REVOKED')`,
  [documentTokenHash(token)])).rows[0];
  if(!record)return res.json({valid:false,status:'INVALID'});
  res.json({valid:record.status==='ISSUED',status:record.status,certificate_no:record.certificate_no,title:record.title,issued_on:record.issued_on,school_name:record.school_name});
 }catch(error){console.error('Verify academic certificate token failed:',error);res.status(500).json({error:'Unable to verify this certificate right now.'});}
});

router.get('/verify-id',async(req,res)=>{
 try{
  const token=clean(req.query.token,100);
  if(!/^[A-Za-z0-9_-]{40,50}$/.test(token))return res.json({valid:false,status:'INVALID'});
  const record=(await db.query(`SELECT c.card_reference,c.status,s.name school_name
    FROM school_learner_cards c JOIN schools s ON s.id=c.school_id
    WHERE c.verification_token_hash=$1`,[documentTokenHash(token)])).rows[0];
  if(!record)return res.json({valid:false,status:'INVALID'});
  res.json({valid:record.status==='ACTIVE',status:record.status,card_reference:record.card_reference,school_name:record.school_name});
 }catch(error){console.error('Verify learner ID card failed:',error);res.status(500).json({error:'Unable to verify this ID card right now.'});}
});

router.use(authenticate);

router.get('/:schoolId/templates',schoolBoundary,roles(...VIEW),async(req,res)=>{
 const type=String(req.query.document_type||'');
 const category=String(req.query.category||'DEFAULT');
 if(!['ID_CARD','CERTIFICATE'].includes(type))return res.status(400).json({error:'Select ID_CARD or CERTIFICATE.'});
 if(type==='ID_CARD'&&category!=='DEFAULT')return res.status(400).json({error:'ID card preferences use the DEFAULT category.'});
 if(type==='CERTIFICATE'&&category!=='DEFAULT'&&!validDocumentCategory(category))return res.status(400).json({error:'Select a valid certificate category.'});
 try{
  const saved=await db.query(`SELECT template_id FROM school_document_template_preferences
    WHERE school_id=$1 AND document_type=$2 AND category=$3`,
  [req.params.schoolId,type,category]);
  const options=documentTemplates(type);
  res.json({document_type:type,category,templates:options,selected:options.some(item=>item.id===saved.rows[0]?.template_id)?saved.rows[0].template_id:options[0].id});
 }catch(error){console.error('Load document template preferences failed:',error);res.status(500).json({error:'Unable to load document designs. Apply migration 043_document_studio_preferences.sql.'});}
});

router.put('/:schoolId/templates',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const type=String(req.body?.document_type||''),category=String(req.body?.category||'DEFAULT'),template=String(req.body?.template_id||'');
 if(!['ID_CARD','CERTIFICATE'].includes(type))return res.status(400).json({error:'Select ID_CARD or CERTIFICATE.'});
 if(type==='ID_CARD'&&category!=='DEFAULT')return res.status(400).json({error:'ID card preferences use the DEFAULT category.'});
 if(type==='CERTIFICATE'&&category!=='DEFAULT'&&!validDocumentCategory(category))return res.status(400).json({error:'Select a valid certificate category.'});
 if(!documentTemplate(template,type))return res.status(400).json({error:'Select an available design for this document type.'});
 try{
  const saved=await db.query(`INSERT INTO school_document_template_preferences
      (school_id,document_type,category,template_id,updated_by)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(school_id,document_type,category) DO UPDATE SET
      template_id=EXCLUDED.template_id,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING document_type,category,template_id,updated_at`,
  [req.params.schoolId,type,category,template,req.user.user_id]);
  res.json(saved.rows[0]);
 }catch(error){console.error('Save document template preference failed:',error);res.status(500).json({error:'Unable to save the school document design. Apply migration 043_document_studio_preferences.sql.'});}
});

router.get('/:schoolId/academic-certificates',schoolBoundary,roles(...VIEW),async(req,res)=>{
 try{
  const status=String(req.query.status||'').toUpperCase();
  if(status&&!['DRAFT','ISSUED','REVOKED'].includes(status))return res.status(400).json({error:'Invalid certificate status filter.'});
  const category=String(req.query.category||'').toUpperCase(),yearId=req.query.academic_year_id||null,termId=req.query.term_id||null,classId=req.query.class_id||null;
  const search=clean(req.query.search,100);
  if(category&&!validDocumentCategory(category))return res.status(400).json({error:'Invalid certificate category filter.'});
  for(const [label,value] of [['academic year',yearId],['term',termId],['class',classId]])if(value&&!uuid.test(value))return res.status(400).json({error:`Invalid ${label} filter.`});
  const paginated=req.query.page!==undefined||req.query.page_size!==undefined;
  const page=paginated?Number(req.query.page||1):1,pageSize=paginated?Number(req.query.page_size||30):500;
  if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)return res.status(400).json({error:'Invalid certificate register page.'});
  const offset=(page-1)*pageSize,params=[req.params.schoolId,status||null,category||null,yearId,termId,classId,search?`%${search}%`:null];
  const joins=`FROM school_academic_certificates c
    JOIN learners l ON l.id=c.learner_id AND l.school_id=c.school_id
    LEFT JOIN learner_enrollments le ON le.school_id=c.school_id AND le.learner_id=l.id
      AND le.academic_year_id=COALESCE($4::uuid,c.academic_year_id)
    LEFT JOIN classes cl ON cl.id=COALESCE(le.class_id,l.class_id) AND cl.school_id=c.school_id
    LEFT JOIN academic_years ay ON ay.id=c.academic_year_id AND ay.school_id=c.school_id
    LEFT JOIN terms t ON t.id=c.term_id AND t.school_id=c.school_id
    LEFT JOIN users creator ON creator.id=c.created_by
    LEFT JOIN users issuer ON issuer.id=c.issued_by
    LEFT JOIN school_academic_certificates replaced ON replaced.id=c.replaces_certificate_id AND replaced.school_id=c.school_id
    LEFT JOIN school_academic_certificates replacement ON replacement.replaces_certificate_id=c.id AND replacement.school_id=c.school_id
    WHERE c.school_id=$1 AND ($2::text IS NULL OR c.status=$2)
      AND ($3::text IS NULL OR c.category=$3)
      AND ($4::uuid IS NULL OR c.academic_year_id=$4)
      AND ($5::uuid IS NULL OR c.term_id=$5)
      AND ($6::uuid IS NULL OR COALESCE(le.class_id,l.class_id)=$6)
      AND ($7::text IS NULL OR c.certificate_no ILIKE $7 OR l.admission_no ILIKE $7
        OR l.first_name ILIKE $7 OR l.middle_name ILIKE $7 OR l.last_name ILIKE $7
        OR concat_ws(' ',l.first_name,l.middle_name,l.last_name) ILIKE $7)`;
  const count=paginated?Number((await db.query(`SELECT count(*)::int count ${joins}`,params)).rows[0].count):null;
  const rows=await db.query(`SELECT c.id,c.learner_id,c.certificate_no,c.category,c.title,c.achievement_statement,c.status,c.issued_on,
      c.template_id,c.subject_or_activity,c.achievement_date,c.signer_name,c.signer_title,c.second_signer_name,c.second_signer_title,
      c.replaces_certificate_id,replaced.certificate_no replaced_certificate_no,replacement.certificate_no replacement_certificate_no,
      c.academic_year_id,c.term_id,c.created_at,c.issued_at,c.revoked_at,c.revocation_reason,
      l.admission_no,l.first_name,l.middle_name,l.last_name,cl.name class_name,cl.stream,
      ay.year_label,t.term_no,t.name term_name,
      creator.first_name creator_first_name,creator.last_name creator_last_name,
      issuer.first_name issuer_first_name,issuer.last_name issuer_last_name
    ${joins}
    ORDER BY c.created_at DESC,c.id DESC LIMIT $8 OFFSET $9`,
  [...params,pageSize,offset]);
  res.json(paginated?{rows:rows.rows,pagination:{page,page_size:pageSize,total:count,pages:Math.ceil(count/pageSize)}}:rows.rows);
 }catch(error){console.error('Load academic certificates failed:',error);res.status(500).json({error:'Unable to load academic certificates. Ensure migrations 040 and 045 are applied.'});}
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
   await validateCertificateReplacement(client,sid,input.replaces_certificate_id);
   const number=`ZAC-${new Date().getUTCFullYear()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
   const row=(await client.query(`INSERT INTO school_academic_certificates
      (school_id,learner_id,academic_year_id,term_id,certificate_no,category,title,achievement_statement,
       subject_or_activity,achievement_date,signer_name,signer_title,second_signer_name,second_signer_title,replaces_certificate_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [sid,input.learner_id,input.academic_year_id,input.term_id,number,input.category,input.title,input.achievement_statement,
     input.subject_or_activity,input.achievement_date,input.signer_name,input.signer_title,input.second_signer_name,input.second_signer_title,input.replaces_certificate_id,req.user.user_id])).rows[0];
   await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
      VALUES($1,$2,'ACADEMIC_CERTIFICATE_DRAFT_CREATED','school_academic_certificate',$3,$4::jsonb)`,
    [sid,req.user.user_id,row.id,JSON.stringify({certificate_no:number,learner_id:input.learner_id,title:input.title,replaces_certificate_id:input.replaces_certificate_id})]);
   await client.query('COMMIT');
   res.status(201).json(row);
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
  finally{client.release();}
 }catch(error){if(error.status)return res.status(error.status).json({error:error.message});console.error('Create academic certificate draft failed:',error);res.status(500).json({error:'Unable to create certificate draft.'});}
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
  await validateCertificateReplacement(client,req.params.schoolId,input.replaces_certificate_id,current.id);
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
  const updated=(await client.query(`UPDATE school_academic_certificates SET learner_id=$3,academic_year_id=$4,term_id=$5,category=$6,title=$7,achievement_statement=$8,
      subject_or_activity=$9,achievement_date=$10,signer_name=$11,signer_title=$12,second_signer_name=$13,second_signer_title=$14,
      replaces_certificate_id=$15,updated_at=now()
    WHERE school_id=$1 AND id=$2 RETURNING *`,
   [req.params.schoolId,current.id,input.learner_id,input.academic_year_id,input.term_id,input.category,input.title,input.achievement_statement,
    input.subject_or_activity,input.achievement_date,input.signer_name,input.signer_title,input.second_signer_name,input.second_signer_title,input.replaces_certificate_id])).rows[0];
  await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
    VALUES($1,$2,'ACADEMIC_CERTIFICATE_DRAFT_UPDATED','school_academic_certificate',$3,$4::jsonb)`,
   [req.params.schoolId,req.user.user_id,current.id,JSON.stringify({certificate_no:current.certificate_no,previous_title:current.title,title:input.title,replaces_certificate_id:input.replaces_certificate_id})]);
  await client.query('COMMIT');res.json(updated);
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  if(error.status)return res.status(error.status).json({error:error.message});
  console.error('Update academic certificate draft failed:',error);res.status(500).json({error:'Unable to update certificate draft.'});
 }finally{client.release();}
});

router.post('/:schoolId/academic-certificates/:certificateId/issue',schoolBoundary,roles(...ISSUE),async(req,res)=>{
 if(!uuid.test(req.params.certificateId))return res.status(400).json({error:'Invalid certificate ID.'});
 const requestedTemplate=req.body?.template_id;
 if(requestedTemplate&&!documentTemplate(requestedTemplate,'CERTIFICATE'))return res.status(400).json({error:'Select a supported certificate design.'});
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');
  const current=(await client.query('SELECT * FROM school_academic_certificates WHERE school_id=$1 AND id=$2 FOR UPDATE',[req.params.schoolId,req.params.certificateId])).rows[0];
  if(!current){await client.query('ROLLBACK');return res.status(404).json({error:'Certificate not found.'});}
  assertCertificateTransition(current.status,'ISSUED');
  const preference=(await client.query(`SELECT template_id FROM school_document_template_preferences
    WHERE school_id=$1 AND document_type='CERTIFICATE' AND category IN ($2,'DEFAULT')
    ORDER BY CASE WHEN category=$2 THEN 0 ELSE 1 END LIMIT 1`,
  [req.params.schoolId,current.category])).rows[0]?.template_id;
  const template=requestedTemplate||documentTemplate(preference,'CERTIFICATE')||'classic';
  const issued=(await client.query(`UPDATE school_academic_certificates SET status='ISSUED',issued_on=CURRENT_DATE,issued_by=$3,issued_at=now(),template_id=$4,updated_at=now()
    WHERE school_id=$1 AND id=$2 RETURNING *`,[req.params.schoolId,current.id,req.user.user_id,template])).rows[0];
  const token=randomDocumentToken();
  const snapshot=await loadCertificateIssueSnapshot(client,req.params.schoolId,current.id,req.user.user_id,req.user.role,template);
  const saved=(await client.query(`UPDATE school_academic_certificates SET snapshot=$3::jsonb,verification_token_hash=$4,verification_token_ciphertext=$5
    WHERE school_id=$1 AND id=$2 RETURNING *`,
  [req.params.schoolId,current.id,JSON.stringify(snapshot),documentTokenHash(token),encryptDocumentToken(token)])).rows[0];
  await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
    VALUES($1,$2,'ACADEMIC_CERTIFICATE_ISSUED','school_academic_certificate',$3,$4::jsonb)`,
   [req.params.schoolId,req.user.user_id,current.id,JSON.stringify({certificate_no:current.certificate_no,template_id:template,category:current.category,replaces_certificate_id:current.replaces_certificate_id})]);
  await client.query('COMMIT');
  res.json({id:saved.id,certificate_no:saved.certificate_no,status:saved.status,issued_on:saved.issued_on,issued_at:saved.issued_at,template_id:saved.template_id});
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
  const requestedTemplate=req.query.template?documentTemplate(req.query.template,'CERTIFICATE'):null;
  if(req.query.template&&!requestedTemplate)return res.status(400).json({error:'Select a supported certificate design.'});
  let row=(await db.query(`SELECT c.*,l.admission_no,l.first_name,l.middle_name,l.last_name,l.passport_photo_url,
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
    let template=requestedTemplate||'classic';
    if(row.snapshot&&typeof row.snapshot==='object'){
     const snapshot=row.snapshot,tokenCiphertext=row.verification_token_ciphertext;
     row={...snapshot,status:row.status,issued_on:row.issued_on,revoked_at:row.revoked_at,revocation_reason:row.revocation_reason};
     template=documentTemplate(snapshot.template_id,'CERTIFICATE')||template;
     if(tokenCiphertext){
      const token=decryptDocumentToken(tokenCiphertext);
      row.qrBuffer=await QRCode.toBuffer(verificationUrl(req,'/certificate-verification.html',token),{errorCorrectionLevel:'M',margin:1,width:180});
     }
    }
  const pdf=new PDFDocument({size:'A4',layout:'landscape',margin:0,info:{Title:row.title,Author:row.school_name}});
  const filename=`academic-certificate-${row.certificate_no}-${template}.pdf`;
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`${req.query.download==='1'?'attachment':'inline'}; filename="${filename}"`);
  pdf.pipe(res);renderCertificate(pdf,row,template);
  pdf.end();
 }catch(error){console.error('Generate academic certificate PDF failed:',error);if(!res.headersSent)res.status(500).json({error:'Unable to generate certificate PDF.'});else res.end();}
});

router.get('/:schoolId/learners/:learnerId/id-card.pdf',schoolBoundary,roles(...VIEW),async(req,res)=>{
 let client=null;
 try{
  if(!uuid.test(req.params.learnerId))return res.status(400).json({error:'Invalid learner ID.'});
  const requestedTemplate=documentTemplate(req.query.template,'ID_CARD');
  if(!requestedTemplate)return res.status(400).json({error:'Select a supported ID card design.'});
  const issue=req.query.issue==='1';
  if(issue&&!ISSUE.includes(String(req.user.role||'').toUpperCase()))return res.status(403).json({error:'Only authorised school leaders can issue or reprint ID cards.'});
  const academicYearId=req.query.academic_year_id||null;
  if(academicYearId&&!uuid.test(academicYearId))return res.status(400).json({error:'Invalid academic year.'});
  let yearLabel=null;
  if(academicYearId){
   yearLabel=(await db.query('SELECT year_label FROM academic_years WHERE school_id=$1 AND id=$2',[req.params.schoolId,academicYearId])).rows[0]?.year_label;
   if(!yearLabel)return res.status(400).json({error:'Academic year does not belong to this school.'});
  }
  const learner=await loadLearnerForCard(req.params.schoolId,req.params.learnerId,academicYearId,yearLabel);
  if(!learner)return res.status(404).json({error:'Active learner not found in this school.'});
  if(issue){client=await db.pool.connect();await client.query('BEGIN');}
  const issued=issue?await issueOrReprintLearnerCard(req,learner,requestedTemplate,academicYearId,false,client):null;
  const renderLearner=issued?issued.snapshot:learner;
  const template=issued?issued.card.template_id:requestedTemplate;
  const cardReference=issued?.card.card_reference||'PREVIEW';
  const qrBuffer=issued?await QRCode.toBuffer(verificationUrl(req,'/verify-id-card.html',issued.token),{errorCorrectionLevel:'M',margin:1,width:180}):null;
  const side=req.query.side==='both'?'both':'front';
  const pdfBuffer=await createIdCardPdf(renderLearner,template,{qrBuffer,cardReference},side);
  const person=[renderLearner.first_name,renderLearner.middle_name,renderLearner.last_name].filter(Boolean).join('_').replace(/[^a-zA-Z0-9_-]/g,'-');
  const filename=`ZelimuCBC_ID_${clean(renderLearner.admission_no,80).replace(/[^a-zA-Z0-9_-]/g,'-')||'card'}_${person||'learner'}_${template}.pdf`;
  if(client){await client.query('COMMIT');client.release();client=null;}
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`${req.query.download==='1'?'attachment':'inline'}; filename="${filename}"`);
  if(issued)res.setHeader('X-Card-Reference',cardReference);
  res.send(pdfBuffer);
 }catch(error){if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}console.error('Generate learner ID card failed:',error);if(!res.headersSent)res.status(500).json({error:'Unable to generate learner ID card.'});else res.end();}
});

router.get('/:schoolId/learners/:learnerId/id-card',schoolBoundary,roles(...VIEW),async(req,res)=>{
 try{
  if(!uuid.test(req.params.learnerId))return res.status(400).json({error:'Invalid learner ID.'});
  const record=(await db.query(`SELECT id,card_reference,status,template_id,issued_at
    FROM school_learner_cards WHERE school_id=$1 AND learner_id=$2
    ORDER BY issued_at DESC LIMIT 1`,[req.params.schoolId,req.params.learnerId])).rows[0];
  res.json(record||null);
 }catch(error){console.error('Load learner ID card status failed:',error);res.status(500).json({error:'Unable to load learner ID card status.'});}
});

router.post('/:schoolId/id-cards/bulk.zip',schoolBoundary,roles(...ISSUE),async(req,res)=>{
 try{
  const archiveBuffer=await buildBulkIdCards(req,'zip');
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="learner-id-cards-${new Date().toISOString().slice(0,10)}.zip"`);
  res.setHeader('X-Card-Count',String(req.body.learner_ids.length));
  res.send(archiveBuffer);
 }catch(error){
  if(error.status)return res.status(error.status).json({error:error.message});
  console.error('Generate bulk learner ID cards failed:',error);
  if(!res.headersSent)res.status(500).json({error:'Unable to generate bulk learner ID cards.'});
  else res.end();
 }
});

router.post('/:schoolId/id-cards/bulk.pdf',schoolBoundary,roles(...ISSUE),async(req,res)=>{
 try{
  const pdf=await buildBulkIdCards(req,'pdf');
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="learner-id-cards-${new Date().toISOString().slice(0,10)}.pdf"`);
  res.setHeader('X-Card-Count',String(req.body.learner_ids.length));
  res.send(pdf);
 }catch(error){
  if(error.status)return res.status(error.status).json({error:error.message});
  console.error('Generate combined learner ID cards failed:',error);
  if(!res.headersSent)res.status(500).json({error:'Unable to generate combined learner ID cards.'});
  else res.end();
 }
});

router.post('/:schoolId/learners/:learnerId/id-card/replace',schoolBoundary,roles(...ISSUE),async(req,res)=>{
 try{
  if(!uuid.test(req.params.learnerId))return res.status(400).json({error:'Invalid learner ID.'});
  const reason=clean(req.body?.reason,500);
  if(reason.length<4)return res.status(400).json({error:'Enter a replacement reason of at least four characters.'});
  const template=documentTemplate(req.body?.template_id,'ID_CARD');
  if(!template)return res.status(400).json({error:'Select a supported ID card design.'});
  const academicYearId=req.body?.academic_year_id||null;
  if(academicYearId&&!uuid.test(academicYearId))return res.status(400).json({error:'Invalid academic year.'});
  let yearLabel=null;
  if(academicYearId){
   yearLabel=(await db.query('SELECT year_label FROM academic_years WHERE school_id=$1 AND id=$2',[req.params.schoolId,academicYearId])).rows[0]?.year_label;
   if(!yearLabel)return res.status(400).json({error:'Academic year does not belong to this school.'});
  }
  const learner=await loadLearnerForCard(req.params.schoolId,req.params.learnerId,academicYearId,yearLabel);
  if(!learner)return res.status(404).json({error:'Active learner not found in this school.'});
  const {card}=await issueOrReprintLearnerCard(req,learner,template,academicYearId,true,null,reason);
  res.status(201).json({card_reference:card.card_reference,status:card.status});
 }catch(error){console.error('Replace learner ID card failed:',error);res.status(500).json({error:'Unable to replace learner ID card.'});}
});

router.post('/:schoolId/id-cards/:cardId/revoke',schoolBoundary,roles(...ISSUE),async(req,res)=>{
 const client=await db.pool.connect();
 try{
  if(!uuid.test(req.params.cardId))return res.status(400).json({error:'Invalid ID card.'});
  const reason=clean(req.body?.reason,500);
  if(reason.length<4)return res.status(400).json({error:'Enter a revocation reason of at least four characters.'});
  await client.query('BEGIN');
  const result=await client.query(`UPDATE school_learner_cards SET status='REVOKED'
    WHERE school_id=$1 AND id=$2 AND status='ACTIVE' RETURNING card_reference`,
  [req.params.schoolId,req.params.cardId]);
  if(!result.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Active ID card not found.'});}
  await client.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details)
    VALUES($1,$2,'LEARNER_ID_CARD_REVOKED','school_learner_card',$3,$4::jsonb)`,
  [req.params.schoolId,req.user.user_id,req.params.cardId,JSON.stringify({card_reference:result.rows[0].card_reference,reason})]);
  await client.query('COMMIT');
  res.json({ok:true});
 }catch(error){await client.query('ROLLBACK').catch(()=>{});console.error('Revoke learner ID card failed:',error);res.status(500).json({error:'Unable to revoke learner ID card.'});}
 finally{client.release();}
});
module.exports=router;
