'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomDocumentToken,documentTokenHash,encryptDocumentToken,decryptDocumentToken}=require('../backend/services/document-security');

test('creates opaque unguessable document tokens and stable one-way hashes',()=>{
 const first=randomDocumentToken(),second=randomDocumentToken();
 assert.match(first,/^[A-Za-z0-9_-]{40,50}$/);
 assert.notEqual(first,second);
 assert.equal(documentTokenHash(first),documentTokenHash(first));
 assert.notEqual(documentTokenHash(first),first);
});

test('encrypts tokens for later authenticated document reprints',()=>{
 const previous=process.env.DOCUMENT_TOKEN_ENCRYPTION_KEY;process.env.DOCUMENT_TOKEN_ENCRYPTION_KEY='test-secret-for-document-token-encryption-32chars';
 try{
  const token=randomDocumentToken(),encrypted=encryptDocumentToken(token);
  assert.notEqual(encrypted,token);
  assert.equal(decryptDocumentToken(encrypted),token);
  assert.throws(()=>decryptDocumentToken(encrypted.slice(0,-2)+'xx'));
 }finally{
  if(previous===undefined)delete process.env.DOCUMENT_TOKEN_ENCRYPTION_KEY;else process.env.DOCUMENT_TOKEN_ENCRYPTION_KEY=previous;
 }
});
