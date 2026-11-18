'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { source: assetSource } = require('./assets');

const UPLOADS_ROOT = path.resolve(__dirname, '..', '..', 'uploads');
const PUBLIC_UPLOADS_ROOT = path.resolve(__dirname, '..', '..', 'public', 'uploads');
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

function normalizeMime(raw) {
  const m = String(raw || '').trim().toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg';
  return ALLOWED_MIME.has(m) ? m : null;
}

function parseDataUrl(value) {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const mime = normalizeMime(match[1]);
  if (!mime) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_ASSET_BYTES) return null;
  return { mime, buffer };
}

function detectMimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return null;
}

function resolveDiskUploadPath(urlOrPath) {
  const raw = String(urlOrPath || '').trim();
  if (!raw) return null;
  const rel = raw.replace(/^\/+/, '').replace(/^uploads[\\/]/i, '');
  for (const root of [UPLOADS_ROOT, PUBLIC_UPLOADS_ROOT]) {
    const candidate = path.resolve(root, rel);
    if ((candidate === root || candidate.startsWith(root + path.sep)) && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readImageInput(source) {
  if (!source) return null;
  if (Buffer.isBuffer(source)) {
    if (!source.length || source.length > MAX_ASSET_BYTES) return null;
    return { mime: 'image/png', buffer: source };
  }
  const asDataUrl = parseDataUrl(source);
  if (asDataUrl) return asDataUrl;

  const fallback = assetSource(String(source));
  if (Buffer.isBuffer(fallback)) {
    if (!fallback.length || fallback.length > MAX_ASSET_BYTES) return null;
    return { mime: 'image/png', buffer: fallback };
  }
  const diskPath = (typeof fallback === 'string' && fs.existsSync(fallback))
    ? fallback
    : resolveDiskUploadPath(source);
  if (!diskPath) return null;
  const mime = detectMimeFromExt(diskPath);
  if (!mime) return null;
  const buffer = fs.readFileSync(diskPath);
  if (!buffer.length || buffer.length > MAX_ASSET_BYTES) return null;
  return { mime, buffer };
}

async function storeSnapshotAsset(client, schoolId, source) {
  const parsed = readImageInput(source);
  if (!parsed) return null;
  const hash = crypto.createHash('sha256').update(parsed.buffer).digest('hex');
  const q = await client.query(
    `INSERT INTO school_snapshot_assets (school_id, sha256_hash, mime_type, asset_bytes, byte_size)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (school_id, sha256_hash)
     DO UPDATE SET school_id = EXCLUDED.school_id
     RETURNING id`,
    [schoolId, hash, parsed.mime, parsed.buffer, parsed.buffer.length]
  );
  return q.rows[0]?.id || null;
}

async function loadSnapshotAssetBuffers(client, schoolId, assetIds) {
  const ids = [...new Set((assetIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const q = await client.query(
    `SELECT id, mime_type, asset_bytes
     FROM school_snapshot_assets
     WHERE school_id = $1 AND id = ANY($2::uuid[])`,
    [schoolId, ids]
  );
  const map = new Map();
  for (const row of q.rows) {
    map.set(String(row.id), row.asset_bytes);
  }
  return map;
}

function resolveRenderImage(assetMap, assetId, legacyUrl) {
  if (assetId && assetMap && assetMap.has(String(assetId))) {
    return assetMap.get(String(assetId));
  }
  if (!legacyUrl) return null;
  const parsed = readImageInput(legacyUrl);
  return parsed ? parsed.buffer : null;
}

module.exports = {
  readImageInput,
  storeSnapshotAsset,
  loadSnapshotAssetBuffers,
  resolveRenderImage
};
