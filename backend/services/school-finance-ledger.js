'use strict';

const money=value=>Math.round((Number(value)||0)*100)/100;

async function allocateAvailablePayments(client,schoolId,learnerId){
 const payments=(await client.query(`
  SELECT p.id,p.amount,COALESCE(a.allocated,0) allocated
  FROM school_fee_payments p
  LEFT JOIN (
   SELECT payment_id,sum(amount) allocated
   FROM school_fee_payment_allocations
   WHERE school_id=$1
   GROUP BY payment_id
  ) a ON a.payment_id=p.id
  WHERE p.school_id=$1 AND p.learner_id=$2 AND p.status='CONFIRMED'
   AND NOT EXISTS (
    SELECT 1 FROM school_fee_payment_reversals r
    WHERE r.school_id=p.school_id AND r.payment_id=p.id
   )
  ORDER BY p.payment_date,p.created_at,p.id
 `,[schoolId,learnerId])).rows;
 const charges=(await client.query(`
  SELECT ch.id,ch.amount-COALESCE(a.allocated,0) balance
  FROM school_fee_charges ch
  LEFT JOIN (
   SELECT a.charge_id,sum(a.amount) allocated
   FROM school_fee_payment_allocations a
   JOIN school_fee_payments p ON p.id=a.payment_id AND p.status='CONFIRMED'
   JOIN school_fee_charges ch ON ch.id=a.charge_id AND ch.school_id=a.school_id
   WHERE a.school_id=$1 AND ch.learner_id=$2
    AND NOT EXISTS (
     SELECT 1 FROM school_fee_payment_reversals r
     WHERE r.school_id=p.school_id AND r.payment_id=p.id
    )
   GROUP BY a.charge_id
  ) a ON a.charge_id=ch.id
  WHERE ch.school_id=$1 AND ch.learner_id=$2
   AND ch.amount>COALESCE(a.allocated,0)
  ORDER BY ch.due_on NULLS LAST,ch.created_at,ch.id
 `,[schoolId,learnerId])).rows;

 let chargeIndex=0,allocated=0;
 const allocationsByPayment=new Map();
 for(const payment of payments){
  let remaining=money(Number(payment.amount)-Number(payment.allocated));
  while(remaining>0&&chargeIndex<charges.length){
   const charge=charges[chargeIndex],balance=money(charge.balance);
   if(balance<=0){chargeIndex++;continue;}
   const amount=money(Math.min(remaining,balance));
   await client.query(`
    INSERT INTO school_fee_payment_allocations(school_id,payment_id,charge_id,amount)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(payment_id,charge_id) DO NOTHING
   `,[schoolId,payment.id,charge.id,amount]);
   remaining=money(remaining-amount);
   charge.balance=money(balance-amount);
   allocated=money(allocated+amount);
   allocationsByPayment.set(payment.id,money((allocationsByPayment.get(payment.id)||0)+amount));
   if(charge.balance<=0)chargeIndex++;
  }
 }
 return {allocated,allocationsByPayment};
}

module.exports={allocateAvailablePayments,money};
