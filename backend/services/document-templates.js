'use strict';

const CERTIFICATE_TEMPLATES = [
  { id: 'classic', name: 'Classic Certificate', description: 'Traditional bordered school certificate with gold corners.' },
  { id: 'modern', name: 'Modern Certificate', description: 'Clean side-banded academic certificate.' },
  { id: 'academic', name: 'Academic Honor', description: 'Formal academic achievement layout.' },
  { id: 'subject-champion', name: 'Subject Champion', description: 'Top subject award with ribbon seal.' },
  { id: 'most-improved', name: 'Most Improved', description: 'Growth and academic progress award.' },
  { id: 'sports-achievement', name: 'Sports Achievement', description: 'Athletics and co-curricular trophy layout.' },
  { id: 'participation', name: 'Participation Award', description: 'Balanced co-curricular participation design.' }
];

const ID_CARD_TEMPLATES = [
  { id: 'classic', name: 'Classic CR80', description: 'Formal navy/school-branded ID card with gold footer bar.' },
  { id: 'modern', name: 'Modern CR80', description: 'Split accent stripe CR80 ID card.' },
  { id: 'academic', name: 'Academic CR80', description: 'Academic crest-inspired CR80 ID card.' }
];

const CERTIFICATE_CATEGORIES = [
  { id: 'ACADEMIC_ACHIEVEMENT', label: 'Academic Achievement' },
  { id: 'SUBJECT_PERFORMANCE', label: 'Subject Performance' },
  { id: 'MOST_IMPROVED', label: 'Most Improved' },
  { id: 'COMPLETION', label: 'Completion' },
  { id: 'CO_CURRICULAR', label: 'Co-Curricular' },
  { id: 'SPORTS', label: 'Sports' },
  { id: 'SCHOOL_RECOGNITION', label: 'School Recognition' }
];

const EXTENDED_CERTIFICATE_CATEGORIES = [
  ...CERTIFICATE_CATEGORIES,
  { id: 'SCHOOL_LEAVING', label: 'School Leaving' },
  { id: 'LEADERSHIP', label: 'Leadership' },
  { id: 'CONDUCT', label: 'Good Conduct' }
];

function documentTemplates(type) {
  return type === 'ID_CARD' ? ID_CARD_TEMPLATES : CERTIFICATE_TEMPLATES;
}

function documentTemplate(id, type) {
  const list = documentTemplates(type);
  const raw = String(id || '').trim();
  if (!raw) return list[0].id;
  const found = list.find(t => t.id === raw);
  return found ? found.id : null;
}

function validDocumentCategory(id, extraCodes = null) {
  const code = String(id || '').trim().toUpperCase();
  if (!code) return false;
  if (EXTENDED_CERTIFICATE_CATEGORIES.some(c => c.id === code)) return true;
  if (extraCodes && extraCodes.has(code)) return true;
  return false;
}

function getCertificateTemplate(id) {
  return CERTIFICATE_TEMPLATES.find(t => t.id === id) || CERTIFICATE_TEMPLATES[0];
}

function getIdCardTemplate(id) {
  return ID_CARD_TEMPLATES.find(t => t.id === id) || ID_CARD_TEMPLATES[0];
}

function getCertificateCategory(id) {
  return EXTENDED_CERTIFICATE_CATEGORIES.find(c => c.id === id) || CERTIFICATE_CATEGORIES[0];
}

function renderCustomStatement(template, vars = {}) {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key) => {
    const k = String(key).toLowerCase();
    return vars[k] != null ? String(vars[k]) : '';
  }).trim();
}

module.exports = {
  CERTIFICATE_TEMPLATES,
  ID_CARD_TEMPLATES,
  CERTIFICATE_CATEGORIES,
  EXTENDED_CERTIFICATE_CATEGORIES,
  documentTemplates,
  documentTemplate,
  validDocumentCategory,
  getCertificateTemplate,
  getIdCardTemplate,
  getCertificateCategory,
  renderCustomStatement
};
