'use strict';

const PDFDocument = require('pdfkit');
const { source: assetSource } = require('./assets');

const text = value => (value == null ? '' : String(value));
const hex = (value, fallback) => (/^#[0-9A-F]{6}$/i.test(String(value || '')) ? String(value) : fallback);
const round1 = value => (value == null || !isFinite(Number(value)) ? '—' : String(Math.round(Number(value) * 10) / 10));

function gradeFill(grade) {
  const key = String(grade || '').toUpperCase();
  if (key === 'A' || key === 'EE') return '#E7F5EC';
  if (key === 'B' || key === 'ME') return '#E8F0FA';
  if (key === 'C' || key === 'AE') return '#FCF3DC';
  if (key === 'D' || key === 'BE') return '#FBE9E7';
  return '#F4F6F9';
}

function drawImage(doc, url, x, y, fit) {
  const p = assetSource(url);
  if (!p) return false;
  try { doc.image(p, x, y, { fit, align: 'center', valign: 'center' }); return true; } catch (e) { return false; }
}

/* Official Zeraki-style merit document: branded letterhead, ruled register,
   subject summary, certification strip (signatures + stamp) and paginated footer. */
async function buildMeritPdf(merit, meta) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 20, autoFirstPage: false, bufferPages: true });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });

  const m = meta || {};
  const navy = hex(m.primary_color, '#17365D');
  const gold = String(m.secondary_color || '').toUpperCase() === '#D9A441' ? '#B8860B' : hex(m.secondary_color, '#B8860B');
  const ink = '#1B2430';
  const muted = '#5B6675';
  const grid = '#D8DEE6';
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 28;
  const tableWidth = pageWidth - margin * 2;
  const footerTop = pageHeight - 40;
  const contentBottom = footerTop - 10;
  const subjects = merit.subjects || [];
  const rows = merit.rows || [];
  const stats = merit.stats || {};
  const context = merit.context || {};
  const multiClass = !context.class_id;
  const generated = new Date();
  const refNo = 'ZC/MERIT/' + generated.getFullYear() + '/' +
    String(generated.getMonth() + 1).padStart(2, '0') + '-' +
    String(generated.getDate()).padStart(2, '0') + '/' +
    generated.getTime().toString(36).toUpperCase().slice(-5);

  const fixed = [26, 46, 148];
  if (multiClass) fixed.push(64);
  const tail = [40, 42, 34, 40, 44];
  const fixedSum = fixed.reduce((a, b) => a + b, 0);
  const tailSum = tail.reduce((a, b) => a + b, 0);
  const subjectWidth = subjects.length ? Math.max(24, (tableWidth - fixedSum - tailSum) / subjects.length) : 0;
  const widths = [...fixed, ...subjects.map(() => subjectWidth), ...tail];
  const rowHeight = 19;
  const headerHeight = 24;
  let y = 0;

  const watermark = () => {
    if (m.watermark_enabled === false) return;
    const p = assetSource(m.logo_url);
    if (p) {
      try {
        doc.save().opacity(0.05);
        doc.image(p, pageWidth / 2 - 110, pageHeight / 2 - 110, { fit: [220, 220], align: 'center', valign: 'center' });
        doc.restore();
        return;
      } catch (e) { try { doc.restore(); } catch (e2) {} }
    }
    try {
      doc.save().opacity(0.04).fillColor('#334155').font('Helvetica-Bold').fontSize(30)
        .text(text(m.school_name), margin, pageHeight / 2 - 18, { width: tableWidth, align: 'center', lineBreak: false, ellipsis: true });
      doc.restore();
    } catch (e) { try { doc.restore(); } catch (e2) {} }
  };

  const letterhead = continuation => {
    watermark();
    const hasLogo = drawImage(doc, m.logo_url, margin, 26, [50, 50]);
    const tx = margin + (hasLogo ? 60 : 0);
    const tw = tableWidth - (hasLogo ? 60 : 0) - 190;
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(15)
      .text(text(m.school_name || 'School'), tx, 28, { width: tw, lineBreak: false, ellipsis: true });
    doc.fillColor(gold).font('Helvetica-Oblique').fontSize(8)
      .text(text(m.motto || 'Discipline · Knowledge · Greater Futures'), tx, 46, { width: tw, lineBreak: false, ellipsis: true });
    const contact = [m.address, m.contact_phone, m.contact_email].filter(Boolean).join('  ·  ');
    if (contact) {
      doc.fillColor(muted).font('Helvetica').fontSize(6.5)
        .text(contact, tx, 58, { width: tw, lineBreak: false, ellipsis: true });
    }
    doc.strokeColor(navy).lineWidth(0.8).roundedRect(margin + tableWidth - 182, 26, 182, 50, 3).stroke();
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(6.5)
      .text('OFFICIAL MERIT DOCUMENT', margin + tableWidth - 176, 31, { width: 170, lineBreak: false });
    doc.fillColor(muted).font('Helvetica').fontSize(6)
      .text('REF: ' + refNo, margin + tableWidth - 176, 41, { width: 170, lineBreak: false, ellipsis: true })
      .text('Generated: ' + generated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC', margin + tableWidth - 176, 50, { width: 170, lineBreak: false, ellipsis: true })
      .text('Basis: ' + text(context.assessment_label || 'All assessments in term score'), margin + tableWidth - 176, 59, { width: 170, lineBreak: false, ellipsis: true });
    doc.moveTo(margin, 84).lineTo(margin + tableWidth, 84).strokeColor(navy).lineWidth(1.6).stroke();
    doc.moveTo(margin, 87).lineTo(margin + tableWidth, 87).strokeColor(gold).lineWidth(0.8).stroke();
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(12)
      .text(continuation ? 'MERIT LIST · CONTINUED' : 'MERIT LIST', margin, 94, { width: tableWidth / 2 });
    const bits = [context.year_label, context.term_name, context.class_name || 'All classes',
      context.year_state === 'HISTORICAL' ? 'HISTORICAL YEAR' : null].filter(Boolean).join('   ·   ');
    doc.fillColor(muted).font('Helvetica').fontSize(7.5)
      .text(bits, margin + tableWidth / 2, 97, { width: tableWidth / 2, align: 'right', lineBreak: false, ellipsis: true });
    y = 112;
  };

  const tableHead = () => {
    let x = margin;
    doc.fillColor(navy).rect(margin, y, tableWidth, headerHeight).fill();
    const heads = ['#', 'ADM. NO.', 'LEARNER', ...(multiClass ? ['CLASS'] : []),
      ...subjects.map(s => String(s.subject_code || s.subject_name || '').toUpperCase()),
      'TOTAL', 'AVERAGE', 'GRADE', 'CLASS POS.', 'OVERALL POS.'];
    heads.forEach((label, index) => {
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(index < fixed.length ? 6.3 : 5.4)
        .text(label, x + 2, y + 8, { width: widths[index] - 4, align: index < fixed.length ? 'left' : 'center', lineBreak: false, ellipsis: true });
      x += widths[index];
    });
    y += headerHeight;
  };

  const ruleRow = (top, height) => {
    doc.strokeColor(grid).lineWidth(0.5).rect(margin, top, tableWidth, height).stroke();
    let gx = margin;
    widths.forEach(w => {
      gx += w;
      if (gx < margin + tableWidth - 0.1) doc.moveTo(gx, top).lineTo(gx, top + height).stroke();
    });
  };

  letterhead(false);
  tableHead();

  rows.forEach((row, index) => {
    if (y + rowHeight > contentBottom) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
      letterhead(true);
      tableHead();
    }
    const rank = row.stream_rank != null ? row.stream_rank : (row.average == null ? null : index + 1);
    const topThree = rank != null && Number(rank) > 0 && Number(rank) <= 3;
    if (topThree) doc.fillColor('#FFF8E6').rect(margin, y, tableWidth, rowHeight).fill();
    else if (index % 2 === 0) doc.fillColor('#FAFBFC').rect(margin, y, tableWidth, rowHeight).fill();
    ruleRow(y, rowHeight);
    const bySubject = new Map((row.subjects || []).map(s => [String(s.subject_id), s]));
    const core = [rank == null ? '—' : String(rank), text(row.admission_no || row.assessment_no), text(row.name), ...(multiClass ? [text(row.class_name)] : [])];
    let x = margin;
    core.forEach((value, cellIndex) => {
      const isName = cellIndex === 2;
      const isRank = cellIndex === 0;
      doc.fillColor(isRank && topThree ? gold : ink)
        .font(isName || isRank ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.6)
        .text(value, x + 3, y + 6, { width: widths[cellIndex] - 6, lineBreak: false, ellipsis: true });
      x += widths[cellIndex];
    });
    subjects.forEach(subject => {
      const found = bySubject.get(String(subject.subject_id));
      const value = found && found.average != null ? String(Math.round(found.average)) : '—';
      doc.fillColor(ink).font('Helvetica').fontSize(6.4)
        .text(value, x, y + 6, { width: subjectWidth, align: 'center', lineBreak: false });
      x += subjectWidth;
    });
    const tailValues = [
      row.total == null ? '—' : String(Math.round(row.total)),
      round1(row.average),
      text(row.grade),
      row.stream_rank == null ? '—' : String(row.stream_rank),
      row.overall_rank == null ? '—' : String(row.overall_rank)
    ];
    tailValues.forEach((value, i) => {
      const w = widths[fixed.length + subjects.length + i];
      if (i === 2) doc.fillColor(gradeFill(value)).rect(x + 1, y + 2, w - 2, rowHeight - 4).fill();
      doc.fillColor(ink).font('Helvetica-Bold').fontSize(6.4)
        .text(value, x, y + 6, { width: w, align: 'center', lineBreak: false });
      x += w;
    });
    y += rowHeight;
  });

  if (!rows.length) {
    doc.fillColor('#991B1B').font('Helvetica-Bold').fontSize(8)
      .text('No usable marks were found for this selection.', margin, y + 10, { width: tableWidth });
    if (merit.diagnostics) {
      doc.fillColor(ink).font('Helvetica').fontSize(7.5)
        .text(merit.diagnostics, margin, y + 26, { width: tableWidth });
    }
    y += 60;
  }

  const statBand = () => {
    const items = [
      ['MEAN SCORE', round1(stats.mean)],
      ['TOP SCORE', round1(stats.top)],
      ['LOWEST SCORE', round1(stats.lowest)],
      ['PASS RATE', stats.pass_rate == null ? '—' : Math.round(Number(stats.pass_rate)) + '%'],
      ['RANKED LEARNERS', String(stats.ranked == null ? rows.length : stats.ranked) + ' / ' + String(stats.learners == null ? rows.length : stats.learners)]
    ];
    const h = 30;
    if (y + h + 14 > contentBottom) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
      letterhead(true);
    }
    y += 10;
    const w = tableWidth / items.length;
    items.forEach((item, i) => {
      const x = margin + i * w;
      doc.fillColor('#F4F6F9').rect(x, y, w - 4, h).fill();
      doc.strokeColor(grid).lineWidth(0.5).rect(x, y, w - 4, h).stroke();
      doc.fillColor(muted).font('Helvetica-Bold').fontSize(5.6)
        .text(item[0], x + 6, y + 5, { width: w - 12, lineBreak: false });
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(10)
        .text(item[1], x + 6, y + 14, { width: w - 12, lineBreak: false });
    });
    y += h + 12;
  };
  if (rows.length) statBand();

  if (merit.subject_rankings && merit.subject_rankings.length) {
    const sWidths = [34, 220, 64, 46, tableWidth - 34 - 220 - 64 - 46];
    const needed = 30 + merit.subject_rankings.length * 15 + 10;
    if (y + needed > contentBottom) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
      letterhead(true);
    }
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(8.5)
      .text('SUBJECT AVERAGES · CLASS RANKING · SUBJECT TEACHERS', margin, y, { width: tableWidth });
    y += 14;
    let sx = margin;
    doc.fillColor(navy).rect(margin, y, tableWidth, 16).fill();
    ['RANK', 'SUBJECT / LEARNING AREA', 'AVERAGE', 'GRADE', 'SUBJECT TEACHER'].forEach((label, i) => {
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(6)
        .text(label, sx + 3, y + 5, { width: sWidths[i] - 6, lineBreak: false });
      sx += sWidths[i];
    });
    y += 16;
    merit.subject_rankings.forEach((subject, index) => {
      if (y + 15 > contentBottom) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
        letterhead(true);
        doc.fillColor(navy).font('Helvetica-Bold').fontSize(8)
          .text('SUBJECT AVERAGES · CONTINUED', margin, y, { width: tableWidth });
        y += 14;
      }
      if (index % 2 === 0) doc.fillColor('#FAFBFC').rect(margin, y, tableWidth, 15).fill();
      doc.strokeColor(grid).lineWidth(0.5).rect(margin, y, tableWidth, 15).stroke();
      let gx = margin;
      sWidths.forEach(w => { gx += w; if (gx < margin + tableWidth - 0.1) doc.moveTo(gx, y).lineTo(gx, y + 15).stroke(); });
      const values = [String(index + 1), text(subject.subject_name), round1(subject.average), text(subject.grade), text(subject.teacher || subject.teacher_name || 'Not assigned')];
      let cellX = margin;
      values.forEach((value, column) => {
        doc.fillColor(ink).font(column === 1 || column === 4 ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.2)
          .text(value, cellX + 3, y + 4, { width: sWidths[column] - 6, lineBreak: false, ellipsis: true });
        cellX += sWidths[column];
      });
      y += 15;
    });
    y += 8;
  }

  const certification = () => {
    const h = 64;
    if (y + h > contentBottom) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
      letterhead(true);
    }
    y += 6;
    const colW = (tableWidth - 150) / 2;
    const ct = m.class_teacher || {};
    const ht = m.head_teacher || {};
    const sig = (url, x) => {
      const p = assetSource(url);
      if (p) { try { doc.image(p, x + 12, y + 16, { fit: [110, 24] }); return; } catch (e) {} }
    };
    doc.strokeColor(ink).lineWidth(0.7);
    doc.moveTo(margin + 8, y + 42).lineTo(margin + colW - 8, y + 42).stroke();
    doc.moveTo(margin + colW + 8, y + 42).lineTo(margin + 2 * colW - 8, y + 42).stroke();
    sig(ct.signature_url, margin);
    sig(ht.signature_url, margin + colW);
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(6.6)
      .text('CLASS TEACHER: ' + text(ct.name || '____________________'), margin + 8, y + 46, { width: colW - 16, lineBreak: false, ellipsis: true })
      .text('HEAD TEACHER: ' + text(ht.name || '____________________'), margin + colW + 8, y + 46, { width: colW - 16, lineBreak: false, ellipsis: true });
    doc.fillColor(muted).font('Helvetica').fontSize(5.8)
      .text('Signature & date', margin + 8, y + 55, { width: colW - 16 })
      .text('Signature & date', margin + colW + 8, y + 55, { width: colW - 16 });
    const sx = margin + 2 * colW;
    doc.strokeColor(navy).lineWidth(0.8).roundedRect(sx, y, 150, h - 6, 3).stroke();
    doc.fillColor(muted).font('Helvetica-Bold').fontSize(5.8)
      .text('OFFICIAL SCHOOL STAMP', sx, y + 4, { width: 150, align: 'center', lineBreak: false });
    if (!drawImage(doc, m.stamp_url, sx + 45, y + 12, [60, 38])) {
      doc.fillColor('#9AA5B1').font('Helvetica').fontSize(6)
        .text('Stamp applied on issue', sx, y + 28, { width: 150, align: 'center', lineBreak: false });
    }
    y += h;
  };
  certification();

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.strokeColor(grid).lineWidth(0.7).moveTo(margin, footerTop).lineTo(margin + tableWidth, footerTop).stroke();
    doc.fillColor(muted).font('Helvetica').fontSize(6)
      .text(text(m.school_name) + ' · ' + text(m.contact_email || 'School contact email') + ' · REF ' + refNo,
        margin, footerTop + 6, { width: tableWidth * 0.62, lineBreak: false, ellipsis: true });
    doc.fillColor(muted).font('Helvetica').fontSize(6)
      .text('Generated by PRO-MARK · ZELIMU CBC — verify against the school register',
        margin + tableWidth * 0.62, footerTop + 6, { width: tableWidth * 0.24, align: 'center', lineBreak: false, ellipsis: true });
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(6)
      .text('Page ' + (i - range.start + 1) + ' of ' + range.count, margin + tableWidth * 0.86, footerTop + 6, { width: tableWidth * 0.14, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;
}

module.exports = { buildMeritPdf };