const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

/**
 * Pure Node.js zero-dependency .docx extractor and table parser.
 * Handles zipped XML, table cells, and embedded passport photos.
 */
function unzipDocx(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Uploaded file is not a valid Microsoft Word (.docx) document');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  const entries = {};
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const fnLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);

    const filename = buffer.toString('utf8', pos + 46, pos + 46 + fnLen);

    const localFnLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localFnLen + localExtraLen;

    const compData = buffer.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = compData;
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(compData);
      } catch (err) {
        data = null;
      }
    } else {
      data = compData;
    }
    entries[filename] = data;

    pos += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

function parseRelationships(relsXml) {
  const map = {};
  if (!relsXml) return map;
  const relRegex = /<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"/g;
  let m;
  while ((m = relRegex.exec(relsXml)) !== null) {
    let target = m[2];
    if (!target.startsWith('word/')) {
      target = 'word/' + target.replace(/^\/+/, '');
    }
    map[m[1]] = target;
  }
  return map;
}

function parseDocxTables(documentXml, relsMap, entries) {
  if (!documentXml) return [];
  const tables = [];
  const tblRegex = /<w:tbl[\s\S]*?<\/w:tbl>/g;
  let tblMatch;

  while ((tblMatch = tblRegex.exec(documentXml)) !== null) {
    const tblXml = tblMatch[0];
    const rows = [];
    const trRegex = /<w:tr[\s\S]*?<\/w:tr>/g;
    let trMatch;

    while ((trMatch = trRegex.exec(tblXml)) !== null) {
      const trXml = trMatch[0];
      const cells = [];
      const tcRegex = /<w:tc[\s\S]*?<\/w:tc>/g;
      let tcMatch;

      while ((tcMatch = tcRegex.exec(trXml)) !== null) {
        const tcXml = tcMatch[0];
        
        const textParts = [];
        const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
        let tMatch;
        while ((tMatch = tRegex.exec(tcXml)) !== null) {
          textParts.push(tMatch[1]);
        }
        const text = textParts.join('').trim();

        let imageBuffer = null;
        let imageExt = 'jpg';
        const imgMatch = tcXml.match(/r:(?:embed|id)="([^"]+)"/);
        if (imgMatch && relsMap[imgMatch[1]]) {
          const targetPath = relsMap[imgMatch[1]];
          const buf = entries[targetPath] || entries[targetPath.replace('word/', '')];
          if (buf) {
            imageBuffer = buf;
            const extMatch = targetPath.match(/\.([a-zA-Z0-9]+)$/);
            if (extMatch) imageExt = extMatch[1].toLowerCase();
          }
        }

        cells.push({
          text,
          hasImage: Boolean(imageBuffer),
          imageBuffer,
          imageExt
        });
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function splitThreeNames(fullName) {
  if (!fullName) return { first: 'Learner', middle: '', last: '' };
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { first: parts[0], middle: '', last: parts[0] };
  if (parts.length === 2) return { first: parts[0], middle: '', last: parts[1] };
  const first = parts[0];
  const middle = parts.slice(1, -1).join(' ');
  const last = parts[parts.length - 1];
  return { first, middle, last };
}

function normalizeKenyanPhone(p) {
  if (!p) return null;
  let digits = String(p).replace(/[^0-9]/g, '');
  if (digits.startsWith('0') && digits.length === 10) return '+254' + digits.slice(1);
  if (digits.startsWith('254') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('7') && digits.length === 9) return '+254' + digits;
  if (digits.startsWith('1') && digits.length === 9) return '+254' + digits;
  return digits.length >= 9 ? '+' + digits : p;
}

function normalizePathway(str, isSenior) {
  if (!str) return isSenior ? 'STEM' : 'EXPLORATORY';
  const s = String(str).toUpperCase();
  if (s.includes('STEM') || s.includes('SCIENCE') || s.includes('TECH') || s.includes('ENGINEER') || s.includes('MATH')) return 'STEM';
  if (s.includes('SOCIAL') || s.includes('HUMANIT') || s.includes('BUSINESS') || s.includes('LANG')) return 'SOCIAL_SCIENCES';
  if (s.includes('ART') || s.includes('SPORT') || s.includes('MUSIC') || s.includes('DRAMA')) return 'ARTS_SPORTS';
  return isSenior ? 'STEM' : 'EXPLORATORY';
}

function normalizeGender(g) {
  if (!g) return null;
  const s = String(g).trim().toUpperCase();
  if (s.startsWith('M')) return 'MALE';
  if (s.startsWith('F')) return 'FEMALE';
  return null;
}

function parseDateOfBirth(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3];
    return `${year}-${month}-${day}`;
  }
  return null;
}

function extractLearnersFromDocx(docxBuffer, isSeniorSchool = false) {
  const entries = unzipDocx(docxBuffer);
  const docXml = entries['word/document.xml'] ? entries['word/document.xml'].toString('utf8') : null;
  const relsXml = entries['word/_rels/document.xml.rels'] ? entries['word/_rels/document.xml.rels'].toString('utf8') : null;

  if (!docXml) throw new Error('Could not find word/document.xml in uploaded file');

  const relsMap = parseRelationships(relsXml);
  const tables = parseDocxTables(docXml, relsMap, entries);

  if (!tables.length) {
    throw new Error('No tables found in this Word document. Please ensure learners are organized in a table.');
  }

  const table = tables.slice().sort((a, b) => b.length - a.length)[0];
  if (table.length < 2) {
    throw new Error('The table has fewer than 2 rows (needs header row + learner rows).');
  }

  const headerRow = table[0].map(c => c.text.toLowerCase());
  
  let photoCol = table[0].findIndex((c, i) => c.hasImage || /photo|passport|picture|image/i.test(c.text));
  if (photoCol === -1 && table[1] && table[1][0]?.hasImage) photoCol = 0;

  let assNoCol = headerRow.findIndex(h => /ass.*no|upi|nemis|index|assessment/i.test(h));
  let admNoCol = headerRow.findIndex(h => /adm.*no|admission|reg.*no/i.test(h));
  let nameCol = headerRow.findIndex(h => /name|learner|student/i.test(h) && !/parent|guardian|father|mother/i.test(h));
  let dobCol = headerRow.findIndex(h => /dob|birth|date of birth/i.test(h));
  let genderCol = headerRow.findIndex(h => /gender|sex/i.test(h));
  let pathwayCol = headerRow.findIndex(h => /pathway|track|stream|interest|career/i.test(h));
  let parentCol = headerRow.findIndex(h => /parent|guardian|father|mother/i.test(h));
  let phoneCol = headerRow.findIndex(h => /phone|mobile|contact|tel/i.test(h));

  if (admNoCol === -1) admNoCol = photoCol === 0 ? 1 : 0;
  if (assNoCol === -1) assNoCol = photoCol === 0 ? 2 : 1;
  if (nameCol === -1) nameCol = photoCol === 0 ? 3 : 2;

  const learners = [];

  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    const rowText = row.map(c => c.text).join('').trim();
    if (!rowText && !row.some(c => c.hasImage)) continue;

    let photoBuffer = null;
    let photoExt = 'jpg';
    if (photoCol !== -1 && row[photoCol]?.hasImage) {
      photoBuffer = row[photoCol].imageBuffer;
      photoExt = row[photoCol].imageExt;
    } else {
      const imgCell = row.find(c => c.hasImage);
      if (imgCell) {
        photoBuffer = imgCell.imageBuffer;
        photoExt = imgCell.imageExt;
      }
    }

    const admNo = admNoCol !== -1 && row[admNoCol] ? row[admNoCol].text.trim() : `AUTO-${r}`;
    const assNo = assNoCol !== -1 && row[assNoCol] ? row[assNoCol].text.trim() : null;
    const rawName = nameCol !== -1 && row[nameCol] ? row[nameCol].text.trim() : `Learner ${r}`;
    const { first, middle, last } = splitThreeNames(rawName);

    const dob = dobCol !== -1 && row[dobCol] ? parseDateOfBirth(row[dobCol].text) : null;
    const gender = genderCol !== -1 && row[genderCol] ? normalizeGender(row[genderCol].text) : null;
    const rawPathway = pathwayCol !== -1 && row[pathwayCol] ? row[pathwayCol].text.trim() : '';
    const pathway = normalizePathway(rawPathway, isSeniorSchool);

    const parentName = parentCol !== -1 && row[parentCol] ? row[parentCol].text.trim() : null;
    const parentPhone = phoneCol !== -1 && row[phoneCol] ? normalizeKenyanPhone(row[phoneCol].text) : null;

    if (!admNo && !rawName) continue;

    learners.push({
      row_index: r,
      admission_no: admNo,
      assessment_no: assNo,
      raw_name: rawName,
      first_name: first,
      middle_name: middle,
      last_name: last,
      date_of_birth: dob,
      gender,
      cbc_pathway: pathway,
      pathway_track: rawPathway || (pathway === 'STEM' ? 'Pure Sciences' : 'General'),
      parent_name: parentName,
      parent_phone: parentPhone,
      has_photo: Boolean(photoBuffer),
      photo_buffer: photoBuffer,
      photo_ext: photoExt,
      photo_thumbnail: photoBuffer ? `data:image/${photoExt};base64,${photoBuffer.toString('base64')}` : null
    });
  }

  return {
    total_found: learners.length,
    photos_matched: learners.filter(l => l.has_photo).length,
    learners
  };
}

module.exports = {
  extractLearnersFromDocx,
  unzipDocx,
  splitThreeNames,
  normalizeKenyanPhone,
  normalizePathway
};
