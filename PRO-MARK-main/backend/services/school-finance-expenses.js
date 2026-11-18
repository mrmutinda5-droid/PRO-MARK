'use strict';

const METHODS = new Set(['CASH', 'MPESA', 'BANK', 'CHEQUE', 'OTHER']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSITIONS = {
  SUBMITTED: new Set(['RECORDED', 'REJECTED']),
  APPROVED: new Set(['SUBMITTED']),
  REJECTED: new Set(['SUBMITTED']),
  PAID: new Set(['APPROVED']),
  CANCELLED: new Set(['RECORDED', 'SUBMITTED', 'REJECTED', 'APPROVED'])
};

function validateExpenseInput(body = {}) {
  const description = String(body.description || '').trim();
  const amount = Number(body.amount);
  const rawMethod = String(body.payment_method || 'CASH').trim().toUpperCase();
  const paymentMethod = ({ 'M-PESA': 'MPESA', BANK_DEPOSIT: 'BANK' })[rawMethod] || rawMethod;
  const transactionDate = body.transaction_date || new Date().toISOString().slice(0, 10);
  if (!UUID.test(String(body.category_id || ''))) {
    throw Object.assign(new Error('Select a valid expense category.'), { status: 400 });
  }
  if (!description || description.length > 500) {
    throw Object.assign(new Error('Description is required and must be 500 characters or fewer.'), { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) / 100 !== amount) {
    throw Object.assign(new Error('Enter an expense amount greater than zero with no more than two decimal places.'), { status: 400 });
  }
  if (!METHODS.has(paymentMethod)) {
    throw Object.assign(new Error('Select a supported payment method.'), { status: 400 });
  }
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(transactionDate))
    ? new Date(`${transactionDate}T00:00:00Z`)
    : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== transactionDate) {
    throw Object.assign(new Error('Enter a valid transaction date.'), { status: 400 });
  }
  const supplier = String(body.supplier || '').trim();
  const paymentReference = String(body.payment_reference || '').trim();
  if (supplier.length > 200 || paymentReference.length > 120) {
    throw Object.assign(new Error('Supplier must be 200 characters or fewer and reference 120 characters or fewer.'), { status: 400 });
  }
  return {
    category_id: body.category_id,
    description,
    amount: Math.round(amount * 100) / 100,
    payment_method: paymentMethod,
    payment_reference: paymentReference,
    supplier,
    transaction_date: transactionDate
  };
}

function assertTransition(current, next) {
  if (!TRANSITIONS[next]?.has(current)) {
    throw Object.assign(new Error(`An expense cannot move from ${current} to ${next}.`), { status: 409 });
  }
}

module.exports = { validateExpenseInput, assertTransition };
