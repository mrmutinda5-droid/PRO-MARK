const express=require('express');
const crypto=require('crypto');
const db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {allocateAvailablePayments,money}=require('../services/school-finance-ledger');
const router=express.Router();
router.use(authenticate);
const FINANCE_ROLES=['SCHOOL_ADMIN','ADMIN'];

const validDate=value=>{
 if(value===undefined||value===null||value==='')return true;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))return false;
 const d=new Date(String(value)+'T00:00:00Z');
 return !Number.isNaN(d.getTime()) &&
        d.toISOString().slice(0,10)===String(value);
};
const validMoney=value=>
 Number.isFinite(Number(value)) &&
 Number(value)>0 &&
 Math.round(Number(value)*100)/100===Number(value);


router.get('/:schoolId/overview',schoolBoundary,roles(...FINANCE_ROLES,'HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'),async(req,res)=>{
 try{
  const sid=req.params.schoolId;
  const [structures,learners,charges,payments,summary,balances]=await Promise.all([
   db.query(`SELECT fs.*,ay.year_label,c.name class_name,c.stream FROM school_fee_structures fs LEFT JOIN academic_years ay ON ay.id=fs.academic_year_id LEFT JOIN classes c ON c.id=fs.class_id WHERE fs.school_id=$1 ORDER BY fs.is_active DESC,fs.created_at DESC`,[sid]),
   db.query(`SELECT l.id,l.admission_no,l.first_name,l.middle_name,l.last_name,l.class_id,c.name class_name,c.stream FROM learners l LEFT JOIN classes c ON c.id=l.class_id WHERE l.school_id=$1 AND COALESCE(l.is_active,true)=true ORDER BY c.name,c.stream,l.last_name,l.first_name`,[sid]),
   db.query(`SELECT ch.id,ch.learner_id,ch.description,ch.amount,ch.due_on,ch.created_at,l.admission_no,l.first_name,l.middle_name,l.last_name,c.name class_name,c.stream,COALESCE(a.allocated,0) amount_paid FROM school_fee_charges ch JOIN learners l ON l.id=ch.learner_id LEFT JOIN classes c ON c.id=l.class_id LEFT JOIN (SELECT a.charge_id,sum(a.amount) allocated FROM school_fee_payment_allocations a JOIN school_fee_payments p ON p.id=a.payment_id AND p.status='CONFIRMED' AND NOT EXISTS(SELECT 1 FROM school_fee_payment_reversals r WHERE r.school_id=p.school_id AND r.payment_id=p.id) WHERE a.school_id=$1 GROUP BY a.charge_id) a ON a.charge_id=ch.id WHERE ch.school_id=$1 ORDER BY ch.due_on NULLS LAST,ch.created_at DESC LIMIT 500`,[sid]),
   db.query(`SELECT p.*,l.admission_no,l.first_name,l.middle_name,l.last_name,r.credit_note_no,r.reason reversal_reason,r.created_at reversed_at,(r.id IS NOT NULL) reversed FROM school_fee_payments p JOIN learners l ON l.id=p.learner_id LEFT JOIN school_fee_payment_reversals r ON r.school_id=p.school_id AND r.payment_id=p.id WHERE p.school_id=$1 ORDER BY p.payment_date DESC,p.created_at DESC LIMIT 100`,[sid]),
   db.query(`SELECT COALESCE(charged.total,0) charged,COALESCE(received.total,0) collected,COALESCE(charged.total,0)-COALESCE(received.total,0) net_balance,GREATEST(COALESCE(charged.total,0)-COALESCE(received.total,0),0) outstanding,GREATEST(COALESCE(received.total,0)-COALESCE(charged.total,0),0) prepaid_credit FROM (SELECT sum(amount) total FROM school_fee_charges WHERE school_id=$1) charged CROSS JOIN (SELECT sum(p.amount) total FROM school_fee_payments p WHERE p.school_id=$1 AND p.status='CONFIRMED' AND NOT EXISTS(SELECT 1 FROM school_fee_payment_reversals r WHERE r.school_id=p.school_id AND r.payment_id=p.id)) received`,[sid]),
   db.query(`SELECT l.id learner_id,l.admission_no,l.first_name,l.middle_name,l.last_name,c.name class_name,c.stream,COALESCE(ch.total_charged,0) total_charged,COALESCE(pm.total_paid,0) total_paid,COALESCE(ch.total_charged,0)-COALESCE(pm.total_paid,0) balance FROM learners l LEFT JOIN classes c ON c.id=l.class_id LEFT JOIN (SELECT learner_id,sum(amount) total_charged FROM school_fee_charges WHERE school_id=$1 GROUP BY learner_id) ch ON ch.learner_id=l.id LEFT JOIN (SELECT p.learner_id,sum(p.amount) total_paid FROM school_fee_payments p WHERE p.school_id=$1 AND p.status='CONFIRMED' AND NOT EXISTS(SELECT 1 FROM school_fee_payment_reversals r WHERE r.school_id=p.school_id AND r.payment_id=p.id) GROUP BY p.learner_id) pm ON pm.learner_id=l.id WHERE l.school_id=$1 AND COALESCE(l.is_active,true)=true ORDER BY c.name,c.stream,l.last_name,l.first_name`,[sid])
  ]);
  res.json({structures:structures.rows,learners:learners.rows,charges:charges.rows.map(x=>({...x,amount_paid:money(x.amount_paid),balance:money(Number(x.amount)-Number(x.amount_paid))})),payments:payments.rows,balances:balances.rows,summary:summary.rows[0]});
 }catch(e){console.error('School finance overview failed:',e);res.status(500).json({error:'Unable to load school finance records. Apply database migrations 028_school_finance_core.sql and 033_school_fee_ledger_integrity.sql if they have not been applied.'});}
});

router.post('/:schoolId/structures',schoolBoundary,roles(...FINANCE_ROLES),async(req,res)=>{
 let c;
 try{
  const sid=req.params.schoolId,b=req.body||{};
  const name=String(b.name||'').trim(),amount=Number(b.amount),printNotes=String(b.print_notes||'');
  if(!name||!validMoney(b.amount))return res.status(400).json({error:'Fee name and an amount greater than zero are required.'});
  if(name.length>120||printNotes.length>2000)return res.status(400).json({error:'Fee name must be 120 characters or fewer and printed notes must be 2,000 characters or fewer.'});
  if(!validDate(b.due_on))
    return res.status(400).json({error:'Invalid fee due date.'});
  const currency=String(b.currency||'KES').trim().toUpperCase();if(currency!=='KES')return res.status(400).json({error:'This first school-finance release supports KES only so payments cannot be allocated across different currencies.'});
  if(b.academic_year_id){const q=await db.query('SELECT 1 FROM academic_years WHERE id=$1 AND school_id=$2',[b.academic_year_id,sid]);if(!q.rowCount)return res.status(400).json({error:'Academic year does not belong to this school.'});}
  if(b.class_id){const q=await db.query('SELECT 1 FROM classes WHERE id=$1 AND school_id=$2',[b.class_id,sid]);if(!q.rowCount)return res.status(400).json({error:'Class does not belong to this school.'});}
  c=await db.pool.connect();
  await c.query('BEGIN');
  const q=await c.query(`INSERT INTO school_fee_structures(school_id,name,academic_year_id,class_id,amount,currency,due_on,print_notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[sid,name,b.academic_year_id||null,b.class_id||null,money(amount),currency,b.due_on||null,printNotes,req.user.user_id]);
  await c.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,'SCHOOL_FEE_STRUCTURE_CREATED','school_fee_structure',$3,$4::jsonb)`,[sid,req.user.user_id,q.rows[0].id,JSON.stringify({name,amount,currency,class_id:b.class_id||null,academic_year_id:b.academic_year_id||null,print_notes:printNotes})]);
  await c.query('COMMIT');
  res.status(201).json(q.rows[0]);
 }catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});console.error('Create fee structure failed:',e);res.status(500).json({error:'Could not create fee structure. Ensure migrations 028_school_finance_core.sql, 033_school_fee_ledger_integrity.sql, and 034_school_fee_structure_print_notes.sql have been applied.'});}
 finally{if(c)c.release();}
});

router.patch('/:schoolId/structures/:structureId',schoolBoundary,roles(...FINANCE_ROLES),async(req,res)=>{
 let c;
 try{
  const sid=req.params.schoolId,b=req.body||{};
  if(typeof b.is_active!=='undefined'&&typeof b.is_active!=='boolean')
   return res.status(400).json({error:'Fee structure status must be active or archived.'});
  if(typeof b.print_notes!=='undefined'&&(typeof b.print_notes!=='string'||b.print_notes.length>2000))
   return res.status(400).json({error:'Printed notes must be 2,000 characters or fewer.'});
  c=await db.pool.connect();
  await c.query('BEGIN');
  const current=(await c.query('SELECT * FROM school_fee_structures WHERE id=$1 AND school_id=$2 FOR UPDATE',[req.params.structureId,sid])).rows[0];
  if(!current){await c.query('ROLLBACK');return res.status(404).json({error:'Fee structure not found in this school.'});}
  const name=String(b.name===undefined?current.name:b.name).trim();
  const amount=b.amount===undefined?Number(current.amount):Number(b.amount);
  const dueOn=b.due_on===undefined?current.due_on:b.due_on;
  const printNotes=b.print_notes===undefined?current.print_notes:String(b.print_notes);
  if(!name||name.length>120||!validMoney(amount)||!validDate(dueOn)){
   await c.query('ROLLBACK');
   return res.status(400).json({error:'Provide a fee name, a valid amount greater than zero, and a valid due date.'});
  }
  const updated=(await c.query(`
   UPDATE school_fee_structures
   SET name=$3,amount=$4,due_on=$5,print_notes=$6,is_active=COALESCE($7,is_active),updated_at=now()
   WHERE id=$1 AND school_id=$2
   RETURNING *
  `,[current.id,sid,name,money(amount),dueOn||null,printNotes,b.is_active??null])).rows[0];
  await c.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,'SCHOOL_FEE_STRUCTURE_UPDATED','school_fee_structure',$3,$4::jsonb)`,[sid,req.user.user_id,current.id,JSON.stringify({name,amount:money(amount),due_on:dueOn||null,print_notes:printNotes,is_active:updated.is_active})]);
  await c.query('COMMIT');
  res.json(updated);
 }catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});console.error('Update fee structure failed:',e);res.status(500).json({error:'Could not update fee structure. Ensure migration 034_school_fee_structure_print_notes.sql has been applied.'});}
 finally{if(c)c.release();}
});

router.delete('/:schoolId/structures/:structureId',schoolBoundary,roles(...FINANCE_ROLES),async(req,res)=>{
 let c;
 try{
  const sid=req.params.schoolId;
  c=await db.pool.connect();
  await c.query('BEGIN');
  const structure=(await c.query('SELECT id,name,is_active FROM school_fee_structures WHERE id=$1 AND school_id=$2 FOR UPDATE',[req.params.structureId,sid])).rows[0];
  if(!structure){await c.query('ROLLBACK');return res.status(404).json({error:'Fee structure not found in this school.'});}
  const count=Number((await c.query('SELECT count(*)::int count FROM school_fee_charges WHERE school_id=$1 AND fee_structure_id=$2',[sid,structure.id])).rows[0].count);
  let action;
  if(count){
   await c.query('UPDATE school_fee_structures SET is_active=false,updated_at=now() WHERE id=$1 AND school_id=$2',[structure.id,sid]);
   action='ARCHIVED';
  }else{
   await c.query('DELETE FROM school_fee_structures WHERE id=$1 AND school_id=$2',[structure.id,sid]);
   action='DELETED';
  }
  await c.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,'school_fee_structure',$4,$5::jsonb)`,[sid,req.user.user_id,action==='ARCHIVED'?'SCHOOL_FEE_STRUCTURE_ARCHIVED':'SCHOOL_FEE_STRUCTURE_DELETED',structure.id,JSON.stringify({name:structure.name,existing_charges:count})]);
  await c.query('COMMIT');
  res.json({ok:true,action,existing_charges:count});
 }catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});console.error('Remove fee structure failed:',e);res.status(500).json({error:'Could not remove fee structure.'});}
 finally{if(c)c.release();}
});

router.post('/:schoolId/structures/:structureId/assign',schoolBoundary,roles(...FINANCE_ROLES),async(req,res)=>{
 const sid=req.params.schoolId,c=await db.pool.connect();
 try{
  await c.query('BEGIN');
  const f=(await c.query('SELECT * FROM school_fee_structures WHERE id=$1 AND school_id=$2 AND is_active=true FOR UPDATE',[req.params.structureId,sid])).rows[0];
  if(!f)throw Object.assign(new Error('Active fee structure not found.'),{status:404});
  if(!f.class_id)throw Object.assign(new Error('Choose a class on this fee structure before assigning it to learners.'),{status:400});
  const learners=(await c.query(`SELECT id FROM learners WHERE school_id=$1 AND class_id=$2 AND COALESCE(is_active,true)=true ORDER BY admission_no FOR UPDATE`,[sid,f.class_id])).rows;
  const inserted=await c.query(`
   INSERT INTO school_fee_charges(school_id,learner_id,fee_structure_id,description,amount,due_on,academic_year_id,created_by)
   SELECT $1,l.id,$3,$4,$5,$6,$7,$8 FROM learners l
   WHERE l.school_id=$1 AND l.class_id=$2 AND COALESCE(l.is_active,true)=true
   ON CONFLICT(school_id,learner_id,fee_structure_id) DO NOTHING
   RETURNING learner_id
  `,[sid,f.class_id,f.id,f.name,f.amount,f.due_on,f.academic_year_id,req.user.user_id]);
  const creditLearners=(await c.query(`
   SELECT DISTINCT p.learner_id
   FROM school_fee_payments p
   WHERE p.school_id=$1 AND p.learner_id=ANY($2::uuid[]) AND p.status='CONFIRMED'
    AND NOT EXISTS(SELECT 1 FROM school_fee_payment_reversals r WHERE r.school_id=p.school_id AND r.payment_id=p.id)
    AND p.amount>COALESCE((SELECT sum(a.amount) FROM school_fee_payment_allocations a WHERE a.school_id=p.school_id AND a.payment_id=p.id),0)
  `,[sid,learners.map(row=>row.id)])).rows;
  for(const learner of creditLearners)await allocateAvailablePayments(c,sid,learner.learner_id);
  const created=inserted.rowCount;
  await c.query('COMMIT');res.status(201).json({assigned:created,already_assigned:learners.length-created,total_learners:learners.length,prepaid_accounts_updated:creditLearners.length});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(e.status||400).json({error:e.message||'Unable to assign fee structure.'});}finally{c.release();}
});

router.post('/:schoolId/payments',schoolBoundary,roles(...FINANCE_ROLES),async(req,res)=>{
 const sid=req.params.schoolId,b=req.body||{},amount=Number(b.amount),c=await db.pool.connect();
 try{
  if(!b.learner_id||!validMoney(b.amount))throw Object.assign(new Error('Learner and payment amount greater than zero are required.'),{status:400});
  if(!validDate(b.payment_date))
    throw Object.assign(new Error('Invalid payment date.'),{status:400});
  const rawMethod=String(b.payment_method||'CASH').trim().toUpperCase();
  const method=({'M-PESA':'MPESA','BANK_DEPOSIT':'BANK'})[rawMethod]||rawMethod;
  if(!['CASH','MPESA','BANK','CHEQUE'].includes(method))
    throw Object.assign(new Error('Unsupported payment method.'),{status:400});
  const currency=String(b.currency||'KES').toUpperCase();if(currency!=='KES')throw Object.assign(new Error('This first school-finance release supports KES only.'),{status:400});
  const receipt=`ZFC-${new Date().getUTCFullYear()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  await c.query('BEGIN');
  const learner=(await c.query('SELECT id FROM learners WHERE id=$1 AND school_id=$2 FOR UPDATE',[b.learner_id,sid])).rows[0];if(!learner)throw Object.assign(new Error('Learner does not belong to this school.'),{status:400});
  const reference=String(b.reference||'').trim(),fingerprint=reference.toLowerCase();
  if(reference){
   await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`school-fee-reference:${sid}:${fingerprint}`]);
   const duplicate=(await c.query(`SELECT receipt_no FROM school_fee_payments WHERE school_id=$1 AND lower(btrim(reference))=$2 LIMIT 1`,[sid,fingerprint])).rows[0];
   if(duplicate)throw Object.assign(new Error(`Payment reference has already been used on receipt ${duplicate.receipt_no}.`),{status:409});
  }
  const payment=(await c.query(`INSERT INTO school_fee_payments(school_id,learner_id,receipt_no,amount,currency,payment_method,reference,reference_fingerprint,payment_date,notes,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),COALESCE($9::date,CURRENT_DATE),$10,$11) RETURNING *`,[sid,b.learner_id,receipt,money(amount),currency,method,reference,fingerprint,b.payment_date||null,String(b.notes||'').slice(0,500),req.user.user_id])).rows[0];
  await allocateAvailablePayments(c,sid,b.learner_id);
  const paymentAllocation=money((await c.query(`SELECT COALESCE(sum(amount),0) allocated FROM school_fee_payment_allocations WHERE school_id=$1 AND payment_id=$2`,[sid,payment.id])).rows[0].allocated);
  const unallocated=money(Number(payment.amount)-paymentAllocation);
  await c.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,'SCHOOL_FEE_PAYMENT_RECORDED','school_fee_payment',$3,$4::jsonb)`,[sid,req.user.user_id,payment.id,JSON.stringify({receipt_no:receipt,amount:money(amount),currency,learner_id:b.learner_id,allocated:paymentAllocation,unallocated,reference_fingerprint:reference?fingerprint:null})]);
  await c.query('COMMIT');res.status(201).json({payment,allocated:paymentAllocation,unallocated});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(e.status||400).json({error:e.message||'Unable to record payment.'});}finally{c.release();}
});

router.post('/:schoolId/payments/:paymentId/reversals',schoolBoundary,roles(...FINANCE_ROLES),async(req,res)=>{
 const sid=req.params.schoolId,b=req.body||{},reason=String(b.reason||'').trim(),c=await db.pool.connect();
 try{
  if(reason.length<4||reason.length>500)throw Object.assign(new Error('Provide a reversal reason between 4 and 500 characters.'),{status:400});
  await c.query('BEGIN');
  const payment=(await c.query(`SELECT id,learner_id,receipt_no,amount FROM school_fee_payments WHERE id=$1 AND school_id=$2`,[req.params.paymentId,sid])).rows[0];
  if(!payment)throw Object.assign(new Error('Receipt not found in this school.'),{status:404});
  await c.query(`SELECT id FROM learners WHERE id=$1 AND school_id=$2 FOR UPDATE`,[payment.learner_id,sid]);
  const existing=(await c.query(`SELECT credit_note_no FROM school_fee_payment_reversals WHERE school_id=$1 AND payment_id=$2`,[sid,payment.id])).rows[0];
  if(existing)throw Object.assign(new Error(`Receipt has already been reversed by credit note ${existing.credit_note_no}.`),{status:409});
  const creditNote=`ZFCN-${new Date().getUTCFullYear()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const reversal=(await c.query(`INSERT INTO school_fee_payment_reversals(school_id,payment_id,credit_note_no,reason,recorded_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[sid,payment.id,creditNote,reason,req.user.user_id])).rows[0];
  await c.query(`INSERT INTO audit_log(school_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,'SCHOOL_FEE_PAYMENT_REVERSED','school_fee_payment_reversal',$3,$4::jsonb)`,[sid,req.user.user_id,reversal.id,JSON.stringify({receipt_no:payment.receipt_no,credit_note_no:creditNote,amount:payment.amount,reason})]);
  await c.query('COMMIT');res.status(201).json({reversal,payment:{id:payment.id,receipt_no:payment.receipt_no,amount:payment.amount}});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(e.status||400).json({error:e.message||'Unable to reverse receipt.'});}finally{c.release();}
});

module.exports=router;
