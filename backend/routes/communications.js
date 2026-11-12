const express=require('express'),db=require('../db');
const ExcelJS=require('exceljs');
const {buildTermReport}=require('../services/report-engine');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const router=express.Router();
const analyticsResponseCache=new Map();
router.use(authenticate);
function buildPublicationSummary(rows){
 return rows.reduce((summary,row)=>({
  publications:summary.publications+1,
  learners:summary.learners+Number(row.published_learners||0),
  sms_sent:summary.sms_sent+Number(row.sms_sent||0),
  sms_queued:summary.sms_queued+Number(row.sms_queued||0),
  sms_sending:summary.sms_sending+Number(row.sms_sending||0),
  sms_failed:summary.sms_failed+Number(row.sms_failed||0),
  sms_skipped:summary.sms_skipped+Number(row.sms_skipped||0)
 }),{publications:0,learners:0,sms_sent:0,sms_queued:0,sms_sending:0,sms_failed:0,sms_skipped:0});
}
router.post('/:schoolId/analytics-export.xlsx',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
 try{
  const {title,headers,rows}=req.body||{};
  if(!Array.isArray(headers)||headers.length<1||headers.length>50||!Array.isArray(rows)||rows.length>10000||rows.some(row=>!Array.isArray(row)||row.length!==headers.length)){
   return res.status(400).json({error:'Export data must contain 1-50 columns and no more than 10,000 consistently sized rows.'});
  }
  const workbook=new ExcelJS.Workbook();
  const sheet=workbook.addWorksheet(String(title||'Academic analysis').replace(/[\\/*?:\[\]]/g,' ').slice(0,31)||'Academic analysis');
  sheet.columns=headers.map((header,index)=>({key:`column${index}`,header:String(header??'').slice(0,200),width:18}));
  sheet.getRow(1).font={bold:true};
  for(const row of rows)sheet.addRow(row.map(value=>{
   if(value==null)return '';
   if(typeof value==='number')return Number.isFinite(value)?value:'';
   if(typeof value==='boolean')return value;
   if(typeof value==='string')return value.length>32000?value.slice(0,32000):value;
   return String(value).slice(0,32000);
  }));
  sheet.views=[{state:'frozen',ySplit:1}];
  sheet.columns.forEach(column=>{column.width=Math.min(40,Math.max(12,...sheet.getColumn(column.number).values.slice(1,21).map(value=>String(value??'').length+2)));});
  const file=await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="zelimu-academic-analysis.xlsx"');
  res.setHeader('Content-Length',String(file.length));
  res.end(file);
 }catch(e){console.error('Unable to generate academic analytics workbook:',e);res.status(500).json({error:'Unable to generate the Excel export.'});}
});
function normalizedPhone(phone){
 return String(phone||'').replace(/[\s()+-]/g,'');
}
function topmediaPhone(phone){
 const digits=normalizedPhone(phone);
 const international=digits.startsWith('0')?'254'+digits.slice(1):digits;
 return '+'+international;
}
function infobipTrialConfiguration(){
 const trialMode=String(process.env.SMS_INFOBIP_TRIAL_MODE||'').toLowerCase()==='true';
 const recipients=[...new Set(String(process.env.SMS_INFOBIP_TRIAL_RECIPIENTS||'')
  .split(',').map(normalizedPhone).filter(Boolean))];
 return {trialMode,recipients};
}
function smsDeliveryConfiguration(){
 const provider=String(process.env.SMS_PROVIDER||'').toUpperCase();
 const infobipBaseUrl=String(process.env.SMS_INFOBIP_BASE_URL||'').trim();
 const infobipApiKey=process.env.SMS_INFOBIP_API_KEY;
 if(provider==='INFOBIP'&&infobipBaseUrl&&infobipApiKey){
  const trial=infobipTrialConfiguration();
  try{
   if(new URL(infobipBaseUrl).protocol==='https:'&&(!trial.trialMode||trial.recipients.length))
    return {configured:true,provider:'INFOBIP',trial_mode:trial.trialMode,trial_recipient_count:trial.recipients.length};
  }catch{}
  return {configured:false,provider:'INFOBIP',trial_mode:trial.trialMode,trial_recipient_count:trial.recipients.length};
 }
 const topmediaApiKey=process.env.SMS_TOPMEDIA_API_KEY||process.env.TOPMEDIA_API_KEY;
 if(provider==='TOPMEDIA'&&topmediaApiKey)
  return {configured:true,provider:'TOPMEDIA'};
 const username=process.env.SMS_AFRICASTALKING_USERNAME||process.env.SMS_AFRICA_TALKING_USERNAME;
 const apiKey=process.env.SMS_AFRICA_TALKING_API_KEY||process.env.SMS_AFRICASTALKING_API_KEY;
 if(provider==='AFRICASTALKING'&&username&&apiKey)
  return {configured:true,provider:'AFRICASTALKING'};
 if(process.env.SMS_WEBHOOK_URL)return {configured:true,provider:'WEBHOOK'};
 return {configured:false,provider:null};
}
async function ensureAssessmentPublishSchema(){
 const result=await db.query(`
  SELECT
   EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema=ANY(current_schemas(false)) AND table_name='result_publications' AND column_name='assessment_id') publications_column,
   EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema=ANY(current_schemas(false)) AND table_name='result_publication_records' AND column_name='assessment_id') records_column
 `);
 if(!result.rows[0]?.publications_column||!result.rows[0]?.records_column)
  throw Object.assign(new Error('Apply database migration 036_publish_per_assessment.sql before publishing per assessment.'),{status:503});
}
async function assessmentResultSnapshot(sid,learnerId,yearId,termId,assessmentId){
 const meta=(await db.query(`
  SELECT a.id assessment_id,a.name assessment_name,
    CONCAT_WS(' ',l.first_name,l.middle_name,l.last_name) learner_name,l.admission_no,sc.name school_name
  FROM assessments a JOIN learners l ON l.id=$2 AND l.school_id=$1 JOIN schools sc ON sc.id=$1
  WHERE a.id=$5 AND a.school_id=$1 AND a.academic_year_id=$3 AND a.term_id=$4
 `,[sid,learnerId,yearId,termId,assessmentId])).rows[0];
 if(!meta)return null;
 const marks=(await db.query(`
  SELECT s.id subject_id,s.name subject_name,m.mark,a.max_mark
  FROM marks m JOIN subjects s ON s.id=m.subject_id JOIN assessments a ON a.id=m.assessment_id
  WHERE m.school_id=$1 AND m.learner_id=$2 AND m.academic_year_id=$3 AND m.term_id=$4 AND m.assessment_id=$5 AND m.mark IS NOT NULL
  ORDER BY s.name
 `,[sid,learnerId,yearId,termId,assessmentId])).rows;
 if(!marks.length)return null;
 const subjects=marks.map(x=>({subject_id:x.subject_id,subject_name:x.subject_name,mark:Number(x.mark),max_mark:Number(x.max_mark||100),percent:Number(x.max_mark)>0?Number((Number(x.mark)/Number(x.max_mark)*100).toFixed(2)):null}));
 const scored=subjects.filter(x=>x.percent!==null);
 return {assessment_id:meta.assessment_id,assessment_name:meta.assessment_name,school_name:meta.school_name,learner_name:meta.learner_name,admission_no:meta.admission_no,term_id:termId,subjects,overall_average:scored.length?Number((scored.reduce((sum,x)=>sum+x.percent,0)/scored.length).toFixed(2)):null,overall_grade:null};
}
async function deliverSms({phone,message,school_id,learner_id}){
  const provider=String(process.env.SMS_PROVIDER||'').toUpperCase();
  if(provider==='TOPMEDIA'){
   const apiKey=process.env.SMS_TOPMEDIA_API_KEY||process.env.TOPMEDIA_API_KEY;
   if(!apiKey)throw new Error('TopMediaSMS is not configured. Set SMS_TOPMEDIA_API_KEY on the server.');
   const base=String(process.env.SMS_TOPMEDIA_BASE_URL||'https://api.topmediasms.com/v1').trim().replace(/\/+$/, '');
   const payload={to:[topmediaPhone(phone)],message:String(message)};
   const sender=String(process.env.SMS_TOPMEDIA_SENDER_ID||'').trim();
   if(sender)payload.sender_id=sender;
   const response=await fetch(base+'/api-send-sms',{method:'POST',
     headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+apiKey},
     body:JSON.stringify(payload)});
   const data=await response.json().catch(()=>({}));
   if(!response.ok||data?.success===false)throw new Error(data?.message||data?.error||('TopMediaSMS returned '+response.status));
   return {status:'SENT',provider:'TOPMEDIA',providerMessageId:data?.message_id||null,response:data};
  }
  if(provider==='INFOBIP'){
    const baseUrl=String(process.env.SMS_INFOBIP_BASE_URL||'').trim().replace(/\/+$/,'');
    const apiKey=process.env.SMS_INFOBIP_API_KEY;
    if(!baseUrl||!apiKey)throw new Error('Infobip is not configured. Set SMS_INFOBIP_BASE_URL and SMS_INFOBIP_API_KEY on the server.');
    const trial=infobipTrialConfiguration();
    if(trial.trialMode&&!trial.recipients.includes(normalizedPhone(phone)))
      throw new Error('Not sent: recipient is not in the configured Infobip trial verified-number list.');
    let endpoint;
    try{
      endpoint=new URL(`${baseUrl}/sms/3/messages`);
      if(endpoint.protocol!=='https:')throw new Error('The Infobip base URL must use HTTPS.');
    }catch(e){throw new Error(`Invalid Infobip base URL: ${e.message}`);}
    const smsMessage={
      destinations:[{to:normalizedPhone(phone)}],
      content:{text:String(message)}
    };
    const sender=String(process.env.SMS_INFOBIP_SENDER||'').trim();
    if(sender)smsMessage.sender=sender;
    const response=await fetch(endpoint,{method:'POST',
      headers:{Accept:'application/json','Content-Type':'application/json',Authorization:`App ${apiKey}`},
      body:JSON.stringify({messages:[smsMessage]})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const description=data?.description||data?.requestError?.serviceException?.text||`Infobip returned ${response.status}`;
      throw new Error(description);
    }
    const messageResult=data?.messages?.[0];
    if(!messageResult)throw new Error('Infobip accepted no message; check the account response in Infobip.');
    const statusName=String(messageResult.status?.name||'').toUpperCase();
    const groupName=String(messageResult.status?.groupName||'').toUpperCase();
    if(groupName==='REJECTED'||statusName.includes('REJECT'))
      throw new Error(messageResult.status?.description||messageResult.status?.name||'Infobip rejected the message.');
    return {
      status:groupName==='PENDING'?'QUEUED':'SENT',
      provider:'INFOBIP',
      providerMessageId:messageResult.messageId||null,
      response:data
    };
  }
  const username=process.env.SMS_AFRICASTALKING_USERNAME||process.env.SMS_AFRICA_TALKING_USERNAME;
  const apiKey=process.env.SMS_AFRICA_TALKING_API_KEY||process.env.SMS_AFRICASTALKING_API_KEY;
  const environment=process.env.SMS_AFRICASTALKING_ENV||process.env.SMS_AFRICA_TALKING_ENV||'live';
  const senderId=process.env.SMS_AFRICASTALKING_SENDER_ID||process.env.SMS_AFRICA_TALKING_SENDER_ID;
  if(provider==='AFRICASTALKING' && username && apiKey){
    const base=String(environment).toLowerCase()==='sandbox'?'https://api.sandbox.africastalking.com':'https://api.africastalking.com';
    const form=new URLSearchParams({username,to:String(phone),message:String(message)});
    if(senderId)form.set('from',senderId);
    const rr=await fetch(`${base}/version1/messaging`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded',apiKey},body:form});
    const data=await rr.json().catch(()=>({}));
    if(!rr.ok)throw new Error(`Africa's Talking returned ${rr.status}`);
    const recipient=data?.SMSMessageData?.Recipients?.[0];
    if(recipient && recipient.status && !/success|sent|queued/i.test(String(recipient.status)))throw new Error(String(recipient.status));
    return {status:'SENT',provider:'AFRICASTALKING',response:data};
  }
  if(process.env.SMS_WEBHOOK_URL){
    const rr=await fetch(process.env.SMS_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,message,school_id,learner_id})});
    if(!rr.ok)throw new Error(`SMS webhook returned ${rr.status}`);
    return {status:'SENT',provider:'WEBHOOK'};
  }
  return {status:'QUEUED',provider:provider||'UNCONFIGURED'};
}

router.get('/:schoolId/parents',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER'),async(req,res)=>{try{const q=await db.query(`SELECT pg.*,count(lg.learner_id)::int learner_count FROM parent_guardians pg LEFT JOIN learner_guardians lg ON lg.parent_guardian_id=pg.id WHERE pg.school_id=$1 AND COALESCE(pg.is_active,true)=true GROUP BY pg.id ORDER BY pg.last_name,pg.first_name`,[req.params.schoolId]);res.json(q.rows)}catch(e){res.status(500).json({error:'Unable to load parents'})}});
router.post('/:schoolId/parents',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{try{const b=req.body;if(!String(b.first_name||'').trim()||!String(b.last_name||'').trim()||!String(b.phone||'').trim())return res.status(400).json({error:'Parent name and phone are required'});const q=await db.query(`INSERT INTO parent_guardians(school_id,first_name,last_name,relationship,phone,email,preferred_language,communication_consent,sms_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.params.schoolId,String(b.first_name).trim(),String(b.last_name).trim(),b.relationship||null,String(b.phone).trim(),b.email||null,b.preferred_language||null,b.communication_consent!==false,b.sms_enabled!==false]);res.status(201).json(q.rows[0])}catch(e){res.status(400).json({error:e.message})}});
router.patch('/:schoolId/parents/:parentId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{
 const b=req.body||{},sid=req.params.schoolId,id=req.params.parentId;
 const first=String(b.first_name||'').trim(),last=String(b.last_name||'').trim(),phone=String(b.phone||'').trim();
 if(!first||!last||!phone)return res.status(400).json({error:'Parent first name, last name and phone are required.'});
 try{
  const q=await db.query(`UPDATE parent_guardians SET first_name=$3,last_name=$4,relationship=$5,phone=$6,email=$7,preferred_language=$8,
    communication_consent=COALESCE($9,communication_consent),sms_enabled=COALESCE($10,sms_enabled)
    WHERE id=$1 AND school_id=$2 RETURNING *`,
   [id,sid,first,last,String(b.relationship||'').trim()||null,phone,String(b.email||'').trim()||null,String(b.preferred_language||'').trim()||null,
    b.communication_consent===undefined?null:Boolean(b.communication_consent),b.sms_enabled===undefined?null:Boolean(b.sms_enabled)]);
  if(!q.rows[0])return res.status(404).json({error:'Parent/guardian not found.'});
  res.json(q.rows[0]);
 }catch(e){res.status(400).json({error:e.message});}
});
// Removing a guardian unlinks them from every learner and deactivates the record
// instead of destroying message history needed for delivery auditing.
router.delete('/:schoolId/parents/:parentId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const sid=req.params.schoolId,id=req.params.parentId,c=await db.pool.connect();
 try{
  await c.query('BEGIN');
  const p=(await c.query('SELECT id FROM parent_guardians WHERE id=$1 AND school_id=$2 FOR UPDATE',[id,sid])).rows[0];
  if(!p)throw Object.assign(new Error('Parent/guardian not found.'),{status:404});
  await c.query('DELETE FROM learner_guardians WHERE parent_guardian_id=$1',[id]);
  await c.query('UPDATE parent_guardians SET is_active=false,sms_enabled=false,communication_consent=false WHERE id=$1 AND school_id=$2',[id,sid]);
  await c.query('COMMIT');
  res.json({ok:true,id,message:'Guardian unlinked from learners and deactivated. Message history is preserved.'});
 }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}
 finally{c.release();}
});
router.post('/:schoolId/publish-class-results',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const sid=req.params.schoolId,b=req.body||{};if(!b.academic_year_id||!b.term_id||!b.class_id)return res.status(400).json({error:'Academic year, term and class are required'});const learners=(await db.query(`SELECT l.id,l.first_name,l.middle_name,l.last_name FROM learner_enrollments e JOIN learners l ON l.id=e.learner_id WHERE e.school_id=$1 AND e.academic_year_id=$2 AND e.class_id=$3 AND COALESCE(e.status,'ACTIVE')='ACTIVE' AND COALESCE(l.is_active,true)=true ORDER BY l.last_name,l.first_name`,[sid,b.academic_year_id,b.class_id])).rows;let sent=0,queued=0,skipped=0,failed=0;const details=[];for(const l of learners){const learnerName=[l.first_name,l.middle_name,l.last_name].filter(Boolean).join(' ');let report=null;try{report=await buildTermReport(sid,l.id,b.academic_year_id,b.term_id);}catch(e){details.push({learner_id:l.id,learner:learnerName,status:'SKIPPED',reason:`Report error: ${e.message}`});skipped++;continue;}if(!report){details.push({learner_id:l.id,learner:learnerName,status:'SKIPPED',reason:'No report data was generated for this learner and term.'});skipped++;continue;}const guardianRows=(await db.query(`SELECT pg.id,pg.first_name,pg.last_name,pg.phone,COALESCE(pg.is_active,false) is_active,COALESCE(pg.sms_enabled,false) sms_enabled,COALESCE(pg.communication_consent,false) communication_consent FROM parent_guardians pg JOIN learner_guardians lg ON lg.parent_guardian_id=pg.id WHERE pg.school_id=$1 AND lg.learner_id=$2`,[sid,l.id])).rows;const eligible=guardianRows.filter(g=>g.is_active&&g.sms_enabled&&g.communication_consent&&String(g.phone||'').trim());if(!guardianRows.length){details.push({learner_id:l.id,learner:learnerName,status:'SKIPPED',reason:'No parent/guardian is linked to this learner.'});skipped++;continue;}if(!eligible.length){for(const g of guardianRows){const reasons=[];if(!g.is_active)reasons.push('parent inactive');if(!g.sms_enabled)reasons.push('SMS disabled');if(!g.communication_consent)reasons.push('communication consent not enabled');if(!String(g.phone||'').trim())reasons.push('no phone number');details.push({learner_id:l.id,learner:learnerName,parent_guardian_id:g.id,parent:`${g.first_name||''} ${g.last_name||''}`.trim(),phone:g.phone||'',status:'SKIPPED',reason:reasons.join('; ')||'Parent is not eligible for SMS.'});}skipped++;continue;}const body=String(b.message_template||`${report.school_name}: ${report.learner_name} ${report.term_name||'term'} results are published. Average ${report.overall_average==null?'—':Number(report.overall_average).toFixed(2)}, grade ${report.overall_grade||'—'}. Log in to ZELIMU CBC to view the full report.`).replaceAll('{learner}',report.learner_name).replaceAll('{average}',report.overall_average==null?'—':Number(report.overall_average).toFixed(2)).replaceAll('{grade}',report.overall_grade||'—');for(const g of eligible){const dup=await db.query(`SELECT id FROM communication_messages WHERE school_id=$1 AND learner_id=$2 AND parent_guardian_id=$3 AND academic_year_id=$4 AND term_id=$5 AND message_type='PUBLISHED_RESULTS' LIMIT 1`,[sid,l.id,g.id,b.academic_year_id,b.term_id]);if(dup.rows[0]){details.push({learner_id:l.id,learner:learnerName,parent_guardian_id:g.id,parent:`${g.first_name||''} ${g.last_name||''}`.trim(),phone:g.phone,status:'SKIPPED',reason:'Result notification was already published to this parent for this learner, academic year and term.'});skipped++;continue;}let status='QUEUED',provider=process.env.SMS_PROVIDER||'UNCONFIGURED',reason=null;try{const d=await deliverSms({phone:g.phone,message:body,school_id:sid,learner_id:l.id});status=d.status;provider=d.provider||provider;}catch(e){reason=e.message;status='FAILED';failed++;}if(status==='SENT')sent++;if(status==='QUEUED')queued++;details.push({learner_id:l.id,learner:learnerName,parent_guardian_id:g.id,parent:`${g.first_name||''} ${g.last_name||''}`.trim(),phone:g.phone,status,reason:reason||null});await db.query(`INSERT INTO communication_messages(school_id,learner_id,parent_guardian_id,channel,message_type,body,status,provider,failure_reason,created_by,sent_at,academic_year_id,term_id) VALUES($1,$2,$3,'SMS','PUBLISHED_RESULTS',$4,$5,$6,$7,$8,CASE WHEN $5='SENT' THEN now() ELSE NULL END,$9,$10)`,[sid,l.id,g.id,body,status,provider,reason,req.user.user_id,b.academic_year_id,b.term_id]);}}res.status(201).json({learners:learners.length,sent,queued,skipped,failed,details,message:'Class result publication completed; duplicate result notifications are skipped.'});}catch(e){res.status(400).json({error:e.message})}});
router.post('/:schoolId/link',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{
 const sid=req.params.schoolId;
 try{
  const {learner_id,parent_guardian_id,is_primary}=req.body||{};
  const learner=(await db.query('SELECT id FROM learners WHERE id=$1 AND school_id=$2',[learner_id,sid])).rows[0];
  const parent=(await db.query('SELECT id,COALESCE(is_active,true) is_active FROM parent_guardians WHERE id=$1 AND school_id=$2',[parent_guardian_id,sid])).rows[0];
  if(!learner||!parent)return res.status(404).json({error:'Learner or parent not found'});
  if(parent.is_active===false)return res.status(409).json({error:'That guardian has been removed. Restore or create an active guardian before linking.'});
  if(req.user.role==='CLASS_TEACHER'){
   const ok=(await db.query(`SELECT 1 FROM learner_enrollments e
     JOIN class_teacher_assignments cta ON cta.school_id=e.school_id AND cta.class_id=e.class_id AND cta.academic_year_id=e.academic_year_id
     JOIN teachers t ON t.id=cta.teacher_id AND t.school_id=cta.school_id
     WHERE e.school_id=$1 AND e.learner_id=$2 AND t.user_id=$3 LIMIT 1`,[sid,learner_id,req.user.user_id])).rows[0];
   if(!ok)return res.status(403).json({error:'You can only link guardians to learners in a class assigned to you as Class Teacher.'});
  }
  await db.query(`INSERT INTO learner_guardians(learner_id,parent_guardian_id,is_primary) VALUES($1,$2,$3) ON CONFLICT(learner_id,parent_guardian_id) DO UPDATE SET is_primary=EXCLUDED.is_primary`,[learner_id,parent_guardian_id,is_primary===true]);
  res.status(201).json({ok:true});
 }catch(e){res.status(400).json({error:e.message});}
});
router.get('/:schoolId/learner/:learnerId/parents',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{try{const q=await db.query(`SELECT pg.*,lg.is_primary FROM parent_guardians pg JOIN learner_guardians lg ON lg.parent_guardian_id=pg.id WHERE pg.school_id=$1 AND lg.learner_id=$2 ORDER BY lg.is_primary DESC,pg.last_name`,[req.params.schoolId,req.params.learnerId]);res.json(q.rows)}catch(e){res.status(500).json({error:'Unable to load learner parents'})}});
router.post('/:schoolId/send',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const b=req.body;let guardians=[];if(b.class_id){guardians=(await db.query(`SELECT DISTINCT pg.id,pg.phone FROM parent_guardians pg JOIN learner_guardians lg ON lg.parent_guardian_id=pg.id JOIN learner_enrollments le ON le.learner_id=lg.learner_id AND le.school_id=pg.school_id WHERE pg.school_id=$1 AND le.class_id=$2 AND pg.is_active AND pg.sms_enabled AND pg.communication_consent`,[req.params.schoolId,b.class_id])).rows;}else if(b.learner_id){guardians=(await db.query(`SELECT pg.id,pg.phone FROM parent_guardians pg JOIN learner_guardians lg ON lg.parent_guardian_id=pg.id WHERE pg.school_id=$1 AND lg.learner_id=$2 AND pg.is_active AND pg.sms_enabled AND pg.communication_consent`,[req.params.schoolId,b.learner_id])).rows;}else if(b.parent_guardian_ids?.length){guardians=(await db.query(`SELECT id,phone FROM parent_guardians WHERE school_id=$1 AND id=ANY($2::uuid[]) AND is_active AND sms_enabled AND communication_consent`,[req.params.schoolId,b.parent_guardian_ids])).rows;}else return res.status(400).json({error:'Select a class, learner or parent recipient'});const body=String(b.message||'').trim();if(!body)return res.status(400).json({error:'Message is required'});const out=[];for(const g of guardians){const duplicate=await db.query(`SELECT id FROM communication_messages WHERE school_id=$1 AND parent_guardian_id=$2 AND COALESCE(learner_id,'00000000-0000-0000-0000-000000000000')=COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000') AND message_type=$4 AND body=$5 AND created_at>now()-interval '10 minutes' LIMIT 1`,[req.params.schoolId,g.id,b.learner_id||null,b.message_type||'SCHOOL_MESSAGE',body]);if(duplicate.rows[0]){out.push({status:'SKIPPED_DUPLICATE',parent_guardian_id:g.id});continue;}let status='QUEUED',provider=process.env.SMS_PROVIDER||'UNCONFIGURED',failure=null;try{const d=await deliverSms({phone:g.phone,message:body,school_id:req.params.schoolId,learner_id:b.learner_id||null});status=d.status;provider=d.provider||provider;}catch(e){status='FAILED';failure=e.message;}const q=await db.query(`INSERT INTO communication_messages(school_id,learner_id,parent_guardian_id,channel,message_type,body,status,provider,error_message,created_by) VALUES($1,$2,$3,'SMS',$4,$5,$6,$7,$8,$9) RETURNING *`,[req.params.schoolId,b.learner_id||null,g.id,b.message_type||'SCHOOL_MESSAGE',body,status,provider,failure,req.user.user_id]);out.push(q.rows[0]);}res.status(201).json({queued:out.filter(x=>x.status==='QUEUED').length,sent:out.filter(x=>x.status==='SENT').length,failed:out.filter(x=>x.status==='FAILED').length,messages:out,notice:process.env.SMS_PROVIDER?'SMS processed through the configured provider.':'Queued locally; configure an SMS provider before production sending.'})}catch(e){res.status(400).json({error:e.message})}});
router.post('/:schoolId/results-ready',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const b=req.body;if(!b.learner_id||!b.academic_year_id||!b.term_id)return res.status(400).json({error:'Learner, academic year and term are required'});const report=await buildTermReport(req.params.schoolId,b.learner_id,b.academic_year_id,b.term_id);if(!report)return res.status(404).json({error:'Report not found'});const guardians=(await db.query(`SELECT pg.id,pg.phone FROM parent_guardians pg JOIN learner_guardians lg ON lg.parent_guardian_id=pg.id WHERE pg.school_id=$1 AND lg.learner_id=$2 AND pg.is_active AND pg.sms_enabled AND pg.communication_consent`,[req.params.schoolId,b.learner_id])).rows;const body=`${report.school_name}: ${report.learner_name}'s ${report.term_name||'term'} results are ready. Average: ${report.overall_average==null?'—':Number(report.overall_average).toFixed(2)}. Log in to ZELIMU CBC to view the full report.`;const out=[];for(const g of guardians){let status='QUEUED',provider=process.env.SMS_PROVIDER||'UNCONFIGURED',failure=null;try{const d=await deliverSms({phone:g.phone,message:body,school_id:req.params.schoolId,learner_id:b.learner_id});status=d.status;provider=d.provider||provider;}catch(e){status='FAILED';failure=e.message;}const q=await db.query(`INSERT INTO communication_messages(school_id,learner_id,parent_guardian_id,channel,message_type,body,status,provider,error_message,created_by) VALUES($1,$2,$3,'SMS','RESULTS_READY',$4,$5,$6,$7,$8) RETURNING *`,[req.params.schoolId,b.learner_id,g.id,body,status,provider,failure,req.user.user_id]);out.push(q.rows[0]);}res.status(201).json({queued:out.filter(x=>x.status==='QUEUED').length,sent:out.filter(x=>x.status==='SENT').length,failed:out.filter(x=>x.status==='FAILED').length,messages:out,notice:process.env.SMS_PROVIDER?'SMS processed through the configured provider.':'Queued locally; configure an SMS provider before production sending.'})}catch(e){res.status(400).json({error:e.message})}});
router.get('/:schoolId/history',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER'),async(req,res)=>{try{const q=await db.query(`SELECT cm.*,pg.first_name parent_first_name,pg.last_name parent_last_name,pg.phone FROM communication_messages cm LEFT JOIN parent_guardians pg ON pg.id=cm.parent_guardian_id WHERE cm.school_id=$1 ORDER BY cm.created_at DESC LIMIT 200`,[req.params.schoolId]);res.json(q.rows)}catch(e){res.status(500).json({error:'Unable to load communication history'})}});

// Grade/class results publication: builds the learner result SMS from the published assessment context.
router.get('/:schoolId/grade-roster',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const sid=req.params.schoolId,y=req.query.academic_year_id;const q=await db.query(`SELECT lv.id level_id,lv.name level_name,COUNT(DISTINCT l.id)::int learners,COUNT(DISTINCT pg.id)::int parents_with_phone FROM school_levels lv JOIN classes c ON c.school_level_id=lv.id AND c.school_id=lv.school_id LEFT JOIN learner_enrollments e ON e.class_id=c.id AND e.academic_year_id=$2 AND e.school_id=$1 AND COALESCE(e.status,'ACTIVE')='ACTIVE' LEFT JOIN learners l ON l.id=e.learner_id AND l.school_id=$1 LEFT JOIN learner_guardians lg ON lg.learner_id=l.id LEFT JOIN parent_guardians pg ON pg.id=lg.parent_guardian_id AND pg.is_active AND pg.sms_enabled AND pg.communication_consent WHERE lv.school_id=$1 AND lv.is_active GROUP BY lv.id,lv.name ORDER BY lv.sort_order,lv.name`,[sid,y]);res.json(q.rows)}catch(e){res.status(400).json({error:e.message})}});
router.get('/:schoolId/grade-learners',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const sid=req.params.schoolId,y=req.query.academic_year_id,level=req.query.level_id;if(!y||!level)return res.status(400).json({error:'Academic year and grade are required'});const q=await db.query(`SELECT l.id learner_id,l.admission_no,l.first_name,l.middle_name,l.last_name,c.name class_name,c.stream,lv.name level_name,COALESCE(json_agg(DISTINCT jsonb_build_object('id',pg.id,'name',concat_ws(' ',pg.first_name,pg.last_name),'phone',pg.phone)) FILTER (WHERE pg.id IS NOT NULL),'[]') parents FROM learner_enrollments e JOIN learners l ON l.id=e.learner_id JOIN classes c ON c.id=e.class_id JOIN school_levels lv ON lv.id=c.school_level_id LEFT JOIN learner_guardians lg ON lg.learner_id=l.id LEFT JOIN parent_guardians pg ON pg.id=lg.parent_guardian_id AND pg.is_active AND pg.sms_enabled AND pg.communication_consent WHERE e.school_id=$1 AND e.academic_year_id=$2 AND c.school_level_id=$3 AND COALESCE(e.status,'ACTIVE')='ACTIVE' GROUP BY l.id,c.id,lv.id ORDER BY c.name,c.stream,l.last_name,l.first_name`,[sid,y,level]);res.json(q.rows)}catch(e){res.status(400).json({error:e.message})}});
function publicationIds(value){
 if(Array.isArray(value))return value.map(String).filter(Boolean);
 if(typeof value==='string')return value.split(',').map(x=>x.trim()).filter(Boolean);
 return [];
}
async function ensurePublicationSchema(){
 const result=await db.query(`
  SELECT
   (SELECT COUNT(DISTINCT column_name)::int FROM information_schema.columns
    WHERE table_schema=ANY(current_schemas(false))
      AND table_name='communication_messages'
      AND column_name=ANY($1::text[])) context_columns,
   EXISTS(SELECT 1 FROM pg_indexes
    WHERE schemaname=ANY(current_schemas(false))
      AND tablename='communication_messages'
      AND indexname='uq_comm_published_results_once') duplicate_guard
 `,[['academic_year_id','term_id']]);
 if(Number(result.rows[0]?.context_columns)!==2||!result.rows[0]?.duplicate_guard)
  throw Object.assign(new Error('Apply database migration 021_parent_publish_and_duplicate_guard.sql before previewing or publishing results.'),{status:503});
}
async function ensureResultsCentreSchema(){
 await ensurePublicationSchema();
 const result=await db.query(`
  SELECT to_regclass('result_publications') IS NOT NULL publications,
         to_regclass('result_publication_records') IS NOT NULL records,
         EXISTS(SELECT 1 FROM information_schema.columns
          WHERE table_schema=ANY(current_schemas(false))
            AND table_name='result_publication_records' AND column_name='class_id') class_column
 `);
 if(!result.rows[0]?.publications||!result.rows[0]?.records)
  throw Object.assign(new Error('Apply database migration 022_results_publication_centre.sql before using the Results Publishing Centre.'),{status:503});
 if(!result.rows[0]?.class_column)
  throw Object.assign(new Error('Apply database migration 037_results_publication_class_history.sql before using class-based publication history.'),{status:503});
}
async function ensurePublicationLifecycleSchema(){
 const result=await db.query(`
  SELECT COUNT(*)::int column_count FROM information_schema.columns
  WHERE table_schema=ANY(current_schemas(false)) AND table_name='result_publications'
    AND column_name IN ('archived_at','archived_by')
 `);
 if(Number(result.rows[0]?.column_count)!==2)
  throw Object.assign(new Error('Apply database migration 038_result_publication_lifecycle.sql before archiving or withdrawing publications.'),{status:503});
}
async function validatePublicationScope(sid,yearId,termId,levelIds,classIds){
 if(!yearId||!termId)throw Object.assign(new Error('Academic year and term are required.'),{status:400});
 const period=await db.query(
  `SELECT 1 FROM academic_years ay JOIN terms t
     ON t.academic_year_id=ay.id AND t.school_id=ay.school_id
   WHERE ay.id=$1 AND ay.school_id=$2 AND t.id=$3`,
  [yearId,sid,termId]
 );
 if(!period.rowCount)throw Object.assign(new Error('The selected term does not belong to this school and academic year.'),{status:400});
 if(levelIds.length>100||classIds.length>500)throw Object.assign(new Error('Select fewer grades or classes at a time.'),{status:400});
 if(levelIds.length){
  const found=await db.query(
   `SELECT sl.id FROM school_levels sl JOIN school_sections ss ON ss.id=sl.school_section_id
    WHERE ss.school_id=$1 AND sl.id=ANY($2::uuid[])`,
   [sid,levelIds]
  );
  if(found.rowCount!==new Set(levelIds).size)throw Object.assign(new Error('One or more selected grades do not belong to this school.'),{status:400});
 }
 if(classIds.length){
  const found=await db.query(
   'SELECT id FROM classes WHERE school_id=$1 AND id=ANY($2::uuid[])',
   [sid,classIds]
  );
  if(found.rowCount!==new Set(classIds).size)throw Object.assign(new Error('One or more selected classes do not belong to this school.'),{status:400});
 }
}
async function publicationRoster(sid,yearId,termId,levelIds,classIds){
 const result=await db.query(`
  SELECT DISTINCT l.id learner_id,l.admission_no,l.first_name,l.middle_name,l.last_name,
    c.id class_id,c.name class_name,c.stream,lv.id level_id,lv.name level_name,
    pg.id parent_id,pg.first_name parent_first_name,pg.last_name parent_last_name,
    pg.phone,COALESCE(pg.is_active,false) parent_active,
    COALESCE(pg.sms_enabled,false) sms_enabled,
    COALESCE(pg.communication_consent,false) communication_consent,
    EXISTS(
      SELECT 1 FROM result_publication_records r
      WHERE r.school_id=$1 AND r.learner_id=l.id
        AND r.academic_year_id=$2 AND r.term_id=$3
    ) result_published,
    EXISTS(
      SELECT 1 FROM communication_messages cm
      WHERE cm.school_id=$1 AND cm.learner_id=l.id
        AND cm.parent_guardian_id=pg.id
        AND cm.academic_year_id=$2 AND cm.term_id=$3
        AND cm.message_type='PUBLISHED_RESULTS'
    ) already_published
  FROM learner_enrollments e
  JOIN learners l ON l.id=e.learner_id AND l.school_id=e.school_id
  JOIN classes c ON c.id=e.class_id AND c.school_id=e.school_id
  LEFT JOIN school_levels lv ON lv.id=c.school_level_id
  LEFT JOIN learner_guardians lg ON lg.learner_id=l.id
  LEFT JOIN parent_guardians pg ON pg.id=lg.parent_guardian_id AND pg.school_id=e.school_id
  WHERE e.school_id=$1 AND e.academic_year_id=$2
    AND COALESCE(e.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
    AND COALESCE(l.is_active,true)=true
    AND (
      (cardinality($4::uuid[])=0 AND cardinality($5::uuid[])=0)
      OR c.school_level_id=ANY($4::uuid[])
      OR c.id=ANY($5::uuid[])
    )
  ORDER BY c.name,c.stream,l.last_name,l.first_name,pg.last_name,pg.first_name
 `,[sid,yearId,termId,levelIds,classIds]);
 const learners=new Map();
 for(const row of result.rows){
  let learner=learners.get(row.learner_id);
  if(!learner){
   learner={
    learner_id:row.learner_id,admission_no:row.admission_no,
    first_name:row.first_name,middle_name:row.middle_name,last_name:row.last_name,
    class_id:row.class_id,class_name:row.class_name,class_stream:row.stream,
   level_id:row.level_id,level_name:row.level_name,
   previously_published:Boolean(row.result_published),parents:[]
   };
   learners.set(row.learner_id,learner);
  }
  if(row.parent_id){
   const eligible=row.parent_active&&row.sms_enabled&&row.communication_consent&&String(row.phone||'').trim();
   learner.parents.push({
    id:row.parent_id,
    name:[row.parent_first_name,row.parent_last_name].filter(Boolean).join(' '),
    phone:row.phone||'',
    eligible:Boolean(eligible),
    already_published:Boolean(row.already_published)
   });
  }
 }
 return [...learners.values()].map(learner=>({
  ...learner,
  eligible_recipients:learner.parents.filter(p=>p.eligible&&!p.already_published).length,
  previously_published:learner.previously_published
 }));
}
function hasPublishableResults(report){
 return Boolean(report&&Array.isArray(report.subjects)&&
  report.subjects.some(subject=>subject.average!==null&&subject.average!==undefined));
}
async function publicationReportPreview(sid,learners,yearId,termId){
 const result=new Array(learners.length);let next=0;
 const worker=async()=>{
  while(next<learners.length){
   const index=next++,learner=learners[index];
   try{
    const report=await buildTermReport(sid,learner.learner_id,yearId,termId);
    result[index]=hasPublishableResults(report)?{
     ready:true,average:report.overall_average,grade:report.overall_grade||null,
     subjects:(report.subjects||[]).length
    }:{ready:false,reason:'No saved subject marks are available for this learner and term.'};
   }catch(e){result[index]={ready:false,reason:`Unable to prepare result: ${e.message}`};}
  }
 };
 await Promise.all(Array.from({length:Math.min(12,learners.length)},worker));
 return result;
}
router.get('/:schoolId/publication-preview',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,yearId=String(req.query.academic_year_id||''),termId=String(req.query.term_id||'');
  const levelIds=publicationIds(req.query.level_ids),classIds=publicationIds(req.query.class_ids);
  await ensureResultsCentreSchema();
  await validatePublicationScope(sid,yearId,termId,levelIds,classIds);
  const learners=await publicationRoster(sid,yearId,termId,levelIds,classIds);
  const reports=await publicationReportPreview(sid,learners,yearId,termId);
  const previewLearners=learners.map((learner,index)=>({...learner,result:reports[index]}));
  const recipients=learners.reduce((sum,l,index)=>sum+(reports[index]?.ready&&!l.previously_published?l.eligible_recipients:0),0);
  const duplicateCount=learners.reduce((sum,l)=>sum+l.parents.filter(p=>p.already_published).length,0);
  res.json({
   learners:previewLearners,summary:{
    learners:learners.length,eligible_recipients:recipients,
    no_eligible_contact:learners.filter(l=>!l.parents.some(p=>p.eligible)).length,
    already_published:duplicateCount,
    results_ready:reports.filter((r,index)=>r?.ready&&!learners[index].previously_published).length,
    results_unavailable:reports.filter(r=>!r?.ready).length,
    results_already_published:reports.filter((r,index)=>r?.ready&&learners[index].previously_published).length
   }
  });
 }catch(e){res.status(e.status||400).json({error:e.message})}
});
router.post('/:schoolId/publish-school-results',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,b=req.body||{};
  const yearId=String(b.academic_year_id||''),termId=String(b.term_id||'');
  const levelIds=publicationIds(b.level_ids),classIds=publicationIds(b.class_ids);
  await ensurePublicationSchema();
  await validatePublicationScope(sid,yearId,termId,levelIds,classIds);
  const learners=await publicationRoster(sid,yearId,termId,levelIds,classIds);
  const details=[];
  let sent=0,queued=0,skipped=0,failed=0;
  for(const learner of learners){
   const eligible=learner.parents.filter(p=>p.eligible);
   if(!eligible.length){
    skipped++;
    details.push({learner: [learner.first_name,learner.middle_name,learner.last_name].filter(Boolean).join(' '),status:'SKIPPED',reason:'No eligible parent contact.'});
    continue;
   }
   let report;
   try{report=await buildTermReport(sid,learner.learner_id,yearId,termId);}
   catch(e){
    skipped++;
    details.push({learner:[learner.first_name,learner.middle_name,learner.last_name].filter(Boolean).join(' '),status:'SKIPPED',reason:`Report error: ${e.message}`});
    continue;
   }
   if(!report){
    skipped++;
    details.push({learner:[learner.first_name,learner.middle_name,learner.last_name].filter(Boolean).join(' '),status:'SKIPPED',reason:'No report data was generated.'});
    continue;
   }
   const learnerName=report.learner_name||[learner.first_name,learner.middle_name,learner.last_name].filter(Boolean).join(' ');
   const subjectSummary=(report.subjects||[]).map(x=>`${x.subject_code||x.subject_name}:${x.average==null?'—':Number(x.average).toFixed(1)}${x.grade?'/'+x.grade:''}`).join(', ');
   const message=String(b.message_template||`${report.school_name}: ${learnerName} ${report.term_name||'term'} results. Average ${report.overall_average==null?'—':Number(report.overall_average).toFixed(2)}, grade ${report.overall_grade||'—'}. Marks: ${subjectSummary||'See portal for full report.'}`)
    .replaceAll('{learner}',learnerName)
    .replaceAll('{average}',report.overall_average==null?'—':Number(report.overall_average).toFixed(2))
    .replaceAll('{grade}',report.overall_grade||'—')
    .replaceAll('{marks}',subjectSummary);
   for(const guardian of eligible){
    const already=await db.query(
     `SELECT id FROM communication_messages
      WHERE school_id=$1 AND learner_id=$2 AND parent_guardian_id=$3
        AND academic_year_id=$4 AND term_id=$5 AND message_type='PUBLISHED_RESULTS'
      LIMIT 1`,
     [sid,learner.learner_id,guardian.id,yearId,termId]
    );
    if(already.rowCount){
     skipped++;
     details.push({learner:learnerName,parent:guardian.name,phone:guardian.phone,status:'SKIPPED',reason:'Results were already published for this term.'});
     continue;
    }
    let messageRow;
    try{
     messageRow=await db.query(
      `INSERT INTO communication_messages(
        school_id,learner_id,parent_guardian_id,channel,message_type,body,
        status,provider,created_by,academic_year_id,term_id
       ) VALUES($1,$2,$3,'SMS','PUBLISHED_RESULTS',$4,'QUEUED',$5,$6,$7,$8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [sid,learner.learner_id,guardian.id,message,process.env.SMS_PROVIDER||'UNCONFIGURED',req.user.user_id,yearId,termId]
     );
    }catch(e){
     if(e.code==='42P01'||e.code==='42703')throw Object.assign(new Error('Apply database migration 021_parent_publish_and_duplicate_guard.sql before bulk publishing.'),{status:503});
     throw e;
    }
    if(!messageRow.rowCount){
     skipped++;
     details.push({learner:learnerName,parent:guardian.name,phone:guardian.phone,status:'SKIPPED',reason:'Results were already published for this term.'});
     continue;
    }
    let status='QUEUED',provider=process.env.SMS_PROVIDER||'UNCONFIGURED',failure=null;
    try{
     const delivery=await deliverSms({phone:guardian.phone,message,school_id:sid,learner_id:learner.learner_id});
     status=delivery.status;provider=delivery.provider||provider;
    }catch(e){status='FAILED';failure=e.message;}
    await db.query(
     `UPDATE communication_messages
      SET status=$2,provider=$3,failure_reason=$4,
          sent_at=CASE WHEN $2='SENT' THEN now() ELSE NULL END
      WHERE id=$1`,
     [messageRow.rows[0].id,status,provider,failure]
    );
    if(status==='SENT')sent++;
    else if(status==='QUEUED')queued++;
    else failed++;
    details.push({learner:learnerName,parent:guardian.name,phone:guardian.phone,status,reason:failure});
   }
  }
  res.status(201).json({
   learners:learners.length,sent,queued,skipped,failed,details,
   message:(String(process.env.SMS_PROVIDER||'').toUpperCase()==='TOPMEDIA'&&process.env.SMS_TOPMEDIA_API_KEY)
    ?'Results sent through TopMediaSMS.'
    :(String(process.env.SMS_PROVIDER||'').toUpperCase()==='AFRICASTALKING'&&process.env.SMS_AFRICA_TALKING_API_KEY)
    ?"Results sent through Africa's Talking SMS."
    :(process.env.SMS_WEBHOOK_URL?'Results sent through the configured SMS webhook.':'Results queued safely; configure an SMS provider for live delivery.')
  });
 }catch(e){res.status(e.status||400).json({error:e.message})}
});
router.get('/:schoolId/result-publications',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,yearId=String(req.query.academic_year_id||''),termId=String(req.query.term_id||'');
  await ensureResultsCentreSchema();
  const rows=await db.query(`
   SELECT p.id,p.academic_year_id,p.term_id,p.audience_scope,p.level_ids,p.class_ids,
     p.status,p.learner_count,p.created_at,
     CONCAT_WS(' ',u.first_name,u.last_name) created_by_name,
     COUNT(DISTINCT r.id)::int published_learners,
     COUNT(m.id)::int sms_total,
     COUNT(m.id) FILTER(WHERE m.status='SENT')::int sms_sent,
     COUNT(m.id) FILTER(WHERE m.status='QUEUED')::int sms_queued,
     COUNT(m.id) FILTER(WHERE m.status='SENDING')::int sms_sending,
     COUNT(m.id) FILTER(WHERE m.status='FAILED')::int sms_failed,
     COUNT(m.id) FILTER(WHERE m.status='SKIPPED')::int sms_skipped
   FROM result_publications p
   LEFT JOIN users u ON u.id=p.created_by
   LEFT JOIN result_publication_records r ON r.publication_id=p.id
   LEFT JOIN communication_messages m ON m.result_publication_record_id=r.id AND m.message_type='PUBLISHED_RESULTS'
   WHERE p.school_id=$1 AND ($2::uuid IS NULL OR p.academic_year_id=$2)
     AND ($3::uuid IS NULL OR p.term_id=$3)
   GROUP BY p.id,u.first_name,u.last_name
   ORDER BY p.created_at DESC LIMIT 100
  `,[sid,yearId||null,termId||null]);
  const summary=buildPublicationSummary(rows.rows);
  res.json({publications:rows.rows,summary,sms_delivery:smsDeliveryConfiguration()});
 }catch(e){res.status(e.status||400).json({error:e.message})}
});
router.get('/:schoolId/result-publication-classes',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,yearId=String(req.query.academic_year_id||''),termId=String(req.query.term_id||''),assessmentId=String(req.query.assessment_id||'');
  await ensureResultsCentreSchema();
  await ensurePublicationLifecycleSchema();
  await ensureAssessmentPublishSchema();
  await validatePublicationScope(sid,yearId,termId,[],[]);
  const includeArchived=String(req.query.include_archived||'')==='true';
  if(assessmentId){
   const assessment=(await db.query(
    'SELECT 1 FROM assessments WHERE id=$1 AND school_id=$2 AND academic_year_id=$3 AND term_id=$4',
    [assessmentId,sid,yearId,termId]
   )).rowCount;
   if(!assessment)return res.status(404).json({error:'The selected assessment was not found for this year and term.'});
  }
  const classes=await db.query(`
   WITH roster AS (
    SELECT e.class_id,COUNT(DISTINCT l.id)::int learners
    FROM learner_enrollments e
    JOIN learners l ON l.id=e.learner_id AND l.school_id=e.school_id
    WHERE e.school_id=$1 AND e.academic_year_id=$2
      AND COALESCE(e.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
      AND COALESCE(l.is_active,true)=true
    GROUP BY e.class_id
   ), publication_stats AS (
    SELECT r.class_id,COUNT(DISTINCT r.learner_id)::int published_learners,
      COUNT(DISTINCT p.id)::int publication_count,
      COUNT(DISTINCT m.id) FILTER(WHERE m.status='SENT')::int sms_sent,
      COUNT(DISTINCT m.id) FILTER(WHERE m.status='FAILED')::int sms_failed,
      COUNT(DISTINCT m.id) FILTER(WHERE m.status='QUEUED')::int sms_queued,
      COUNT(DISTINCT m.id) FILTER(WHERE m.status='SENDING')::int sms_sending,
      COUNT(DISTINCT m.id) FILTER(WHERE m.status='SKIPPED')::int sms_skipped
    FROM result_publications p
    JOIN result_publication_records r ON r.publication_id=p.id AND r.school_id=p.school_id
    LEFT JOIN communication_messages m ON m.result_publication_record_id=r.id
      AND m.result_publication_id=p.id AND m.message_type='PUBLISHED_RESULTS'
    WHERE p.school_id=$1 AND p.academic_year_id=$2 AND p.term_id=$3
      AND ($4::uuid IS NULL OR p.assessment_id=$4)
      AND ($5::boolean OR p.archived_at IS NULL)
    GROUP BY r.class_id
   )
   SELECT c.id class_id,c.name class_name,c.stream,lv.name level_name,
     COALESCE(roster.learners,0)::int learners,
     COALESCE(stats.published_learners,0)::int published_learners,
     COALESCE(stats.publication_count,0)::int publication_count,
     COALESCE(stats.sms_sent,0)::int sms_sent,
     COALESCE(stats.sms_failed,0)::int sms_failed,
     COALESCE(stats.sms_queued,0)::int sms_queued,
     COALESCE(stats.sms_sending,0)::int sms_sending,
     COALESCE(stats.sms_skipped,0)::int sms_skipped
   FROM classes c
   LEFT JOIN school_levels lv ON lv.id=c.school_level_id
   LEFT JOIN roster ON roster.class_id=c.id
   LEFT JOIN publication_stats stats ON stats.class_id=c.id
   WHERE c.school_id=$1 AND COALESCE(c.is_active,true)=true
   ORDER BY lv.sort_order,c.name,c.stream
  `,[sid,yearId,termId,assessmentId||null,includeArchived]);
  const publications=await db.query(`
   SELECT c.id class_id,p.id,p.assessment_id,a.name assessment_name,p.status,p.archived_at,
     p.created_at,CONCAT_WS(' ',u.first_name,u.last_name) created_by_name,
     COUNT(DISTINCT r.id)::int learner_count,
     COUNT(DISTINCT m.id) FILTER(WHERE m.status='SENT')::int sms_sent,
     COUNT(DISTINCT m.id) FILTER(WHERE m.status='FAILED')::int sms_failed,
     COUNT(DISTINCT m.id) FILTER(WHERE m.status='QUEUED')::int sms_queued,
     COUNT(DISTINCT m.id) FILTER(WHERE m.status='SENDING')::int sms_sending,
     COUNT(DISTINCT m.id) FILTER(WHERE m.status='SKIPPED')::int sms_skipped
   FROM result_publications p
   JOIN result_publication_records r ON r.publication_id=p.id AND r.school_id=p.school_id
   JOIN classes c ON c.id=r.class_id AND c.school_id=r.school_id
   LEFT JOIN assessments a ON a.id=p.assessment_id
   LEFT JOIN users u ON u.id=p.created_by
   LEFT JOIN communication_messages m ON m.result_publication_record_id=r.id
     AND m.result_publication_id=p.id AND m.message_type='PUBLISHED_RESULTS'
   WHERE p.school_id=$1 AND p.academic_year_id=$2 AND p.term_id=$3
     AND ($4::uuid IS NULL OR p.assessment_id=$4)
     AND ($5::boolean OR p.archived_at IS NULL)
   GROUP BY c.id,p.id,a.name,u.first_name,u.last_name
   ORDER BY c.name,c.stream,p.created_at DESC
  `,[sid,yearId,termId,assessmentId||null,includeArchived]);
  const byClass=new Map(classes.rows.map(row=>[String(row.class_id),{...row,publications:[]}]));
  for(const publication of publications.rows)
   byClass.get(String(publication.class_id))?.publications.push(publication);
  const list=[...byClass.values()];
  res.json({
   classes:list,
   sms_delivery:smsDeliveryConfiguration(),
   summary:{
    classes:list.length,
    classes_published:list.filter(c=>Number(c.publication_count)>0).length,
    learners_published:list.reduce((sum,c)=>sum+Number(c.published_learners||0),0),
    sms_sent:list.reduce((sum,c)=>sum+Number(c.sms_sent||0),0),
    sms_failed:list.reduce((sum,c)=>sum+Number(c.sms_failed||0),0),
    sms_queued:list.reduce((sum,c)=>sum+Number(c.sms_queued||0)+Number(c.sms_sending||0),0)
   }
  });
 }catch(e){res.status(e.status||400).json({error:e.message})}
});
router.post('/:schoolId/result-publications',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 let client;
 try{
  const sid=req.params.schoolId,b=req.body||{};
  const yearId=String(b.academic_year_id||''),termId=String(b.term_id||'');
  const levelIds=publicationIds(b.level_ids),classIds=publicationIds(b.class_ids);
  await ensureResultsCentreSchema();
  await validatePublicationScope(sid,yearId,termId,levelIds,classIds);
  const learners=await publicationRoster(sid,yearId,termId,levelIds,classIds),prepared=[],skipped=[];
  for(const learner of learners){
   const exists=await db.query(`
    SELECT 1 FROM result_publication_records
    WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4 LIMIT 1
   `,[sid,learner.learner_id,yearId,termId]);
   if(exists.rowCount){skipped.push({learner_id:learner.learner_id,reason:'Results have already been published for this learner and term.'});continue;}
   let report;
   try{report=await buildTermReport(sid,learner.learner_id,yearId,termId);}
   catch(e){skipped.push({learner_id:learner.learner_id,reason:`Result preparation failed: ${e.message}`});continue;}
   if(!hasPublishableResults(report)){skipped.push({learner_id:learner.learner_id,reason:'No saved subject marks are available to publish.'});continue;}
   prepared.push({learner,report});
  }
  if(!prepared.length)return res.status(409).json({error:'No new learner results are ready to publish for this audience.',skipped:skipped.length});
  client=await db.pool.connect();
  await client.query('BEGIN');
  const publication=(await client.query(`
   INSERT INTO result_publications(
    school_id,academic_year_id,term_id,audience_scope,level_ids,class_ids,learner_count,created_by
   ) VALUES($1,$2,$3,$4,$5::uuid[],$6::uuid[],$7,$8)
   RETURNING id,school_id,academic_year_id,term_id,audience_scope,level_ids,class_ids,status,learner_count,created_at
  `,[sid,yearId,termId,levelIds.length||classIds.length?'SELECTED':'WHOLE_SCHOOL',levelIds,classIds,prepared.length,req.user.user_id])).rows[0];
  let published=0;
  for(const item of prepared){
   const inserted=await client.query(`
    INSERT INTO result_publication_records(
    publication_id,school_id,academic_year_id,term_id,class_id,learner_id,result_snapshot
    ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING id
   `,[publication.id,sid,yearId,termId,item.learner.class_id,item.learner.learner_id,JSON.stringify(item.report)]);
   published+=inserted.rowCount;
   if(!inserted.rowCount)skipped.push({learner_id:item.learner.learner_id,reason:'Results were published by another request before this publication completed.'});
  }
  if(!published){await client.query('ROLLBACK');return res.status(409).json({error:'Results have already been published for all learners in this audience.',skipped:skipped.length});}
  await client.query('UPDATE result_publications SET learner_count=$2 WHERE id=$1',[publication.id,published]);
  await client.query('COMMIT');
  res.status(201).json({
   publication:{...publication,learner_count:published},published,skipped:skipped.length,
   sms_sent:0,sms_queued:0,sms_failed:0,
   message:'Results are published and saved. Parent SMS has not been sent; use Send notifications when ready.'
  });
 }catch(e){
  if(client)try{await client.query('ROLLBACK')}catch(rollbackError){
   console.error('Failed to roll back results publication transaction:',rollbackError);
  }
  if(e.code==='42P01'||e.code==='42703')return res.status(503).json({error:'Apply database migrations 021_parent_publish_and_duplicate_guard.sql and 022_results_publication_centre.sql before publishing results.'});
  res.status(e.status||400).json({error:e.message});
 }finally{client?.release();}
});
router.get('/:schoolId/result-publications/:publicationId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,publicationId=req.params.publicationId;
  await ensureResultsCentreSchema();
  await ensurePublicationLifecycleSchema();
  const publication=(await db.query(`
   SELECT p.*,a.name assessment_name,CONCAT_WS(' ',u.first_name,u.last_name) created_by_name
   FROM result_publications p LEFT JOIN users u ON u.id=p.created_by
   LEFT JOIN assessments a ON a.id=p.assessment_id
   WHERE p.id=$1 AND p.school_id=$2
  `,[publicationId,sid])).rows[0];
  if(!publication)return res.status(404).json({error:'Publication not found.'});
  const records=await db.query(`
   SELECT r.id,r.learner_id,r.result_snapshot,r.created_at,r.class_id,
     CONCAT_WS(' ',l.first_name,l.middle_name,l.last_name) learner_name,l.admission_no,
     c.name class_name,c.stream
   FROM result_publication_records r
   JOIN learners l ON l.id=r.learner_id
   LEFT JOIN classes c ON c.id=r.class_id AND c.school_id=r.school_id
   WHERE r.publication_id=$1 AND r.school_id=$2
   ORDER BY c.name,c.stream,l.last_name,l.first_name
  `,[publicationId,sid]);
  const messages=await db.query(`
   SELECT m.id,m.result_publication_record_id,m.parent_guardian_id,
     CONCAT_WS(' ',pg.first_name,pg.last_name) parent_name,pg.phone,
     m.status,m.provider,m.failure_reason,m.created_at,m.sent_at
   FROM communication_messages m
   LEFT JOIN parent_guardians pg ON pg.id=m.parent_guardian_id
   WHERE m.result_publication_id=$1 AND m.school_id=$2 AND m.message_type='PUBLISHED_RESULTS'
   ORDER BY m.created_at,m.id
  `,[publicationId,sid]);
  const byRecord=new Map();
  for(const message of messages.rows){
   const list=byRecord.get(message.result_publication_record_id)||[];
   list.push(message);byRecord.set(message.result_publication_record_id,list);
  }
  res.json({publication,records:records.rows.map(record=>({
   ...record,notifications:byRecord.get(record.id)||[]
  })),notifications:messages.rows});
 }catch(e){res.status(e.status||400).json({error:e.message})}
});
router.patch('/:schoolId/result-publications/:publicationId/archive',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  const archived=req.body?.archived;
  if(typeof archived!=='boolean')return res.status(400).json({error:'Set archived to true or false.'});
  await ensureResultsCentreSchema();
  await ensurePublicationLifecycleSchema();
  const publication=(await db.query(`
   UPDATE result_publications
   SET archived_at=CASE WHEN $3 THEN COALESCE(archived_at,now()) ELSE NULL END,
       archived_by=CASE WHEN $3 THEN $4 ELSE NULL END
   WHERE id=$1 AND school_id=$2
   RETURNING id,archived_at,archived_by
  `,[req.params.publicationId,req.params.schoolId,archived,req.user.user_id])).rows[0];
  if(!publication)return res.status(404).json({error:'Publication not found.'});
  res.json({publication,message:archived?'Publication archived; all learner and SMS history is retained.':'Publication restored to the class history.'});
 }catch(e){res.status(e.status||400).json({error:e.message})}
});
router.post('/:schoolId/result-publications/:publicationId/withdraw',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  await ensureResultsCentreSchema();
  await ensurePublicationLifecycleSchema();
  const publication=(await db.query(`
   UPDATE result_publications SET status='WITHDRAWN'
   WHERE id=$1 AND school_id=$2 AND status='PUBLISHED'
   RETURNING id,status
  `,[req.params.publicationId,req.params.schoolId])).rows[0];
  if(!publication){
   const exists=(await db.query('SELECT status FROM result_publications WHERE id=$1 AND school_id=$2',[req.params.publicationId,req.params.schoolId])).rows[0];
   if(!exists)return res.status(404).json({error:'Publication not found.'});
   return res.status(409).json({error:exists.status==='WITHDRAWN'?'Publication is already withdrawn.':'Publication cannot be withdrawn in its current state.'});
  }
  res.json({publication,message:'Publication withdrawn. Existing learner records and sent-message history are retained; delivered SMS cannot be recalled.'});
 }catch(e){res.status(e.status||400).json({error:e.message})}
});
router.post('/:schoolId/result-publications/:publicationId/notifications',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,publicationId=req.params.publicationId;
  await ensureResultsCentreSchema();
  const publication=(await db.query(
   'SELECT * FROM result_publications WHERE id=$1 AND school_id=$2',[publicationId,sid]
  )).rows[0];
  if(!publication)return res.status(404).json({error:'Publication not found.'});
  if(publication.status!=='PUBLISHED')return res.status(409).json({error:'This publication was withdrawn; parent notifications cannot be sent or retried.'});
  const deliveryConfiguration=smsDeliveryConfiguration();
  if(!deliveryConfiguration.configured)
   return res.status(503).json({error:deliveryConfiguration.provider==='INFOBIP'
    ?'Infobip is not fully configured. Set its HTTPS base URL and API key; in trial mode, add your verified recipient numbers to SMS_INFOBIP_TRIAL_RECIPIENTS.'
    :'SMS delivery is not configured. Add provider credentials to the server before sending notifications.'});
  const retryFailedOnly=req.body?.retry_failed_only===true;
  const notificationId=String(req.body?.notification_id||'');
  if(notificationId&&!retryFailedOnly)
   return res.status(400).json({error:'Set retry_failed_only to true to retry one notification.'});
  if(notificationId){
   const target=(await db.query(`
    SELECT status FROM communication_messages
    WHERE id=$1 AND result_publication_id=$2 AND school_id=$3 AND message_type='PUBLISHED_RESULTS'
   `,[notificationId,publicationId,sid])).rows[0];
   if(!target)return res.status(404).json({error:'Notification not found for this publication.'});
   if(target.status!=='FAILED')return res.status(409).json({error:'Only failed notifications can be retried.'});
  }
  const records=(await db.query(`
   SELECT id,learner_id,result_snapshot FROM result_publication_records
   WHERE publication_id=$1 AND school_id=$2 ORDER BY created_at,id
  `,[publicationId,sid])).rows;
  let sent=0,queued=0,failed=0,skipped=0;
  const details=[];
  for(const record of records){
   const guardians=(await db.query(`
    SELECT pg.id,pg.first_name,pg.last_name,pg.phone
    FROM parent_guardians pg JOIN learner_guardians lg ON lg.parent_guardian_id=pg.id
    WHERE pg.school_id=$1 AND lg.learner_id=$2
      AND COALESCE(pg.is_active,false)=true AND COALESCE(pg.sms_enabled,false)=true
      AND COALESCE(pg.communication_consent,false)=true AND COALESCE(trim(pg.phone),'')<>''
   `,[sid,record.learner_id])).rows;
   if(!guardians.length){skipped++;continue;}
   const report=record.result_snapshot||{},learnerName=report.learner_name||'Learner';
   const assessmentName=report.assessment_name?String(report.assessment_name):'';
   const marksSummary=assessmentName&&Array.isArray(report.subjects)?report.subjects.map(x=>`${x.subject_name}:${x.percent==null?'—':Number(x.percent).toFixed(1)+'%'}`).join(', '):'';
   const defaultMessage=assessmentName
    ?`${report.school_name||'School'}: ${learnerName} ${assessmentName} results. ${marksSummary?('Marks: '+marksSummary+'. '):''}Average ${report.overall_average==null?'—':Number(report.overall_average).toFixed(2)}%.`
    :`${report.school_name||'School'}: ${learnerName} ${report.term_name||'term'} results. Average ${report.overall_average==null?'—':Number(report.overall_average).toFixed(2)}, grade ${report.overall_grade||'—'}. Log in to view the full report.`;
   const message=String(req.body?.message_template||defaultMessage)
    .replaceAll('{learner}',learnerName)
    .replaceAll('{average}',report.overall_average==null?'—':Number(report.overall_average).toFixed(2))
    .replaceAll('{grade}',report.overall_grade||'—');
   for(const guardian of guardians){
    const trial=infobipTrialConfiguration();
    if(deliveryConfiguration.provider==='INFOBIP'&&trial.trialMode&&
       !trial.recipients.includes(normalizedPhone(guardian.phone))){
     const existing=(await db.query(`
      SELECT id,status FROM communication_messages
      WHERE result_publication_record_id=$1 AND parent_guardian_id=$2
        AND message_type='PUBLISHED_RESULTS' LIMIT 1
     `,[record.id,guardian.id])).rows[0];
     if(existing?.status==='SENT'||existing?.status==='SENDING'||existing?.status==='QUEUED'){skipped++;continue;}
     if(existing)await db.query(`
      UPDATE communication_messages SET status='SKIPPED',failure_reason=$2
      WHERE id=$1
     `,[existing.id,'Not sent: recipient is not in the configured Infobip trial verified-number list.']);
     else await db.query(`
      INSERT INTO communication_messages(
       school_id,learner_id,parent_guardian_id,channel,message_type,body,status,provider,
       failure_reason,created_by,academic_year_id,term_id,result_publication_id,result_publication_record_id
      ) VALUES($1,$2,$3,'SMS','PUBLISHED_RESULTS',$4,'SKIPPED','INFOBIP',$5,$6,$7,$8,$9,$10)
      ON CONFLICT DO NOTHING
     `,[sid,record.learner_id,guardian.id,message,
       'Not sent: recipient is not in the configured Infobip trial verified-number list.',
       req.user.user_id,publication.academic_year_id,publication.term_id,publication.id,record.id]);
     skipped++;continue;
    }
    let existing=(await db.query(`
     SELECT id,status FROM communication_messages
     WHERE result_publication_record_id=$1 AND parent_guardian_id=$2
       AND message_type='PUBLISHED_RESULTS' LIMIT 1
    `,[record.id,guardian.id])).rows[0];
    if(notificationId&&existing?.id!==notificationId){skipped++;continue;}
    if(['SENT','SENDING','QUEUED'].includes(existing?.status)||(retryFailedOnly&&existing?.status!=='FAILED')){skipped++;continue;}
    let messageId=existing?.id;
    if(!existing){
     const pubAssessmentId=publication.assessment_id||null;
     const inserted=await db.query(`
      INSERT INTO communication_messages(
       school_id,learner_id,parent_guardian_id,channel,message_type,body,status,provider,
       created_by,academic_year_id,term_id,result_publication_id,result_publication_record_id${pubAssessmentId?',assessment_id':''}
      ) VALUES($1,$2,$3,'SMS','PUBLISHED_RESULTS',$4,'SENDING',$5,$6,$7,$8,$9,$10${pubAssessmentId?',$11':''})
      ON CONFLICT DO NOTHING RETURNING id
     `,[sid,record.learner_id,guardian.id,message,process.env.SMS_PROVIDER||'UNCONFIGURED',
       req.user.user_id,publication.academic_year_id,publication.term_id,publication.id,record.id,...(pubAssessmentId?[pubAssessmentId]:[])]);
     messageId=inserted.rows[0]?.id;
     if(!messageId){skipped++;continue;}
    }else{
     const claimed=await db.query(`
      UPDATE communication_messages SET status='SENDING',body=$2,failure_reason=NULL,
       provider=COALESCE(NULLIF($3,''),provider)
       WHERE id=$1 AND status IN ('FAILED','QUEUED','SKIPPED') RETURNING id
     `,[existing.id,message,process.env.SMS_PROVIDER||'UNCONFIGURED']);
     if(!claimed.rowCount){skipped++;continue;}
    }
    let status='QUEUED',provider=process.env.SMS_PROVIDER||'UNCONFIGURED',failure=null,providerMessageId=null;
    try{
     const delivery=await deliverSms({phone:guardian.phone,message,school_id:sid,learner_id:record.learner_id});
     status=delivery.status;provider=delivery.provider||provider;providerMessageId=delivery.providerMessageId||null;
    }catch(e){status='FAILED';failure=e.message;}
    await db.query(`
     UPDATE communication_messages SET status=$2,provider=$3,failure_reason=$4,
       provider_message_id=COALESCE($5,provider_message_id),
       sent_at=CASE WHEN $2 IN ('SENT','QUEUED') THEN now() ELSE NULL END WHERE id=$1
    `,[messageId,status,provider,failure,providerMessageId]);
    if(status==='SENT')sent++;else if(status==='QUEUED')queued++;else failed++;
    details.push({
     learner_id:record.learner_id,learner:learnerName,
     parent:`${guardian.first_name||''} ${guardian.last_name||''}`.trim(),
     phone:guardian.phone,status,failure_reason:failure
    });
   }
  }
  res.json({
   publication_id:publicationId,sent,queued,failed,skipped,details,
   message:retryFailedOnly?'Failed notifications retry completed.':'Notification delivery attempted; published results remain saved regardless of SMS status.'
  });
 }catch(e){
  if(e.code==='42P01'||e.code==='42703')return res.status(503).json({error:'Apply database migrations 021_parent_publish_and_duplicate_guard.sql and 022_results_publication_centre.sql before sending notifications.'});
  res.status(e.status||400).json({error:e.message});
 }
});
router.post('/:schoolId/publish-grade-results',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const sid=req.params.schoolId,b=req.body||{};if(!b.academic_year_id||!b.term_id||!b.level_id)return res.status(400).json({error:'Academic year, term and grade are required'});const learners=(await db.query(`SELECT DISTINCT l.id,l.first_name,l.middle_name,l.last_name FROM learner_enrollments e JOIN learners l ON l.id=e.learner_id JOIN classes c ON c.id=e.class_id WHERE e.school_id=$1 AND e.academic_year_id=$2 AND c.school_level_id=$3 AND COALESCE(e.status,'ACTIVE')='ACTIVE'`,[sid,b.academic_year_id,b.level_id])).rows;let queued=0,skipped=0,failed=0;for(const l of learners){const report=await buildTermReport(sid,l.id,b.academic_year_id,b.term_id);if(!report){skipped++;continue}const guardians=(await db.query(`SELECT pg.id,pg.phone FROM parent_guardians pg JOIN learner_guardians lg ON lg.parent_guardian_id=pg.id WHERE pg.school_id=$1 AND lg.learner_id=$2 AND pg.is_active AND pg.sms_enabled AND pg.communication_consent AND COALESCE(trim(pg.phone),'')<>''`,[sid,l.id])).rows;if(!guardians.length){skipped++;continue}const subjectSummary=(report.subjects||[]).map(x=>`${x.subject_code||x.subject_name}:${x.average==null?'—':Number(x.average).toFixed(1)}${x.grade?'/'+x.grade:''}`).join(', ');const body=String(b.message_template||`${report.school_name}: ${report.learner_name} ${report.term_name||'term'} results. Average ${report.overall_average==null?'—':Number(report.overall_average).toFixed(2)}, grade ${report.overall_grade||'—'}. Marks: ${subjectSummary||'See portal for full report.'}`).replaceAll('{learner}',report.learner_name).replaceAll('{average}',report.overall_average==null?'—':Number(report.overall_average).toFixed(2)).replaceAll('{grade}',report.overall_grade||'—').replaceAll('{marks}',subjectSummary);for(const g of guardians){let status='QUEUED',provider=process.env.SMS_PROVIDER||'UNCONFIGURED',reason=null;try{const d=await deliverSms({phone:g.phone,message:body,school_id:sid,learner_id:l.id});status=d.status;provider=d.provider;}catch(e){reason=e.message;status='FAILED';failed++;}await db.query(`INSERT INTO communication_messages(school_id,learner_id,parent_guardian_id,channel,message_type,body,status,provider,failure_reason,created_by,sent_at) VALUES($1,$2,$3,'SMS','PUBLISHED_RESULTS',$4,$5,$6,$7,$8,CASE WHEN $5='SENT' THEN now() ELSE NULL END)`,[sid,l.id,g.id,body,status,provider,reason,req.user.user_id]);if(status==='SENT'||status==='QUEUED')queued++;}}res.status(201).json({learners:learners.length,queued,skipped,failed,message:(String(process.env.SMS_PROVIDER||'').toUpperCase()==='TOPMEDIA'&&process.env.SMS_TOPMEDIA_API_KEY)?'Results sent through TopMediaSMS.':(String(process.env.SMS_PROVIDER||'').toUpperCase()==='AFRICASTALKING'&&process.env.SMS_AFRICA_TALKING_API_KEY)?"Results sent through Africa's Talking SMS.":(process.env.SMS_WEBHOOK_URL?'Results sent through the configured SMS webhook.':'Results queued safely; configure an SMS provider for live delivery.')});}catch(e){res.status(400).json({error:e.message})}});
router.get('/:schoolId/publication-class-overview',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 try{
  const sid=req.params.schoolId,yearId=String(req.query.academic_year_id||''),termId=String(req.query.term_id||''),assessmentId=String(req.query.assessment_id||'');
  await ensureResultsCentreSchema();
  await validatePublicationScope(sid,yearId,termId,[],[]);
  if(assessmentId){
   await ensureAssessmentPublishSchema();
   const assessment=(await db.query('SELECT id FROM assessments WHERE id=$1 AND school_id=$2 AND academic_year_id=$3 AND term_id=$4',[assessmentId,sid,yearId,termId])).rows[0];
   if(!assessment)return res.status(404).json({error:'The selected assessment was not found for this year and term.'});
   const q=await db.query(`
    SELECT c.id class_id,c.name class_name,c.stream,lv.name level_name,
     COUNT(DISTINCT l.id)::int learners,
     COUNT(DISTINCT m.learner_id)::int learners_with_results,
     1::int assessments_used,
     COUNT(DISTINCT pgr.learner_id)::int results_published,
     COUNT(DISTINCT pg.id)::int eligible_parents
    FROM classes c
    LEFT JOIN school_levels lv ON lv.id=c.school_level_id
    LEFT JOIN learner_enrollments e ON e.class_id=c.id AND e.school_id=c.school_id AND e.academic_year_id=$2 AND COALESCE(e.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
    LEFT JOIN learners l ON l.id=e.learner_id AND l.school_id=c.school_id AND COALESCE(l.is_active,true)=true
    LEFT JOIN marks m ON m.learner_id=e.learner_id AND m.school_id=c.school_id AND m.academic_year_id=e.academic_year_id AND m.term_id=$3 AND m.assessment_id=$4 AND m.mark IS NOT NULL
    LEFT JOIN result_publication_records pgr ON pgr.learner_id=e.learner_id AND pgr.school_id=c.school_id AND pgr.academic_year_id=e.academic_year_id AND pgr.term_id=$3 AND pgr.assessment_id=$4
    LEFT JOIN learner_guardians lg ON lg.learner_id=e.learner_id
    LEFT JOIN parent_guardians pg ON pg.id=lg.parent_guardian_id AND pg.school_id=c.school_id AND COALESCE(pg.is_active,false)=true AND COALESCE(pg.sms_enabled,false)=true AND COALESCE(pg.communication_consent,false)=true AND COALESCE(trim(pg.phone),'')<>''
    WHERE c.school_id=$1 AND COALESCE(c.is_active,true)=true
    GROUP BY c.id,lv.id,lv.name,lv.sort_order
    ORDER BY lv.sort_order,c.name,c.stream`,[sid,yearId,termId,assessmentId]);
   return res.json({academic_year_id:yearId,term_id:termId,assessment_id:assessmentId,classes:q.rows});
  }
  const q=await db.query(`
   SELECT c.id class_id,c.name class_name,c.stream,lv.name level_name,
    COUNT(DISTINCT l.id)::int learners,
    COUNT(DISTINCT m.learner_id)::int learners_with_results,
    COUNT(DISTINCT a.id)::int assessments_used,
    COUNT(DISTINCT pgr.learner_id)::int results_published,
    COUNT(DISTINCT pg.id)::int eligible_parents
   FROM classes c
   LEFT JOIN school_levels lv ON lv.id=c.school_level_id
   LEFT JOIN learner_enrollments e ON e.class_id=c.id AND e.school_id=c.school_id AND e.academic_year_id=$2 AND COALESCE(e.status,'ACTIVE') IN ('ACTIVE','COMPLETED')
   LEFT JOIN learners l ON l.id=e.learner_id AND l.school_id=c.school_id AND COALESCE(l.is_active,true)=true
   LEFT JOIN marks m ON m.learner_id=e.learner_id AND m.school_id=c.school_id AND m.academic_year_id=e.academic_year_id AND m.term_id=$3 AND m.mark IS NOT NULL
   LEFT JOIN assessments a ON a.id=m.assessment_id AND a.school_id=c.school_id
   LEFT JOIN result_publication_records pgr ON pgr.learner_id=e.learner_id AND pgr.school_id=c.school_id AND pgr.academic_year_id=e.academic_year_id AND pgr.term_id=$3
   LEFT JOIN learner_guardians lg ON lg.learner_id=e.learner_id
   LEFT JOIN parent_guardians pg ON pg.id=lg.parent_guardian_id AND pg.school_id=c.school_id AND COALESCE(pg.is_active,false)=true AND COALESCE(pg.sms_enabled,false)=true AND COALESCE(pg.communication_consent,false)=true AND COALESCE(trim(pg.phone),'')<>''
   WHERE c.school_id=$1 AND COALESCE(c.is_active,true)=true
   GROUP BY c.id,lv.id,lv.name,lv.sort_order
   ORDER BY lv.sort_order,c.name,c.stream`,[sid,yearId,termId]);
  res.json({academic_year_id:yearId,term_id:termId,classes:q.rows});
 }catch(e){res.status(e.status||400).json({error:e.message})}
});
router.post('/:schoolId/publication-assessment',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 let client;
 try{
  const sid=req.params.schoolId,b=req.body||{};
  const yearId=String(b.academic_year_id||''),termId=String(b.term_id||''),assessmentId=String(b.assessment_id||''),classIds=publicationIds(b.class_ids);
  await ensureResultsCentreSchema();
  await ensureAssessmentPublishSchema();
  await validatePublicationScope(sid,yearId,termId,[],classIds);
  if(!assessmentId)return res.status(400).json({error:'Select an assessment to publish.'});
  if(!classIds.length)return res.status(400).json({error:'Select at least one class.'});
  const assessment=(await db.query('SELECT id FROM assessments WHERE id=$1 AND school_id=$2 AND academic_year_id=$3 AND term_id=$4',[assessmentId,sid,yearId,termId])).rows[0];
  if(!assessment)return res.status(404).json({error:'The selected assessment was not found for this year and term.'});
  const learners=(await db.query(`
   SELECT DISTINCT l.id,l.first_name,l.middle_name,l.last_name,m.class_id
   FROM marks m JOIN learners l ON l.id=m.learner_id AND l.school_id=m.school_id
   JOIN classes c ON c.id=m.class_id AND c.school_id=m.school_id
   WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.assessment_id=$4 AND m.mark IS NOT NULL
    AND c.id=ANY($5::uuid[]) AND COALESCE(l.is_active,true)=true
   ORDER BY l.last_name,l.first_name`,[sid,yearId,termId,assessmentId,classIds])).rows;
  const prepared=[],skipped=[];
  for(const learner of learners){
   const exists=await db.query('SELECT 1 FROM result_publication_records WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4 AND assessment_id=$5 LIMIT 1',[sid,learner.id,yearId,termId,assessmentId]);
   if(exists.rowCount){skipped.push({learner_id:learner.id,reason:'This assessment was already published for this learner.'});continue;}
   const snapshot=await assessmentResultSnapshot(sid,learner.id,yearId,termId,assessmentId);
   if(!snapshot){skipped.push({learner_id:learner.id,reason:'No saved marks for this assessment.'});continue;}
   prepared.push({learner,snapshot});
  }
  if(!prepared.length)return res.status(409).json({error:'Every learner in the selected classes already has this assessment published.',skipped:skipped.length});
  client=await db.pool.connect();
  await client.query('BEGIN');
  const publication=(await client.query(`
   INSERT INTO result_publications(school_id,academic_year_id,term_id,assessment_id,audience_scope,level_ids,class_ids,learner_count,created_by)
   VALUES($1,$2,$3,$4,'SELECTED','{}',$5::uuid[],$6,$7)
   RETURNING id,school_id,academic_year_id,term_id,assessment_id,audience_scope,level_ids,class_ids,status,learner_count,created_at`,[sid,yearId,termId,assessmentId,classIds,prepared.length,req.user.user_id])).rows[0];
  let published=0;
  for(const item of prepared){
   const inserted=await client.query(`
    INSERT INTO result_publication_records(publication_id,school_id,academic_year_id,term_id,assessment_id,class_id,learner_id,result_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`,[publication.id,sid,yearId,termId,assessmentId,item.learner.class_id,item.learner.id,JSON.stringify(item.snapshot)]);
   published+=inserted.rowCount;
  }
  if(!published){await client.query('ROLLBACK');return res.status(409).json({error:'This assessment was already published for all selected learners.',skipped:skipped.length});}
  await client.query('UPDATE result_publications SET learner_count=$2 WHERE id=$1',[publication.id,published]);
  await client.query('COMMIT');
  res.status(201).json({publication:{...publication,learner_count:published},published,skipped:skipped.length,message:'Assessment results published and saved. Send parent notifications to deliver SMS.'});
 }catch(e){
  if(client)try{await client.query('ROLLBACK')}catch(rollbackError){console.error('Failed to roll back assessment publication transaction:',rollbackError);}
  if(e.code==='42P01'||e.code==='42703')return res.status(503).json({error:'Apply database migration 036_publish_per_assessment.sql before publishing per assessment.'});
  res.status(e.status||400).json({error:e.message});
 }finally{client?.release();}
});
// Subject-level descriptive analytics. Official merit and report calculations remain separate.
router.get('/:schoolId/analytics/subjects',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{
 let stage='authorization';
 try{
  const sid=req.params.schoolId;
  let {academic_year_id:y,term_id:t,level_id:level,class_id:cls,teacher_id:teacherId,assessment_id:assessmentId}=req.query;
  if(!y||!t)return res.status(400).json({error:'Academic year and term are required'});
  if(req.user.role==='TEACHER'){
   const own=(await db.query(`SELECT id FROM teachers WHERE school_id=$1::uuid AND user_id=$2::uuid AND COALESCE(is_active,true)=true LIMIT 1`,[sid,req.user.user_id])).rows[0];
   if(!own)return res.status(403).json({error:'No active teacher profile is linked to this account.'});
   teacherId=own.id;
  }
  if(req.user.role==='CLASS_TEACHER'){
   const own=(await db.query(`SELECT cta.class_id FROM class_teacher_assignments cta JOIN teachers th ON th.id=cta.teacher_id WHERE cta.school_id=$1::uuid AND th.user_id=$2::uuid AND cta.academic_year_id=$3::uuid AND ($4::uuid IS NULL OR cta.class_id=$4::uuid) ORDER BY cta.created_at DESC LIMIT 1`,[sid,req.user.user_id,y,cls||null])).rows[0];
   if(!own)return res.status(403).json({error:'No active Class Teacher assignment found for this academic year.'});
   cls=own.class_id;
  }
  stage='academic term lookup';
  const term=(await db.query(`SELECT id,academic_year_id FROM terms WHERE id=$1::uuid AND school_id=$2::uuid`,[t,sid])).rows[0];
  if(!term||String(term.academic_year_id)!==String(y))return res.status(404).json({error:'The selected term does not belong to this academic year.'});
  const classParams=[sid];
  let classFilter='';
  if(level){classParams.push(level);classFilter+=` AND c.school_level_id=$${classParams.length}::uuid`;}
  if(cls){classParams.push(cls);classFilter+=` AND c.id=$${classParams.length}::uuid`;}
  if(req.user.role==='TEACHER'){
   classParams.push(teacherId);
   const teacherParam=classParams.length;
   classParams.push(y);
   const yearParam=classParams.length;
   classParams.push(t);
   const termParam=classParams.length;
   classFilter+=` AND EXISTS(SELECT 1 FROM teacher_subject_assignments tsa WHERE tsa.school_id=c.school_id AND tsa.class_id=c.id AND tsa.teacher_id=$${teacherParam}::uuid AND tsa.academic_year_id=$${yearParam}::uuid AND (tsa.term_id=$${termParam}::uuid OR tsa.term_id IS NULL) AND COALESCE(tsa.is_active,true)=true)`;
  }
  stage='class scope lookup';
  const classes=(await db.query(`SELECT c.id,c.name,c.stream,c.school_level_id,sl.name level_name,sl.school_section_id section_id
   FROM classes c LEFT JOIN school_levels sl ON sl.id=c.school_level_id
   WHERE c.school_id=$1::uuid AND COALESCE(c.is_active,true)=true${classFilter} ORDER BY sl.sort_order,c.name,c.stream`,classParams)).rows;
  if(cls&&!classes.length)return res.status(404).json({error:'The selected class was not found in this school or grade.'});
  if(level&&!classes.length)return res.status(404).json({error:'The selected grade was not found in this school.'});
  if(assessmentId){
   stage='assessment validation';
   const selected=(await db.query(`SELECT id FROM assessments WHERE id=$1::uuid AND school_id=$2::uuid AND academic_year_id=$3::uuid AND term_id=$4::uuid`,[assessmentId,sid,y,t])).rows[0];
   if(!selected)return res.status(404).json({error:'The selected assessment was not found for this year and term.'});
  }
  const classIds=classes.map(row=>row.id);
  const levelIds=[...new Set(classes.map(row=>row.school_level_id).filter(Boolean))];
  const sectionIds=[...new Set(classes.map(row=>row.section_id).filter(Boolean))];
  stage='learner roster lookup';
  const roster=classIds.length?(await db.query(`SELECT DISTINCT l.id,l.admission_no,CONCAT_WS(' ',l.first_name,l.middle_name,l.last_name) learner_name,e.class_id,'ENROLLMENT'::text roster_source
   FROM learner_enrollments e JOIN learners l ON l.id=e.learner_id AND l.school_id=e.school_id JOIN classes c ON c.id=e.class_id AND c.school_id=e.school_id
   WHERE e.school_id=$1::uuid AND e.academic_year_id=$2::uuid AND COALESCE(e.status,'ACTIVE') IN ('ACTIVE','COMPLETED') AND c.id=ANY($3::uuid[])
   UNION
   SELECT DISTINCT l.id,l.admission_no,CONCAT_WS(' ',l.first_name,l.middle_name,l.last_name) learner_name,m.class_id,'MARKS_FALLBACK'::text roster_source
   FROM marks m JOIN learners l ON l.id=m.learner_id AND l.school_id=m.school_id
    JOIN classes c ON c.id=m.class_id AND c.school_id=m.school_id
   WHERE m.school_id=$1::uuid AND m.academic_year_id=$2::uuid AND m.term_id=$4::uuid AND m.mark IS NOT NULL AND c.id=ANY($3::uuid[])
    AND ($5::uuid IS NULL OR m.assessment_id=$5)
    AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM teacher_subject_assignments tsa
     WHERE tsa.school_id=m.school_id AND tsa.teacher_id=$6::uuid AND tsa.subject_id=m.subject_id AND tsa.class_id=m.class_id
      AND tsa.academic_year_id=m.academic_year_id AND (tsa.term_id=m.term_id OR tsa.term_id IS NULL)
      AND COALESCE(tsa.is_active,true)=true))
    AND NOT EXISTS(SELECT 1 FROM learner_enrollments e WHERE e.school_id=m.school_id
     AND e.learner_id=m.learner_id AND e.academic_year_id=m.academic_year_id AND e.class_id=m.class_id
     AND COALESCE(e.status,'ACTIVE') IN ('ACTIVE','COMPLETED'))
   ORDER BY class_id,admission_no`,[sid,y,classIds,t,assessmentId||null,teacherId||null])).rows:[];
  stage='subject assignment lookup';
  const assignments=classIds.length?(await db.query(`SELECT DISTINCT available.class_id,available.subject_id,available.subject_name,available.subject_code
   FROM (
    SELECT tsa.class_id,tsa.subject_id,s.name subject_name,s.code subject_code
    FROM teacher_subject_assignments tsa JOIN subjects s ON s.id=tsa.subject_id
    WHERE tsa.school_id=$1::uuid AND tsa.academic_year_id=$2::uuid AND (tsa.term_id=$3::uuid OR tsa.term_id IS NULL)
     AND COALESCE(tsa.is_active,true)=true AND tsa.class_id=ANY($4::uuid[])
     AND ($5::uuid IS NULL OR tsa.teacher_id=$5::uuid)
     AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM assessments a WHERE a.id=$6
      AND (a.class_id IS NULL OR a.class_id=tsa.class_id) AND (a.subject_id IS NULL OR a.subject_id=tsa.subject_id)))
    UNION
    SELECT c.id,a.subject_id,s.name subject_name,s.code subject_code
    FROM assessments a JOIN classes c ON (a.class_id IS NULL OR a.class_id=c.id)
     JOIN subjects s ON s.id=a.subject_id
    WHERE a.school_id=$1::uuid AND a.academic_year_id=$2::uuid AND a.term_id=$3::uuid AND a.subject_id IS NOT NULL
     AND c.id=ANY($4::uuid[]) AND ($6::uuid IS NULL OR a.id=$6)
     AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM teacher_subject_assignments tsa
      WHERE tsa.school_id=$1::uuid AND tsa.academic_year_id=$2::uuid AND (tsa.term_id=$3::uuid OR tsa.term_id IS NULL)
       AND tsa.class_id=c.id AND tsa.subject_id=a.subject_id AND tsa.teacher_id=$5::uuid
       AND COALESCE(tsa.is_active,true)=true))
   ) available`,[sid,y,t,classIds,teacherId||null,assessmentId||null])).rows:[];
  stage='saved marks lookup';
  const marks=classIds.length?(await db.query(`SELECT m.learner_id,m.class_id,m.subject_id,s.name subject_name,s.code subject_code,
     m.assessment_id,a.name assessment_name,a.assessment_type,m.mark,a.max_mark
   FROM marks m JOIN assessments a ON a.id=m.assessment_id AND a.school_id=m.school_id
   JOIN subjects s ON s.id=m.subject_id JOIN classes c ON c.id=m.class_id AND c.school_id=m.school_id
   JOIN learners l ON l.id=m.learner_id AND l.school_id=m.school_id
   WHERE m.school_id=$1::uuid AND m.academic_year_id=$2::uuid AND m.term_id=$3::uuid AND m.mark IS NOT NULL AND a.max_mark>0
    AND c.id=ANY($4::uuid[]) AND ($5::uuid IS NULL OR a.id=$5)
    AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM teacher_subject_assignments tsa
     WHERE tsa.school_id=m.school_id AND tsa.teacher_id=$6::uuid AND tsa.subject_id=m.subject_id AND tsa.class_id=m.class_id
      AND tsa.academic_year_id=m.academic_year_id AND (tsa.term_id=m.term_id OR tsa.term_id IS NULL)
      AND COALESCE(tsa.is_active,true)=true))
   ORDER BY s.name,m.class_id,m.learner_id,a.assessment_order,a.name`,[sid,y,t,classIds,assessmentId||null,teacherId||null])).rows:[];
  const subjectIds=[...new Set([...assignments.map(row=>row.subject_id),...marks.map(row=>row.subject_id)])];
  stage='grading configuration lookup';
  const configs=classIds.length&&subjectIds.length?(await db.query(`SELECT ac.class_id,ac.level_id,ac.section_id,ac.subject_id,ac.assessment_id,ac.target_mark,
     gs.id grading_system_id,COALESCE(json_agg(json_build_object('label',gb.label,'min_mark',gb.min_mark,'max_mark',gb.max_mark,'descriptor',gb.descriptor)
      ORDER BY gb.min_mark DESC) FILTER(WHERE gb.id IS NOT NULL),'[]') bands
   FROM assessment_configurations ac JOIN grading_systems gs ON gs.id=ac.grading_system_id AND gs.is_active=true
   LEFT JOIN grading_bands gb ON gb.grading_system_id=gs.id
   WHERE ac.school_id=$1 AND (ac.class_id IS NULL OR ac.class_id=ANY($2::uuid[]))
    AND (ac.level_id IS NULL OR ac.level_id=ANY($3::uuid[]))
    AND (ac.section_id IS NULL OR ac.section_id=ANY($4::uuid[]))
    AND (ac.subject_id IS NULL OR ac.subject_id=ANY($5::uuid[]))
    AND (ac.assessment_id IS NULL OR ac.assessment_id=$6::uuid)
   GROUP BY ac.id,gs.id`,[sid,classIds,levelIds,sectionIds,subjectIds,assessmentId||null])).rows.map(row=>({...row,bands:Array.isArray(row.bands)?row.bands:[]})):[];
  stage='historical trend lookup';
  const trends=classIds.length?(await db.query(`SELECT m.academic_year_id,ay.year_label,m.term_id,tr.name term_name,tr.term_no,
     m.subject_id,s.name subject_name,COUNT(DISTINCT m.learner_id)::int assessed,
     AVG((m.mark/NULLIF(a.max_mark,0))*100.0) average
    FROM marks m JOIN assessments a ON a.id=m.assessment_id JOIN subjects s ON s.id=m.subject_id
    JOIN academic_years ay ON ay.id=m.academic_year_id JOIN terms tr ON tr.id=m.term_id
    JOIN classes c ON c.id=m.class_id
    WHERE m.school_id=$1 AND m.mark IS NOT NULL AND a.max_mark>0 AND c.id=ANY($2::uuid[])
     AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM teacher_subject_assignments tsa
      WHERE tsa.school_id=m.school_id AND tsa.teacher_id=$3 AND tsa.subject_id=m.subject_id AND tsa.class_id=m.class_id
       AND tsa.academic_year_id=m.academic_year_id AND (tsa.term_id=m.term_id OR tsa.term_id IS NULL)
       AND COALESCE(tsa.is_active,true)=true))
    GROUP BY m.academic_year_id,ay.year_label,m.term_id,tr.name,tr.term_no,m.subject_id,s.name
    ORDER BY ay.year_label,tr.term_no,s.name`,[sid,classIds,teacherId||null])).rows:[];
  const {analyzeSubjectPerformance}=require('../services/subject-analytics-engine');
  const result=analyzeSubjectPerformance({classes,roster,assignments,marks,configs,trends,assessmentId:assessmentId||null});
  res.json({...result,enrollment_fallback_count:roster.filter(row=>row.roster_source==='MARKS_FALLBACK').length,context:{academic_year_id:y,term_id:t,level_id:level||null,class_id:cls||null,teacher_id:teacherId||null,assessment_id:assessmentId||null}});
 }catch(e){console.error(`Unable to load subject analytics during ${stage}:`,e);res.status(e.status||500).json({error:`Subject analytics failed during ${stage}: ${e.message||'Unable to load results'}`});}
});

// Deep academic analytics for the selected grade/class context.
router.get('/:schoolId/analytics',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER'),async(req,res)=>{
 try{
 const sid=req.params.schoolId; let {academic_year_id:y,term_id:t,level_id:level,class_id:cls,teacher_id:teacherFilter}=req.query; if(req.user.role==='CLASS_TEACHER'){const own=(await db.query(`SELECT cta.class_id FROM class_teacher_assignments cta JOIN teachers th ON th.id=cta.teacher_id WHERE cta.school_id=$1 AND th.user_id=$2 AND cta.academic_year_id=$3 AND ($4::uuid IS NULL OR cta.class_id=$4) ORDER BY cta.created_at DESC LIMIT 1`,[sid,req.user.user_id,y,cls||null])).rows[0];if(!own)return res.status(403).json({error:'No active Class Teacher assignment found for this academic year.'});cls=own.class_id;const me=(await db.query(`SELECT id FROM teachers WHERE school_id=$1 AND user_id=$2 AND COALESCE(is_active,true)=true LIMIT 1`,[sid,req.user.user_id])).rows[0];teacherFilter=me?.id||null;}
  if(!y||!t)return res.status(400).json({error:'Academic year and term are required'});
  const term=(await db.query(`SELECT id,term_no,name FROM terms WHERE id=$1 AND school_id=$2`,[t,sid])).rows[0];
  if(!term)return res.status(404).json({error:'Term not found'});
  const cacheKey=[sid,y,t,level||'',cls||'',teacherFilter||''].join('|');
  const cached=analyticsResponseCache.get(cacheKey);
  if(cached && cached.expires>Date.now()) return res.json(cached.payload);
  if(cached && cached.expires<=Date.now()) analyticsResponseCache.delete(cacheKey);
  const filters=[];const params=[sid,y,t];let n=4;
  if(level){filters.push(`c.school_level_id=$${n++}`);params.push(level)}
  if(cls){filters.push(`m.class_id=$${n++}`);params.push(cls)}
  const where=filters.length?' AND '+filters.join(' AND '):'';
  const overall=(await db.query(`SELECT COUNT(DISTINCT m.learner_id)::int learners,COUNT(m.id)::int mark_entries,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) mean_mark,ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY (m.mark/NULLIF(a.max_mark,0))*100.0))::numeric,2) median_mark,ROUND(MIN((m.mark/NULLIF(a.max_mark,0))*100.0),2) min_mark,ROUND(MAX((m.mark/NULLIF(a.max_mark,0))*100.0),2) max_mark FROM marks m JOIN assessments a ON a.id=m.assessment_id JOIN classes c ON c.id=m.class_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL${where}`,params)).rows[0];
  const expected=(await db.query(`SELECT COUNT(DISTINCT e.learner_id)*COUNT(DISTINCT tsa.subject_id)*COUNT(DISTINCT a.id)::int expected_mark_entries
    FROM learner_enrollments e JOIN classes c ON c.id=e.class_id
    JOIN teacher_subject_assignments tsa ON tsa.school_id=e.school_id AND tsa.class_id=e.class_id AND tsa.academic_year_id=$2 AND (tsa.term_id=$3 OR tsa.term_id IS NULL) AND COALESCE(tsa.is_active,true)=true
    JOIN assessments a ON a.school_id=e.school_id AND a.academic_year_id=$2 AND a.term_id=$3
    WHERE e.school_id=$1 AND e.academic_year_id=$2 AND COALESCE(e.status,'ACTIVE')='ACTIVE'${level?' AND c.school_level_id=$4':''}${cls?` AND c.id=$${level?5:4}`:''}`,[sid,y,t,...(level?[level]:[]),...(cls?[cls]:[])])).rows[0];
  overall.expected_mark_entries=Number(expected?.expected_mark_entries||0);
  const subjects=(await db.query(`SELECT s.id,s.code,s.name,COUNT(m.id)::int entries,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average,ROUND(MIN((m.mark/NULLIF(a.max_mark,0))*100.0),2) min_mark,ROUND(MAX((m.mark/NULLIF(a.max_mark,0))*100.0),2) max_mark,
    COALESCE((SELECT CONCAT_WS(' ',th.first_name,th.last_name) FROM teacher_subject_assignments tsa JOIN teachers th ON th.id=tsa.teacher_id WHERE tsa.school_id=$1 AND tsa.subject_id=s.id AND tsa.academic_year_id=$2 AND (tsa.term_id=$3 OR tsa.term_id IS NULL) AND COALESCE(tsa.is_active,true)=true ${cls?`AND tsa.class_id=$${level?5:4}`:''} AND COALESCE(th.is_active,true)=true AND NOT (upper(trim(coalesce(th.first_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.last_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.staff_no,''))) IN ('TEACHER','ADMIN','MR.TEACHER','MR. TEACHER')) ORDER BY (tsa.term_id IS NOT NULL) DESC,tsa.created_at DESC,tsa.id DESC LIMIT 1),'Not assigned') teacher_name
    FROM marks m JOIN assessments a ON a.id=m.assessment_id JOIN subjects s ON s.id=m.subject_id JOIN classes c ON c.id=m.class_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL${where} GROUP BY s.id,s.code,s.name ORDER BY average DESC NULLS LAST`,params)).rows;
  const classes=(await db.query(`SELECT c.id,c.name,c.stream,COUNT(DISTINCT m.learner_id)::int learners,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average FROM classes c LEFT JOIN marks m ON m.class_id=c.id AND m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL LEFT JOIN assessments a ON a.id=m.assessment_id WHERE c.school_id=$1 ${level?'AND c.school_level_id=$4':''}${cls?` AND c.id=$${level?5:4}`:''} GROUP BY c.id,c.name,c.stream ORDER BY average DESC NULLS LAST`,params)).rows;
  const streams=(await db.query(`SELECT COALESCE(NULLIF(c.stream,''),'Main') stream,c.name class_name,COUNT(DISTINCT m.learner_id)::int learners,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average FROM classes c JOIN marks m ON m.class_id=c.id AND m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL JOIN assessments a ON a.id=m.assessment_id WHERE c.school_id=$1${level?' AND c.school_level_id=$4':''}${cls?` AND c.id=$${level?5:4}`:''} GROUP BY c.id,c.name,c.stream ORDER BY average DESC NULLS LAST`,params)).rows;
  const gender=(await db.query(`SELECT COALESCE(NULLIF(l.gender,''),'Not specified') gender,COUNT(DISTINCT l.id)::int learners,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average FROM learners l JOIN marks m ON m.learner_id=l.id JOIN assessments a ON a.id=m.assessment_id JOIN classes c ON c.id=m.class_id WHERE l.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL${where} GROUP BY COALESCE(NULLIF(l.gender,''),'Not specified') ORDER BY average DESC`,params)).rows;
  const learnerSubjects=(await db.query(`SELECT l.id learner_id,CONCAT_WS(' ',l.first_name,l.middle_name,l.last_name) learner_name,l.gender,c.name class_name,c.stream,s.id subject_id,s.name subject_name,AVG((m.mark/NULLIF(a.max_mark,0))*100.0) average FROM marks m JOIN learners l ON l.id=m.learner_id JOIN assessments a ON a.id=m.assessment_id JOIN subjects s ON s.id=m.subject_id JOIN classes c ON c.id=m.class_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL${where} GROUP BY l.id,l.first_name,l.middle_name,l.last_name,l.gender,c.name,c.stream,s.id,s.name`,params)).rows;
  const gradingSystem=(await db.query(`SELECT gs.id FROM grading_systems gs LEFT JOIN assessment_configurations ac ON ac.grading_system_id=gs.id AND ac.school_id=$1 WHERE gs.school_id=$1 AND gs.is_active=true AND (ac.level_id IS NULL OR ac.level_id=(SELECT school_level_id FROM classes WHERE id=$2 AND school_id=$1)) AND (ac.section_id IS NULL OR ac.section_id=(SELECT ss.id FROM school_sections ss JOIN school_levels sl ON sl.school_section_id=ss.id JOIN classes cc ON cc.school_level_id=sl.id WHERE cc.id=$2 AND cc.school_id=$1 LIMIT 1)) AND (ac.subject_id IS NULL AND ac.assessment_id IS NULL) ORDER BY (ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC,gs.id LIMIT 1`,[sid,cls||null])).rows[0]?.id||null;
  const gradingResult=gradingSystem?await db.query(`SELECT gb.label,gb.min_mark,gb.max_mark,gb.points,gb.descriptor,gb.remark FROM grading_bands gb WHERE gb.grading_system_id=$1 ORDER BY gb.min_mark DESC`,[gradingSystem]):{rows:[]}; const grading=Array.isArray(gradingResult?.rows)?gradingResult.rows:[];
  const gradeFor=v=>{const n=Number(v);if(!Number.isFinite(n))return null;return grading.find(g=>n>=Number(g.min_mark)&&n<=Number(g.max_mark))||null;};
  const learnerMap=new Map();for(const r of learnerSubjects){if(!learnerMap.has(r.learner_id))learnerMap.set(r.learner_id,{learner_id:r.learner_id,learner_name:r.learner_name,gender:r.gender,class_name:r.class_name,stream:r.stream,subjects:[]});learnerMap.get(r.learner_id).subjects.push({subject_id:r.subject_id,subject_name:r.subject_name,average:Number(r.average)});}
  const learnerAverages=Array.from(learnerMap.values()).map(l=>({...l,average:l.subjects.length?l.subjects.reduce((a,b)=>a+b.average,0)/l.subjects.length:null}));
  const distribution={};for(const l of learnerAverages){const g=gradeFor(l.average);if(g)distribution[g.label]=(distribution[g.label]||0)+1;}
  let targetRows=[];
  try{targetRows=(await db.query(`SELECT s.id subject_id,s.name subject_name,AVG(ac.target_mark) target_mark,AVG(x.average) achievement FROM assessment_configurations ac JOIN subjects s ON s.id=ac.subject_id JOIN LATERAL (SELECT AVG((m.mark/NULLIF(a.max_mark,0))*100.0) average FROM marks m JOIN assessments a ON a.id=m.assessment_id WHERE m.school_id=ac.school_id AND m.subject_id=ac.subject_id AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL) x ON true WHERE ac.school_id=$1 AND ac.target_mark IS NOT NULL GROUP BY s.id,s.name ORDER BY achievement DESC NULLS LAST`,[sid,y,t])).rows}catch{}
  // Compare with the immediately preceding term in the same academic year where one exists.
  const prev=(await db.query(`SELECT id,term_no,name FROM terms WHERE school_id=$1 AND academic_year_id=$2 AND term_no<$3 ORDER BY term_no DESC LIMIT 1`,[sid,y,term.term_no])).rows[0]||null;
  let progress=[];
  let deviations=[];
  if(prev){
    progress=(await db.query(`SELECT l.id learner_id,CONCAT_WS(' ',l.first_name,l.middle_name,l.last_name) learner_name,ROUND(AVG(CASE WHEN m.term_id=$3 THEN (m.mark/NULLIF(a.max_mark,0))*100.0 END),2) current_average,ROUND(AVG(CASE WHEN m.term_id=$4 THEN (m.mark/NULLIF(a.max_mark,0))*100.0 END),2) previous_average FROM learners l JOIN marks m ON m.learner_id=l.id JOIN assessments a ON a.id=m.assessment_id JOIN classes c ON c.id=m.class_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id IN ($3,$4) AND m.mark IS NOT NULL${level?' AND c.school_level_id=$5':''}${cls?` AND c.id=$${level?6:5}`:''} GROUP BY l.id,l.first_name,l.middle_name,l.last_name ORDER BY (AVG(CASE WHEN m.term_id=$3 THEN (m.mark/NULLIF(a.max_mark,0))*100.0 END)-AVG(CASE WHEN m.term_id=$4 THEN (m.mark/NULLIF(a.max_mark,0))*100.0 END)) DESC LIMIT 20`,[sid,y,t,prev.id,...(level?[level]:[]),...(cls?[cls]:[])])).rows;
    const deviationResult=await db.query(`SELECT s.id subject_id,s.name subject_name,ROUND(AVG(CASE WHEN m.term_id=$3 THEN (m.mark/NULLIF(a.max_mark,0))*100.0 END),2) current_average,ROUND(AVG(CASE WHEN m.term_id=$4 THEN (m.mark/NULLIF(a.max_mark,0))*100.0 END),2) previous_average FROM marks m JOIN assessments a ON a.id=m.assessment_id JOIN subjects s ON s.id=m.subject_id JOIN classes c ON c.id=m.class_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id IN ($3,$4) AND m.mark IS NOT NULL${level?' AND c.school_level_id=$5':''}${cls?` AND c.id=$${level?6:5}`:''} GROUP BY s.id,s.name ORDER BY (AVG(CASE WHEN m.term_id=$3 THEN (m.mark/NULLIF(a.max_mark,0))*100.0 END)-AVG(CASE WHEN m.term_id=$4 THEN (m.mark/NULLIF(a.max_mark,0))*100.0 END)) DESC`,[sid,y,t,prev.id,...(level?[level]:[]),...(cls?[cls]:[])]);
    deviations=Array.isArray(deviationResult?.rows)?deviationResult.rows.map(x=>({...x,deviation:x.current_average==null||x.previous_average==null?null:Number(x.current_average)-Number(x.previous_average)})):[];
  }
  const bestAcross=(await db.query(`SELECT l.id learner_id,CONCAT_WS(' ',l.first_name,l.middle_name,l.last_name) learner_name,c.name class_name,c.stream,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average FROM learners l JOIN marks m ON m.learner_id=l.id JOIN assessments a ON a.id=m.assessment_id JOIN classes c ON c.id=m.class_id WHERE l.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL GROUP BY l.id,l.first_name,l.middle_name,l.last_name,c.name,c.stream ORDER BY average DESC,l.last_name,l.first_name LIMIT 20`,[sid,y,t])).rows;
  const assessmentSummary=(await db.query(`SELECT a.id,a.name,a.assessment_type,a.assessment_order,COUNT(m.id)::int entries,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average FROM assessments a LEFT JOIN marks m ON m.assessment_id=a.id AND m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL WHERE a.school_id=$1 AND a.academic_year_id=$2 AND a.term_id=$3 GROUP BY a.id,a.name,a.assessment_type,a.assessment_order ORDER BY a.assessment_order,a.created_at,a.name`,[sid,y,t])).rows;
  const tpResult=await db.query(`SELECT tsa.teacher_id,CONCAT_WS(' ',th.first_name,th.last_name) teacher_name,s.name subject_name,c.name class_name,c.stream,COUNT(m.id)::int entries,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average,(SELECT AVG(ac.target_mark) FROM assessment_configurations ac WHERE ac.school_id=$1 AND ac.subject_id=s.id AND ac.target_mark IS NOT NULL) target_mark FROM marks m JOIN assessments a ON a.id=m.assessment_id JOIN teacher_subject_assignments tsa ON tsa.school_id=m.school_id AND tsa.subject_id=m.subject_id AND tsa.class_id=m.class_id AND tsa.academic_year_id=m.academic_year_id AND (tsa.term_id=m.term_id OR tsa.term_id IS NULL) AND COALESCE(tsa.is_active,true)=true JOIN teachers th ON th.id=tsa.teacher_id JOIN subjects s ON s.id=m.subject_id JOIN classes c ON c.id=m.class_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND m.mark IS NOT NULL ${cls?'AND m.class_id=$4':''} ${teacherFilter?`AND tsa.teacher_id=$${cls?5:4}`:''} GROUP BY tsa.teacher_id,th.first_name,th.last_name,s.id,s.name,c.id,c.name,c.stream ORDER BY average DESC NULLS LAST`,cls?(teacherFilter?[sid,y,t,cls,teacherFilter]:[sid,y,t,cls]):(teacherFilter?[sid,y,t,teacherFilter]:[sid,y,t]));
  const tp=Array.isArray(tpResult?.rows)?tpResult.rows.map(x=>({...x,target_mark:x.target_mark==null?null:Number(x.target_mark),variance:x.target_mark==null?null:Number(x.average)-Number(x.target_mark)})):[];
  const termTrends=(await db.query(`SELECT tm.term_no,tm.name term_name,tm.opening_date,tm.closing_date,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average FROM terms tm LEFT JOIN marks m ON m.term_id=tm.id AND m.school_id=$1 AND m.academic_year_id=$2 AND m.mark IS NOT NULL ${cls?'AND m.class_id=$3':''} LEFT JOIN assessments a ON a.id=m.assessment_id WHERE tm.school_id=$1 AND tm.academic_year_id=$2 GROUP BY tm.term_no,tm.name,tm.opening_date,tm.closing_date ORDER BY tm.term_no`,cls?[sid,y,cls]:[sid,y])).rows;
  // Expanded analytics: subject trends, class trends, learner trajectories, top improvers/decliners and assessment comparisons.
  let subjectTrends=[],classTrends=[],learnerTrajectories=[],topImprovers=[],topDecliners=[];
  try{subjectTrends=(await db.query(`SELECT tm.term_no,tm.name term_name,s.id subject_id,s.code subject_code,s.name subject_name,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average,COUNT(DISTINCT m.learner_id)::int learners FROM terms tm JOIN marks m ON m.term_id=tm.id AND m.school_id=$1 AND m.academic_year_id=$2 AND m.mark IS NOT NULL JOIN assessments a ON a.id=m.assessment_id JOIN subjects s ON s.id=m.subject_id JOIN classes c ON c.id=m.class_id WHERE tm.school_id=$1 AND tm.academic_year_id=$2 ${level?'AND c.school_level_id=$3':''}${cls?` AND c.id=$${level?4:3}`:''}${teacherFilter?` AND EXISTS (SELECT 1 FROM teacher_subject_assignments tsa WHERE tsa.school_id=m.school_id AND tsa.teacher_id=$${(level?1:0)+(cls?1:0)+4} AND tsa.subject_id=m.subject_id AND tsa.class_id=m.class_id AND tsa.academic_year_id=m.academic_year_id AND (tsa.term_id=m.term_id OR tsa.term_id IS NULL) AND COALESCE(tsa.is_active,true))`:''} GROUP BY tm.term_no,tm.name,s.id,s.code,s.name ORDER BY s.name,tm.term_no`,[sid,y,...(level?[level]:[]),...(cls?[cls]:[]),...(teacherFilter?[teacherFilter]:[])])).rows}catch{}
  try{classTrends=(await db.query(`SELECT tm.term_no,tm.name term_name,c.id class_id,c.name class_name,c.stream,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average,COUNT(DISTINCT m.learner_id)::int learners FROM terms tm JOIN marks m ON m.term_id=tm.id AND m.school_id=$1 AND m.academic_year_id=$2 AND m.mark IS NOT NULL JOIN assessments a ON a.id=m.assessment_id JOIN classes c ON c.id=m.class_id WHERE tm.school_id=$1 AND tm.academic_year_id=$2 ${level?'AND c.school_level_id=$3':''}${cls?` AND c.id=$${level?4:3}`:''} GROUP BY tm.term_no,tm.name,c.id,c.name,c.stream ORDER BY c.name,c.stream,tm.term_no`,[sid,y,...(level?[level]:[]),...(cls?[cls]:[])])).rows}catch{}
  try{learnerTrajectories=(await db.query(`SELECT l.id learner_id,CONCAT_WS(' ',l.first_name,l.middle_name,l.last_name) learner_name,c.name class_name,c.stream,tm.term_no,tm.name term_name,ROUND(AVG((m.mark/NULLIF(a.max_mark,0))*100.0),2) average FROM learners l JOIN marks m ON m.learner_id=l.id JOIN assessments a ON a.id=m.assessment_id JOIN terms tm ON tm.id=m.term_id JOIN classes c ON c.id=m.class_id WHERE l.school_id=$1 AND m.academic_year_id=$2 AND m.mark IS NOT NULL ${level?'AND c.school_level_id=$3':''}${cls?` AND c.id=$${level?4:3}`:''} GROUP BY l.id,l.first_name,l.middle_name,l.last_name,c.name,c.stream,tm.term_no,tm.name ORDER BY learner_name,tm.term_no`,[sid,y,...(level?[level]:[]),...(cls?[cls]:[])])).rows}catch{}
  const trajectoryMap=new Map();for(const r of learnerTrajectories){if(!trajectoryMap.has(r.learner_id))trajectoryMap.set(r.learner_id,{learner_id:r.learner_id,learner_name:r.learner_name,class_name:r.class_name,stream:r.stream,terms:[]});trajectoryMap.get(r.learner_id).terms.push({term_no:r.term_no,term_name:r.term_name,average:r.average==null?null:Number(r.average)});}learnerTrajectories=[...trajectoryMap.values()].map(x=>{const ts=x.terms.slice().sort((a,b)=>a.term_no-b.term_no),first=ts.find(v=>v.average!=null),last=[...ts].reverse().find(v=>v.average!=null);return {...x,change:first&&last&&first!==last?Number(last.average)-Number(first.average):null};});
  topImprovers=learnerTrajectories.filter(x=>x.change!=null).sort((a,b)=>b.change-a.change).slice(0,20);topDecliners=learnerTrajectories.filter(x=>x.change!=null).sort((a,b)=>a.change-b.change).slice(0,20);
  const assessmentComparison=(Array.isArray(assessmentSummary)?assessmentSummary:[]).map(a=>({...a,average:a.average==null?null:Number(a.average)}));
  const proficiency={EE:Number(distribution.EE||0),ME:Number(distribution.ME||0),AE:Number(distribution.AE||0),BE:Number(distribution.BE||0)};
  // Class-summary extensions: derived only from the authenticated, school-scoped learner/subject rows.
  const bySubject=new Map(),byGenderSubject=new Map();
  for(const r of learnerSubjects){
    const score=Number(r.average);if(!Number.isFinite(score))continue;
    const subjectId=String(r.subject_id),genderName=String(r.gender||'Not specified');
    if(!bySubject.has(subjectId))bySubject.set(subjectId,[]);
    bySubject.get(subjectId).push({learner_id:r.learner_id,learner_name:r.learner_name,class_name:r.class_name,stream:r.stream,average:Number(score.toFixed(2)),grade:gradeFor(score)?.label||''});
    const key=subjectId+'|'+genderName;
    if(!byGenderSubject.has(key))byGenderSubject.set(key,{subject_id:r.subject_id,subject_name:r.subject_name,gender:genderName,sum:0,count:0});
    const group=byGenderSubject.get(key);group.sum+=score;group.count++;
  }
  const subject_top_learners=[...bySubject.entries()].map(([subject_id,rows])=>({subject_id,subject_name:learnerSubjects.find(r=>String(r.subject_id)===subject_id)?.subject_name||'',learners:rows.sort((a,b)=>b.average-a.average||a.learner_name.localeCompare(b.learner_name)).slice(0,10).map((r,i)=>({...r,rank:i+1}))})).sort((a,b)=>a.subject_name.localeCompare(b.subject_name));
  const gender_by_subject=[...byGenderSubject.values()].map(({sum,count,...r})=>({...r,learners:count,average:Number((sum/count).toFixed(2))})).sort((a,b)=>a.subject_name.localeCompare(b.subject_name)||a.gender.localeCompare(b.gender));
  const subject_grade_distribution=[...bySubject.entries()].map(([subject_id,rows])=>{const counts={};for(const r of rows){const key=r.grade||'Ungraded';counts[key]=(counts[key]||0)+1;}return {subject_id,subject_name:learnerSubjects.find(r=>String(r.subject_id)===subject_id)?.subject_name||'',total:rows.length,grades:counts};}).sort((a,b)=>a.subject_name.localeCompare(b.subject_name));
  const payload={term,overall,subject_top_learners,gender_by_subject,subject_grade_distribution,teacher_performance:Array.isArray(tp)?tp:[],term_trends:Array.isArray(termTrends)?termTrends:[],subjects:(Array.isArray(subjects)?subjects:[]).map(x=>({...x,grade:gradeFor(x.average)?.label||''})),classes,streams,gender,grade_distribution:distribution,proficiency_distribution:proficiency,grading_bands:grading,target_vs_achievement:(Array.isArray(targetRows)?targetRows:[]).map(x=>({...x,target_mark:Number(x.target_mark),achievement:x.achievement==null?null:Number(x.achievement),variance:x.achievement==null?null:Number(x.achievement)-Number(x.target_mark)})),progress,deviations,best_learners_across_classes:bestAcross,assessment_summary:assessmentSummary,assessment_comparison:assessmentComparison,subject_trends:Array.isArray(subjectTrends)?subjectTrends:[],class_trends:Array.isArray(classTrends)?classTrends:[],learner_trajectories:Array.isArray(learnerTrajectories)?learnerTrajectories:[],top_improvers:topImprovers,top_decliners:topDecliners,learner_averages:learnerAverages.sort((a,b)=>(b.average||-1)-(a.average||-1)).slice(0,20)};
  analyticsResponseCache.set(cacheKey,{expires:Date.now()+10000,payload});
  if(analyticsResponseCache.size>80){const oldest=analyticsResponseCache.keys().next().value;analyticsResponseCache.delete(oldest);}
  res.json(payload);
 }catch(e){res.status(400).json({error:e.message})}});
router.get('/:schoolId/sms-balance',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const provider=String(process.env.SMS_PROVIDER||'').toUpperCase();if(provider!=='TOPMEDIA')return res.status(400).json({error:'SMS_PROVIDER must be set to TOPMEDIA to check the TopMediaSMS balance.'});const apiKey=process.env.SMS_TOPMEDIA_API_KEY||process.env.TOPMEDIA_API_KEY;if(!apiKey)return res.status(503).json({error:'Set SMS_TOPMEDIA_API_KEY on the server before checking the balance.'});const base=String(process.env.SMS_TOPMEDIA_BASE_URL||'https://api.topmediasms.com/v1').trim().replace(/\/+$/, '');const rr=await fetch(base+'/api-balance',{headers:{Accept:'application/json',Authorization:'Bearer '+apiKey}});const data=await rr.json().catch(()=>({}));if(!rr.ok)throw new Error(data?.message||('TopMediaSMS returned '+rr.status));res.json({provider:'TOPMEDIA',balance:data?.balance??null,currency:data?.currency||null,sandbox:Boolean(data?.sandbox)})}catch(e){res.status(e.status||502).json({error:e.message})}});
module.exports=router;
module.exports.buildPublicationSummary=buildPublicationSummary;
