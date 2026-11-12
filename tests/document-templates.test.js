'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {documentTemplate,documentTemplates,validDocumentCategory}=require('../backend/services/document-templates');

test('selects supported document designs and defaults to classic',()=>{
 assert.equal(documentTemplate(undefined),'classic');
 assert.equal(documentTemplate('modern'),'modern');
 assert.equal(documentTemplate('academic'),'academic');
 assert.equal(documentTemplate('subject-champion','CERTIFICATE'),'subject-champion');
});

test('rejects unknown document designs',()=>{
 assert.equal(documentTemplate('unknown','ID_CARD'),null);
 assert.equal(documentTemplate(''), 'classic');
 assert.equal(documentTemplate('sports-achievement','ID_CARD'),null);
});

test('exposes distinct visual templates and valid certificate categories',()=>{
 const ids=documentTemplates('ID_CARD');
 const certificates=documentTemplates('CERTIFICATE');
 assert.equal(ids.length,3);
 assert.equal(certificates.length,7);
 assert.equal(new Set(certificates.map(item=>item.id)).size,certificates.length);
 assert.equal(validDocumentCategory('SPORTS'),true);
 assert.equal(validDocumentCategory('UNKNOWN'),false);
});
