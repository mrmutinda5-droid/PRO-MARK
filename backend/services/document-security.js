'use strict';

const crypto=require('crypto');

function randomDocumentToken(){
 return crypto.randomBytes(32).toString('base64url');
}

function documentTokenHash(token){
 return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function encryptionKey(){
 const secret=process.env.DOCUMENT_TOKEN_ENCRYPTION_KEY;
 if(!secret||secret.length<32)throw Error('Set DOCUMENT_TOKEN_ENCRYPTION_KEY to a persistent secret of at least 32 characters.');
 return crypto.createHash('sha256').update('ZELIMU_DOCUMENT_TOKEN\0').update(secret).digest();
}

function encryptDocumentToken(token){
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv);
 const encrypted=Buffer.concat([cipher.update(String(token),'utf8'),cipher.final()]);
 return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}

function decryptDocumentToken(value){
 const [iv,tag,encrypted]=String(value||'').split('.');
 if(!iv||!tag||!encrypted)throw Error('Invalid encrypted document verification token.');
 const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'base64url'));
 decipher.setAuthTag(Buffer.from(tag,'base64url'));
 return Buffer.concat([decipher.update(Buffer.from(encrypted,'base64url')),decipher.final()]).toString('utf8');
}

module.exports={randomDocumentToken,documentTokenHash,encryptDocumentToken,decryptDocumentToken};
