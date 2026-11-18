'use strict';

const crypto = require('crypto');

function parseVersionedKeys() {
  const map = new Map();
  const multi = String(process.env.DOCUMENT_TOKEN_ENCRYPTION_KEYS || '').trim();
  if (multi) {
    for (const entry of multi.split(',')) {
      const idx = entry.indexOf(':');
      if (idx <= 0) continue;
      const ver = Number(entry.slice(0, idx).trim());
      const secret = entry.slice(idx + 1).trim();
      if (Number.isInteger(ver) && ver > 0 && secret.length >= 32) {
        map.set(ver, crypto.createHash('sha256').update(secret).digest());
      }
    }
  }
  const legacy = String(process.env.DOCUMENT_TOKEN_ENCRYPTION_KEY || '').trim();
  if (legacy.length >= 32 && !map.has(1)) {
    map.set(1, crypto.createHash('sha256').update(legacy).digest());
  }
  return map;
}

function getActiveEncryptionKey() {
  const keys = parseVersionedKeys();
  if (!keys.size) {
    throw Object.assign(
      new Error('Configure DOCUMENT_TOKEN_ENCRYPTION_KEY (at least 32 characters) before issuing or downloading verification documents.'),
      { status: 503 }
    );
  }
  const highestVersion = Math.max(...keys.keys());
  return { version: highestVersion, key: keys.get(highestVersion) };
}

function requireDocumentKey() {
  return getActiveEncryptionKey().key;
}

function randomDocumentToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function documentTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function encryptDocumentToken(token) {
  const { version, key } = getActiveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(token || ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${version}:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptDocumentToken(payload) {
  const keys = parseVersionedKeys();
  const parts = String(payload || '').split(':');
  const match = /^v(\d+)$/.exec(parts[0] || '');
  if (parts.length !== 4 || !match) {
    throw Object.assign(new Error('Stored document verification token is invalid.'), { status: 500 });
  }
  const version = Number(match[1]);
  const key = keys.get(version);
  if (!key) {
    throw Object.assign(new Error(`Missing document encryption key for token version v${version}.`), { status: 503 });
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const data = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = {
  requireDocumentKey,
  getActiveEncryptionKey,
  randomDocumentToken,
  documentTokenHash,
  hashDocumentToken: documentTokenHash,
  encryptDocumentToken,
  decryptDocumentToken
};
