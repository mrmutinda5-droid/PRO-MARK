(function (root, factory) {
  const parser = factory();
  if (typeof module === 'object' && module.exports) module.exports = parser;
  if (root) root.ZelimuLearnerImportParser = parser;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function parseTable(text) {
    const source = String(text || '').replace(/\r\n?/g, '\n');
    let delimiter = '\t';
    let bestCount = -1;
    let quoted = false;
    let firstLine = '';

    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (char === '"') {
        if (quoted && source[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (char === '\n' && !quoted) {
        firstLine = source.slice(0, i);
        break;
      }
    }
    if (!firstLine) firstLine = source;

    for (const candidate of ['\t', ',', ';', '|']) {
      let count = 0;
      quoted = false;
      for (let i = 0; i < firstLine.length; i++) {
        const char = firstLine[i];
        if (char === '"') {
          if (quoted && firstLine[i + 1] === '"') i++;
          else quoted = !quoted;
        } else if (char === candidate && !quoted) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        delimiter = candidate;
      }
    }

    const records = [];
    let cells = [];
    let cell = '';
    quoted = false;
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (char === '"') {
        if (quoted && source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (char === delimiter && !quoted) {
        cells.push(cell.trim());
        cell = '';
      } else if (char === '\n' && !quoted) {
        cells.push(cell.trim());
        if (cells.some(value => value !== '')) records.push(cells);
        cells = [];
        cell = '';
      } else {
        cell += char;
      }
    }
    cells.push(cell.trim());
    if (cells.some(value => value !== '')) records.push(cells);
    return records;
  }

  function mapHeader(header) {
    const value = norm(header);
    if (/photo|passport|image|avatar/.test(value)) return 'passport_photo_url';
    if (/assessment|assesno|^assno$|^assessno$|^upi$|^nemis$/.test(value)) return 'assessment_no';
    if (/admission|^admno$|^admnumber$|^adm$/.test(value)) return 'admission_no';
    if (/fullname|learnername|studentname/.test(value) || value === 'name' || value === 'learner') return 'full_name';
    if (/firstname|^fname$/.test(value) || value === 'first') return 'first_name';
    if (/middlename|^mname$/.test(value) || value === 'middle') return 'middle_name';
    if (/lastname|surname|familyname/.test(value) || value === 'last') return 'last_name';
    if (/dateofbirth|^dob$|^birthdate$|^birth$/.test(value)) return 'date_of_birth';
    if (value === 'gender' || value === 'sex') return 'gender';
    if (/pathway|track|specialisation/.test(value)) return 'cbc_pathway';
    if (/parentname|guardianname/.test(value) || value === 'parent' || value === 'guardian') return 'parent_name';
    if (/phone|mobile|guardiancontact|parentcontact/.test(value)) return 'parent_phone';
    if (value === 'class' || value === 'classname' || value === 'grade') return 'ignored_class';
    return null;
  }

  function parseName(value) {
    const parts = String(value || '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return {};
    return {
      first_name: parts[0],
      middle_name: parts.length > 2 ? parts.slice(1, -1).join(' ') : '',
      last_name: parts[parts.length - 1]
    };
  }

  function normalizeDate(value) {
    const date = String(value || '').trim();
    let parts;
    if ((parts = date.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
      return `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
    }
    if ((parts = date.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
      return `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    }
    return date;
  }

  function isPhoto(value) {
    return /^(https?:\/\/|\/uploads\/)|\.(png|jpe?g|webp)(?:\?.*)?$/i.test(value);
  }

  function isPhone(value) {
    const phone = String(value || '').replace(/[\s()-]/g, '');
    return /^(?:0[17]\d{8,9}|\+\d{9,15})$/.test(phone);
  }

  function parseLearnerPaste(text) {
    const table = parseTable(text);
    if (!table.length) return { rows: [], errors: [] };
    const headerKeys = table[0].map(mapHeader);
    const hasHeader = headerKeys.includes('full_name') ||
      (headerKeys.includes('first_name') && headerKeys.includes('last_name')) ||
      (headerKeys.includes('first_name') && headerKeys.some(Boolean));
    const data = hasHeader ? table.slice(1) : table;
    const keys = hasHeader ? headerKeys : [];
    const rows = [];
    const errors = [];

    data.forEach((cells, index) => {
      const rowNumber = index + (hasHeader ? 2 : 1);
      const row = {};

      if (hasHeader) {
        keys.forEach((key, cellIndex) => {
          if (key && key !== 'ignored_class' && cells[cellIndex]) row[key] = cells[cellIndex];
        });
      } else {
        const photoIndex = cells.findIndex(isPhoto);
        const hasPhotoColumn = photoIndex === 0 || cells.length >= 9;
        const expectedNameIndex = hasPhotoColumn ? 3 : (cells.length >= 8 ? 2 : 1);
        const nameCandidate = cells[expectedNameIndex] || cells.find(value =>
          /\p{L}/u.test(value) && /\s/.test(value) && !isPhoto(value)
        ) || '';
        const name = parseName(nameCandidate);
        Object.assign(row, name);

        if (photoIndex >= 0) row.passport_photo_url = cells[photoIndex];
        const identifiers = cells.filter((value, cellIndex) =>
          value && cellIndex !== photoIndex && /^\d+$/.test(value)
        );
        if (hasPhotoColumn) {
          row.assessment_no = cells[1] || '';
          row.admission_no = cells[2] || '';
        } else if (cells.length >= 8) {
          row.assessment_no = cells[0] || '';
          row.admission_no = cells[1] || '';
        } else {
          row.admission_no = cells[0] || '';
        }
        if (hasPhotoColumn && cells[7]) row.parent_name = cells[7];
        else if (cells.length >= 8 && cells[6]) row.parent_name = cells[6];
        else if (cells.length === 7 && cells[5]) row.parent_name = cells[5];
        if (!row.assessment_no && identifiers.length > 1) row.assessment_no = identifiers[1];
        if (!row.admission_no && identifiers.length) row.admission_no = identifiers[0];
      }

      for (const value of cells) {
        if (!value) continue;
        if (!row.passport_photo_url && isPhoto(value)) row.passport_photo_url = value;
        if (!row.parent_phone && isPhone(value)) row.parent_phone = value;
        if (!row.gender && /^(male|female|m|f)$/i.test(value)) {
          row.gender = /^m/i.test(value) ? 'Male' : 'Female';
        }
        if (!row.date_of_birth && /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(value)) {
          row.date_of_birth = normalizeDate(value);
        }
        if (!row.cbc_pathway && /^(stem|social\s*sciences?|arts?\s*(?:&|and)\s*sports?|exploratory)/i.test(value)) {
          row.cbc_pathway = value;
        }
      }

      if (row.full_name) {
        const name = parseName(row.full_name);
        row.first_name = row.first_name || name.first_name;
        row.middle_name = row.middle_name || name.middle_name;
        row.last_name = row.last_name || name.last_name;
      }
      if (row.gender && /^(male|female|m|f)$/i.test(row.gender)) {
        row.gender = /^m/i.test(row.gender) ? 'Male' : 'Female';
      }
      if (row.date_of_birth) row.date_of_birth = normalizeDate(row.date_of_birth);
      if (!row.first_name || !row.last_name) {
        errors.push(`Row ${rowNumber}: could not identify both learner first and last names.`);
        return;
      }
      rows.push(row);
    });

    return { rows, errors };
  }

  return { parseLearnerPaste };
});
