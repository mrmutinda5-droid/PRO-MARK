'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {documentTemplate}=require('../backend/services/document-templates');

test('selects supported document designs and defaults to classic',()=>{
 assert.equal(documentTemplate(undefined),'classic');
 assert.equal(documentTemplate('modern'),'modern');
 assert.equal(documentTemplate('academic'),'academic');
});

test('rejects unknown document designs',()=>{
 assert.equal(documentTemplate('unknown'),null);
 assert.equal(documentTemplate(''), 'classic');
});
