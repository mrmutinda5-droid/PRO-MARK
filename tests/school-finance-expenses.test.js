'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExpenseInput, assertTransition } = require('../backend/services/school-finance-expenses');

const validExpense = {
  category_id: '123e4567-e89b-42d3-a456-426614174000',
  description: 'Repair classroom windows',
  amount: '1250.50',
  payment_method: 'BANK_DEPOSIT',
  payment_reference: 'TX-123',
  supplier: 'Local supplier',
  transaction_date: '2026-11-12'
};

test('validates and normalizes expense values', () => {
  assert.deepEqual(validateExpenseInput(validExpense), {
    category_id: '123e4567-e89b-42d3-a456-426614174000',
    description: 'Repair classroom windows',
    amount: 1250.5,
    payment_method: 'BANK',
    payment_reference: 'TX-123',
    supplier: 'Local supplier',
    transaction_date: '2026-11-12'
  });
});

test('rejects invalid amount, date, and payment method', () => {
  assert.throws(() => validateExpenseInput({ ...validExpense, amount: 0 }), /greater than zero/);
  assert.throws(() => validateExpenseInput({ ...validExpense, amount: 1.001 }), /decimal places/);
  assert.throws(() => validateExpenseInput({ ...validExpense, transaction_date: '2026-02-30' }), /valid transaction date/);
  assert.throws(() => validateExpenseInput({ ...validExpense, payment_method: 'CRYPTO' }), /supported payment method/);
});

test('rejects a malformed expense category identifier', () => {
  assert.throws(() => validateExpenseInput({ ...validExpense, category_id: 'not-a-uuid' }), /valid expense category/);
});

test('enforces explicit expense approval and payment transitions', () => {
  assert.doesNotThrow(() => assertTransition('RECORDED', 'SUBMITTED'));
  assert.doesNotThrow(() => assertTransition('SUBMITTED', 'APPROVED'));
  assert.doesNotThrow(() => assertTransition('APPROVED', 'PAID'));
  assert.throws(() => assertTransition('RECORDED', 'PAID'), /cannot move/);
  assert.throws(() => assertTransition('PAID', 'CANCELLED'), /cannot move/);
});
