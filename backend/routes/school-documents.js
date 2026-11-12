const express=require('express');
const PDFDocument=require('pdfkit');
const db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const router=express.Router();router.use(authenticate);
const VIEW=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'];
const WRITE=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean=(v,n=250)=>String(v||'').trim().slice(0,n);
const fmt=n=>Number(n||0).toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2});
async function school(sid){const q=await db.query('SELECT s.name,s.code,si.motto,si.address,si.contact_phone,si.contact_email FROM schools s LEFT JOIN school_identity si ON si.school_id=s.id WHERE s.id=$1',[sid]);if(!q.rows[0])throw Object.assign(new Error('School not found'),{status:404});return q.rows[0]}
function pdfStart(res,name){res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`inline; filename="${name}"`);const p=new PDFDocument({size:'A4',margin:50,info:{Title:name,Author:'ZELIMU CBC'}});p.pipe(res);return p}
function header(p,s,title){p.rect(0,0,595,12).fill('#2264c9');p.fillColor('#17345b').font('Helvetica-Bold').fontSize(18).text(s.name,{align:'center'});p.font('Helvetica').fontSize(9).fillColor('#475569').text([s.address,s.contact_phone,s.contact_email].filter(Boolean).join('  |  '),{align:'center'});p.moveDown(.7);p.strokeColor('#d6e2ef').moveTo(50,p.y).lineTo(545,p.y).stroke();p.moveDown(.8);p.fillColor('#143d75').font('Helvetica-Bold').fontSize(15).text(title,{align:'center'});p.moveDown(1.3)}
function line(p,k,v){p.font('Helvetica-Bold').fontSize(10).fillColor('#243449').text(k,55,p.y,{continued:true});p.font('Helvetica').text('  '+String(v||'—'));p.moveDown(.5)}
router.get('/:schoolId/fee-structures/:id/pdf',schoolBoundary,roles(...VIEW),async(req,res)=>{try{
 const sid=req.params.schoolId;if(!uuid.test(req.params.id))return res.status(400).json({error:'Invalid fee structure ID'});
 const q=await db.query(`SELECT f.*,a.year_label,c.name class_name,c.stream FROM school_fee_structures f LEFT JOIN academic_years a ON a.id=f.academic_year_id AND a.school_id=f.school_id LEFT JOIN classes c ON c.id=f.class_id AND c.school_id=f.school_id WHERE f.school_id=$1 AND f.id=$2`,[sid,req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Fee structure not found'});
 const f=q.rows[0],s=await school(sid),p=pdfStart(res,'fee-structure-'+f.id+'.pdf');header(p,s,'OFFICIAL FEE STRUCTURE');line(p,'Fee item:',f.name);line(p,'Academic year:',f.year_label||'Not specified');line(p,'Class / stream:',[f.class_name,f.stream].filter(Boolean).join(' ')||'Not specified');line(p,'Due date:',f.due_on?String(f.due_on).slice(0,10):'Not specified');p.moveDown(1);const y=p.y;p.rect(50,y,495,46).fill('#eaf3ff');p.fillColor('#163e75').font('Helvetica-Bold').fontSize(16).text(`Amount: ${f.currency} ${fmt(f.amount)}`,64,y+14);p.y=y+66;if(f.print_notes){p.font('Helvetica-Bold').fontSize(10).fillColor('#243449').text('School instructions / additional information');p.moveDown(.4);p.font('Helvetica').fontSize(10).fillColor('#334155').text(f.print_notes,{width:490});p.moveDown(1);}p.font('Helvetica').fontSize(9).fillColor('#64748b').text('Learner-specific fee statements show assigned charges, payments received and the current account balance.',{align:'center'});p.end();
 }catch(e){if(!res.headersSent)res.status(e.status||500).json({error:e.message});else res.end()}});
router.get('/:schoolId/fee-statements/:learnerId/pdf',schoolBoundary,roles(...VIEW),async(req,res)=>{try{
 const sid=req.params.schoolId,learnerId=req.params.learnerId;if(!uuid.test(learnerId))return res.status(400).json({error:'Invalid learner ID'});
 const learner=(await db.query(`SELECT l.id,l.admission_no,l.first_name,l.middle_name,l.last_name,c.name class_name,c.stream FROM learners l LEFT JOIN classes c ON c.id=l.class_id AND c.school_id=l.school_id WHERE l.school_id=$1 AND l.id=$2`,[sid,learnerId])).rows[0];if(!learner)return res.status(404).json({error:'Learner not found in this school'});
 const [charges,payments,totals]=await Promise.all([
  db.query(`SELECT ch.id,ch.description,ch.amount,ch.due_on,ch.created_at,fs.print_notes,COALESCE(a.paid,0) paid FROM school_fee_charges ch LEFT JOIN school_fee_structures fs ON fs.id=ch.fee_structure_id AND fs.school_id=ch.school_id LEFT JOIN (SELECT a.charge_id,sum(a.amount) paid FROM school_fee_payment_allocations a JOIN school_fee_payments p ON p.id=a.payment_id AND p.status='CONFIRMED' AND p.school_id=$1 WHERE a.school_id=$1 AND NOT EXISTS(SELECT 1 FROM school_fee_payment_reversals r WHERE r.school_id=p.school_id AND r.payment_id=p.id) GROUP BY a.charge_id) a ON a.charge_id=ch.id WHERE ch.school_id=$1 AND ch.learner_id=$2 ORDER BY ch.due_on NULLS LAST,ch.created_at,ch.id`,[sid,learnerId]),
  db.query(`SELECT p.receipt_no,p.amount,p.payment_date,p.payment_method,p.reference FROM school_fee_payments p WHERE p.school_id=$1 AND p.learner_id=$2 AND p.status='CONFIRMED' AND NOT EXISTS(SELECT 1 FROM school_fee_payment_reversals r WHERE r.school_id=p.school_id AND r.payment_id=p.id) ORDER BY p.payment_date,p.created_at,p.id`,[sid,learnerId]),
  db.query(`SELECT COALESCE((SELECT sum(amount) FROM school_fee_charges WHERE school_id=$1 AND learner_id=$2),0) charged,COALESCE((SELECT sum(amount) FROM school_fee_payments p WHERE p.school_id=$1 AND p.learner_id=$2 AND p.status='CONFIRMED' AND NOT EXISTS(SELECT 1 FROM school_fee_payment_reversals r WHERE r.school_id=p.school_id AND r.payment_id=p.id)),0) paid`,[sid,learnerId])
 ]);
 const fileLearner=String(learner.admission_no||learner.id).replace(/[^a-zA-Z0-9_-]/g,'-');
 const s=await school(sid),p=pdfStart(res,`fee-statement-${fileLearner}.pdf`);header(p,s,'LEARNER FEE STATEMENT');
 line(p,'Learner:',[learner.first_name,learner.middle_name,learner.last_name].filter(Boolean).join(' '));line(p,'Admission number:',learner.admission_no);line(p,'Current class:',[learner.class_name,learner.stream].filter(Boolean).join(' ')||'Not assigned');line(p,'Statement date:',new Date().toISOString().slice(0,10));
 p.moveDown(.5);p.font('Helvetica-Bold').fontSize(11).fillColor('#17345b').text('Assigned fee charges');p.moveDown(.5);
 const columns=[{label:'Fee item',x:55,w:195,align:'left'},{label:'Due',x:250,w:65,align:'left'},{label:'Charge',x:315,w:75,align:'right'},{label:'Paid',x:390,w:70,align:'right'},{label:'Balance',x:460,w:80,align:'right'}];
 const drawChargeHeader=()=>{const y=p.y;p.rect(50,y,495,22).fill('#17345b');columns.forEach(col=>p.fillColor('#fff').font('Helvetica-Bold').fontSize(8).text(col.label,col.x,y+6,{width:col.w-5,align:col.align,lineBreak:false}));p.y=y+28;};
 drawChargeHeader();
 if(!charges.rowCount){p.font('Helvetica').fontSize(9).fillColor('#475569').text('No charges have been assigned to this learner.');p.moveDown();}
 for(const charge of charges.rows){
  const cells=[charge.description,String(charge.due_on||'—').slice(0,10),fmt(charge.amount),fmt(charge.paid),fmt(Math.max(0,Number(charge.amount)-Number(charge.paid)))];
  const rowHeight=Math.max(...cells.map((value,index)=>p.heightOfString(String(value),{width:columns[index].w-7,font:'Helvetica',fontSize:8})))+10;
  if(p.y+rowHeight>p.page.height-65){p.addPage();header(p,s,'LEARNER FEE STATEMENT · CONTINUED');drawChargeHeader();}
  const y=p.y;p.fillColor('#334155').font('Helvetica').fontSize(8);cells.forEach((value,index)=>p.text(String(value),columns[index].x,y+4,{width:columns[index].w-7,align:columns[index].align}));p.strokeColor('#dbe3ec').moveTo(50,y+rowHeight).lineTo(545,y+rowHeight).stroke();p.y=y+rowHeight;
 }
 const charged=Number(totals.rows[0].charged),paid=Number(totals.rows[0].paid),balance=charged-paid;
 if(p.y+110>p.page.height-55){p.addPage();header(p,s,'LEARNER FEE STATEMENT · CONTINUED');}
 p.moveDown(.6);p.font('Helvetica-Bold').fontSize(9).fillColor('#17345b').text(`Total charges: KES ${fmt(charged)}`,{align:'right'});p.text(`Total payments received: KES ${fmt(paid)}`,{align:'right'});p.fontSize(12).text(`${balance<0?'Prepaid credit':'Outstanding balance'}: KES ${fmt(Math.abs(balance))}`,{align:'right'});
 if(p.y+40>p.page.height-55){p.addPage();header(p,s,'LEARNER FEE STATEMENT · CONTINUED');}
 p.moveDown(1);p.font('Helvetica-Bold').fontSize(11).fillColor('#17345b').text('Confirmed payment receipts');p.moveDown(.5);
 for(const payment of payments.rows){
  const receiptText=`${String(payment.payment_date).slice(0,10)}  ·  ${payment.receipt_no}  ·  ${payment.payment_method}  ·  KES ${fmt(payment.amount)}${payment.reference?'  ·  Ref '+payment.reference:''}`;
  p.font('Helvetica').fontSize(8).fillColor('#334155');
  const receiptHeight=p.heightOfString(receiptText,{width:485,font:'Helvetica',fontSize:8})+5;
  if(p.y+receiptHeight>p.page.height-50){p.addPage();header(p,s,'LEARNER FEE STATEMENT · CONTINUED');p.font('Helvetica-Bold').fontSize(10).fillColor('#17345b').text('Confirmed payment receipts · continued');p.moveDown(.4);p.font('Helvetica').fontSize(8).fillColor('#334155');}
  p.text(receiptText,55,p.y,{width:485});
 }
 const notes=[...new Set(charges.rows.map(charge=>String(charge.print_notes||'').trim()).filter(Boolean))];
 if(notes.length){
  if(p.y+25>p.page.height-50){p.addPage();header(p,s,'LEARNER FEE STATEMENT · CONTINUED');}
  p.moveDown(1);p.font('Helvetica-Bold').fontSize(10).fillColor('#17345b').text('School instructions');p.moveDown(.3);
  for(const note of notes){
   p.font('Helvetica').fontSize(9).fillColor('#334155');
   const noteHeight=p.heightOfString(note,{width:490,font:'Helvetica',fontSize:9})+12;
   if(p.y+noteHeight>p.page.height-50){p.addPage();header(p,s,'LEARNER FEE STATEMENT · CONTINUED');p.font('Helvetica-Bold').fontSize(10).fillColor('#17345b').text('School instructions · continued');p.moveDown(.3);p.font('Helvetica').fontSize(9).fillColor('#334155');}
   p.text(note,{width:490});p.moveDown(.6);
  }
 }
 p.end();
}catch(e){if(!res.headersSent)res.status(e.status||500).json({error:e.message});else res.end()}});
router.get('/:schoolId/leaving-certificates',schoolBoundary,roles(...VIEW),async(req,res)=>{try{const q=await db.query(`SELECT r.id,r.data,r.created_at,l.admission_no,l.first_name,l.middle_name,l.last_name FROM school_module_records r LEFT JOIN learners l ON l.id=(r.data->>'learner_id')::uuid AND l.school_id=r.school_id WHERE r.school_id=$1 AND r.record_type='leaving_certificate' ORDER BY r.created_at DESC LIMIT 250`,[req.params.schoolId]);res.json(q.rows)}catch(e){res.status(500).json({error:'Unable to load certificates'})}});
router.post('/:schoolId/leaving-certificates',schoolBoundary,roles(...WRITE),async(req,res)=>{try{
 const sid=req.params.schoolId,b=req.body||{};if(!uuid.test(b.learner_id))return res.status(400).json({error:'Select a valid learner'});
 const l=await db.query('SELECT id FROM learners WHERE school_id=$1 AND id=$2',[sid,b.learner_id]);if(!l.rows.length)return res.status(404).json({error:'Learner not found in this school'});
 const leaving=clean(b.leaving_date,10),admitted=clean(b.admission_date,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(leaving)||!Number.isFinite(Date.parse(leaving)))return res.status(400).json({error:'A valid leaving date is required'});
 if(admitted&&(!/^\d{4}-\d{2}-\d{2}$/.test(admitted)||Date.parse(admitted)>Date.parse(leaving)))return res.status(400).json({error:'Admission date must be valid and not later than leaving date'});
 const data={learner_id:b.learner_id,admission_date:admitted,leaving_date:leaving,reason:clean(b.reason),conduct:clean(b.conduct),destination:clean(b.destination),headteacher:clean(b.headteacher,120),remarks:clean(b.remarks),certificate_number:'ZLC-'+new Date().getFullYear()+'-'+require('crypto').randomUUID().slice(0,8).toUpperCase()};
 const q=await db.query(`INSERT INTO school_module_records(school_id,record_type,data,created_by) VALUES($1,'leaving_certificate',$2,$3) RETURNING *`,[sid,JSON.stringify(data),req.user.user_id]);res.status(201).json(q.rows[0]);
 }catch(e){res.status(400).json({error:e.message})}});
router.get('/:schoolId/leaving-certificates/:id/pdf',schoolBoundary,roles(...VIEW),async(req,res)=>{try{
 const sid=req.params.schoolId;if(!uuid.test(req.params.id))return res.status(400).json({error:'Invalid certificate ID'});
 const q=await db.query(`SELECT r.*,l.admission_no,l.first_name,l.middle_name,l.last_name,l.gender,c.name class_name,c.stream FROM school_module_records r JOIN learners l ON l.id=(r.data->>'learner_id')::uuid AND l.school_id=r.school_id LEFT JOIN classes c ON c.id=l.class_id AND c.school_id=r.school_id WHERE r.school_id=$1 AND r.record_type='leaving_certificate' AND r.id=$2`,[sid,req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Certificate not found'});
 const r=q.rows[0],d=r.data,s=await school(sid),p=pdfStart(res,'leaving-certificate-'+r.id+'.pdf');header(p,s,'SCHOOL LEAVING CERTIFICATE');
 p.font('Helvetica').fontSize(10).fillColor('#334155').text('This is to certify that the learner named below was enrolled at this school, according to the school records.',{align:'left'});p.moveDown(1.5);
 line(p,'Certificate number:',d.certificate_number);line(p,'Learner:',[r.first_name,r.middle_name,r.last_name].filter(Boolean).join(' '));line(p,'Admission number:',r.admission_no);line(p,'Class / stream at issue:',[r.class_name,r.stream].filter(Boolean).join(' '));line(p,'Date of admission:',d.admission_date||'Not recorded');line(p,'Date of leaving:',d.leaving_date);line(p,'Reason for leaving:',d.reason||'Not recorded');line(p,'Conduct:',d.conduct||'Not recorded');line(p,'Next institution / destination:',d.destination||'Not recorded');line(p,'Remarks:',d.remarks||'None');p.moveDown(3);
 p.strokeColor('#9aa9b8').moveTo(55,p.y).lineTo(260,p.y).stroke();p.moveDown(.5);p.font('Helvetica').fontSize(10).text('Headteacher: '+(d.headteacher||'________________'),55);p.moveDown(1.5);p.text('Official school stamp: __________________________',55);p.moveDown(2);p.fillColor('#64748b').fontSize(8).text('Generated by ZELIMU CBC. Validate this certificate against the school register. A signature and stamp must be applied by an authorised officer.',{align:'center'});p.end();
 }catch(e){if(!res.headersSent)res.status(e.status||500).json({error:e.message});else res.end()}});
module.exports=router;
