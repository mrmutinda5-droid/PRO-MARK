'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {allocateAvailablePayments}=require('../backend/services/school-finance-ledger');

function clientWith(payments,charges){
 const allocations=[];
 return {
  allocations,
  async query(sql,params){
   if(sql.includes('FROM school_fee_payments p')&&sql.includes('allocated')){
    return {rows:payments};
   }
   if(sql.includes('FROM school_fee_charges ch')){
    return {rows:charges.map(charge=>({...charge}))};
   }
   if(sql.includes('INSERT INTO school_fee_payment_allocations')){
    allocations.push({schoolId:params[0],paymentId:params[1],chargeId:params[2],amount:params[3]});
    return {rowCount:1,rows:[]};
   }
   throw new Error(`Unexpected ledger query: ${sql}`);
  }
 };
}

test('applies existing payment credits to oldest outstanding charges first',async()=>{
 const client=clientWith(
  [
   {id:'older-payment',amount:'70.00',allocated:'20.00'},
   {id:'newer-payment',amount:'80.00',allocated:'0.00'}
  ],
  [
   {id:'old-charge',balance:'30.00'},
   {id:'new-charge',balance:'100.00'}
  ]
 );

 const result=await allocateAvailablePayments(client,'school','learner');

 assert.deepEqual(client.allocations,[
  {schoolId:'school',paymentId:'older-payment',chargeId:'old-charge',amount:30},
  {schoolId:'school',paymentId:'older-payment',chargeId:'new-charge',amount:20},
  {schoolId:'school',paymentId:'newer-payment',chargeId:'new-charge',amount:80}
 ]);
 assert.equal(result.allocated,130);
 assert.equal(result.allocationsByPayment.get('older-payment'),50);
 assert.equal(result.allocationsByPayment.get('newer-payment'),80);
});

test('retains prepaid credit when no charges are outstanding',async()=>{
 const client=clientWith([{id:'payment',amount:'125.00',allocated:'25.00'}],[]);

 const result=await allocateAvailablePayments(client,'school','learner');

 assert.deepEqual(client.allocations,[]);
 assert.equal(result.allocated,0);
 assert.equal(result.allocationsByPayment.size,0);
});
