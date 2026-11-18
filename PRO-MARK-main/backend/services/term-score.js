'use strict';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function averageOf(values) {
  const usable = (values || []).map(finite).filter(v => v !== null);
  return usable.length
    ? usable.reduce((sum, value) => sum + value, 0) / usable.length
    : null;
}

function normalizeLabel(value) {
  return String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, ' ');
}

function isCatAssessment(assessment) {
  const type = normalizeLabel(assessment && assessment.assessment_type);
  const name = normalizeLabel(assessment && assessment.name);
  return type.startsWith('CAT') || /\bCAT\b|CONTINUOUS|ASSESSMENT TEST/.test(name);
}

function assessmentKey(assessment) {
  const name = normalizeLabel(assessment && assessment.name);
  return `${isCatAssessment(assessment) ? 'CAT' : 'EXAM'}:${name}`;
}

function assessmentOrder(assessment) {
  const order = finite(assessment && assessment.assessment_order);
  return order === null ? Number.MAX_SAFE_INTEGER : order;
}

function classMatches(assessment, classId) {
  if (!assessment || assessment.class_id == null || classId == null) return true;
  return String(assessment.class_id) === String(classId);
}

function columnRowScore(assessment, classId) {
  let score = 0;
  if (assessment.class_id != null && classId != null &&
      String(assessment.class_id) === String(classId)) score += 8;
  if (Number(assessment.mark_count || 0) > 0) score += 4;
  if (assessment.subject_id == null) score += 1;
  return score;
}

function compareColumnRows(a, b, classId) {
  return columnRowScore(b, classId) - columnRowScore(a, classId)
    || assessmentOrder(a) - assessmentOrder(b)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || String(a.id || '').localeCompare(String(b.id || ''));
}

function buildExamColumns(assessments, classId) {
  const groups = new Map();
  for (const assessment of assessments || []) {
    if (!classMatches(assessment, classId)) continue;
    const name = normalizeLabel(assessment.name);
    if (!name) continue;
    const key = assessmentKey(assessment);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(assessment);
  }
  const columns = [];
  for (const [key, rows] of groups) {
    const ordered = rows.slice().sort((a, b) => compareColumnRows(a, b, classId));
    const representative = ordered[0];
    const minOrder = rows.reduce(
      (min, row) => Math.min(min, assessmentOrder(row)),
      Number.MAX_SAFE_INTEGER
    );
    columns.push({
      key,
      name: String(representative.name || '').trim(),
      type: normalizeLabel(representative.assessment_type) ||
        (isCatAssessment(representative) ? 'CAT' : 'EXAM'),
      cat: isCatAssessment(representative),
      assessment_order: minOrder,
      max_mark: finite(representative.max_mark) ?? 100,
      weight: finite(representative.weight) ?? 0,
      ids: rows.map(row => String(row.id))
    });
  }
  return columns.sort((a, b) =>
    a.assessment_order - b.assessment_order ||
    Number(a.cat) - Number(b.cat) ||
    a.name.localeCompare(b.name)
  );
}

function buildAssessmentIndex(assessments, classId) {
  const index = new Map();
  for (const assessment of assessments || []) {
    if (!classMatches(assessment, classId)) continue;
    const key = assessmentKey(assessment);
    if (!index.has(key)) index.set(key, { bySubject: new Map(), classwide: [] });
    const bucket = index.get(key);
    if (assessment.subject_id == null) bucket.classwide.push(assessment);
    else {
      const subjectId = String(assessment.subject_id);
      if (!bucket.bySubject.has(subjectId)) bucket.bySubject.set(subjectId, []);
      bucket.bySubject.get(subjectId).push(assessment);
    }
  }
  return index;
}

function markTime(mark) {
  return Date.parse(mark && (mark.updated_at || mark.created_at) || '') || 0;
}

function candidateScore(assessment, classId, subjectId, marksById) {
  let score = 0;
  if (marksById.has(String(assessment.id))) score += 16;
  if (assessment.class_id != null && classId != null &&
      String(assessment.class_id) === String(classId)) score += 8;
  if (assessment.subject_id != null && subjectId != null &&
      String(assessment.subject_id) === String(subjectId)) score += 4;
  if (Number(assessment.mark_count || 0) > 0) score += 2;
  return score;
}

function subjectEntries(marks, assessments, classId, subjectId, columns, index) {
  const columnList = columns || buildExamColumns(assessments, classId);
  const assessmentIndex = index || buildAssessmentIndex(assessments, classId);
  const marksById = new Map();
  for (const mark of marks || []) {
    if (subjectId != null && String(mark.subject_id) !== String(subjectId)) continue;
    const id = String(mark.assessment_id);
    const current = marksById.get(id);
    if (!current || markTime(mark) >= markTime(current)) marksById.set(id, mark);
  }
  return columnList.map(column => {
    const bucket = assessmentIndex.get(column.key);
    const candidates = bucket
      ? [
          ...(bucket.bySubject.get(String(subjectId)) || []),
          ...bucket.classwide
        ]
      : [];
    candidates.sort((a, b) =>
      candidateScore(b, classId, subjectId, marksById) -
        candidateScore(a, classId, subjectId, marksById) ||
      assessmentOrder(a) - assessmentOrder(b) ||
      String(a.id || '').localeCompare(String(b.id || ''))
    );
    const assessment = candidates[0] || null;
    const mark = assessment ? marksById.get(String(assessment.id)) || null : null;
    const maxMark = finite(assessment && assessment.max_mark) ??
      finite(mark && mark.max_mark) ?? column.max_mark ?? 100;
    const raw = mark ? finite(mark.mark) : null;
    const percent = raw === null || maxMark <= 0 ? null : (raw / maxMark) * 100;
    const includeInAverage =
      !(mark && mark.include_in_term_average === false) &&
      !(assessment && assessment.include_in_term_average === false);
    return {
      column_key: column.key,
      assessment_id: assessment ? assessment.id : null,
      name: assessment ? assessment.name : column.name,
      type: normalizeLabel(assessment && assessment.assessment_type) || column.type,
      cat: column.cat,
      max_mark: maxMark,
      mark: raw,
      percent,
      weight: finite(assessment && assessment.weight) ?? 0,
      include_in_term_average: includeInAverage,
      include_in_final: !(assessment && assessment.include_in_final === false),
      assessment_order: assessmentOrder(assessment || column)
    };
  });
}

function selectedProfileEntries(entries, profile) {
  const selectedIds = new Set(
    ((profile && profile.selected_assessment_ids) || []).map(String)
  );
  return entries.filter(entry =>
    entry.assessment_id != null && selectedIds.has(String(entry.assessment_id))
  );
}

function scoreSubject({ entries, profile }) {
  const available = (entries || []).filter(entry =>
    entry.percent !== null && entry.include_in_term_average !== false
  );
  if (!available.length) {
    return { average: null, basis: 'NO_MARKS', counted_keys: [] };
  }

  const chosen = profile ? selectedProfileEntries(available, profile) : [];
  if (chosen.length) {
    const mode = String(profile.cat_group_mode || 'INDIVIDUAL').toUpperCase();
    if (mode === 'CUSTOM') {
      const weights = profile.custom_weights || {};
      const weighted = chosen
        .map(entry => ({
          entry,
          weight: finite(weights[String(entry.assessment_id)]) ?? 0
        }))
        .filter(item => item.weight > 0);
      const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
      if (totalWeight > 0) {
        return {
          average: weighted.reduce(
            (sum, item) => sum + item.entry.percent * item.weight,
            0
          ) / totalWeight,
          basis: 'CUSTOM_WEIGHTS',
          counted_keys: weighted.map(item => item.entry.column_key)
        };
      }
      return {
        average: averageOf(chosen.map(entry => entry.percent)),
        basis: 'SELECTED_EQUAL_AVERAGE',
        counted_keys: chosen.map(entry => entry.column_key)
      };
    }
    if (mode === 'CAT_GROUP') {
      const main = chosen.filter(entry => !entry.cat).map(entry => entry.percent);
      const catAverage = averageOf(
        chosen.filter(entry => entry.cat).map(entry => entry.percent)
      );
      return {
        average: averageOf(catAverage === null ? main : [...main, catAverage]),
        basis: 'CAT_GROUP_AVERAGE',
        counted_keys: chosen.map(entry => entry.column_key)
      };
    }
    return {
      average: averageOf(chosen.map(entry => entry.percent)),
      basis: 'SELECTED_EQUAL_AVERAGE',
      counted_keys: chosen.map(entry => entry.column_key)
    };
  }

  const main = available.filter(entry =>
    !entry.cat && entry.include_in_final !== false
  );
  const pool = main.length ? main : available;
  return {
    average: averageOf(pool.map(entry => entry.percent)),
    basis: main.length ? 'DEFAULT_MAIN_EXAMS' : 'DEFAULT_ALL_EXAMS',
    counted_keys: pool.map(entry => entry.column_key)
  };
}

function compareDescending(a, b, valueOf) {
  const difference = valueOf(b) - valueOf(a);
  if (Math.abs(difference) > 1e-8) return difference;
  return String(a.learner_id).localeCompare(String(b.learner_id));
}

function computeRanks({
  learners,
  marks,
  assessments,
  profilesByClass,
  classes
}) {
  const classRecords = new Map(
    (classes || []).map(item => [String(item.id), item])
  );
  const profiles = profilesByClass instanceof Map
    ? profilesByClass
    : new Map(Object.entries(profilesByClass || {}));
  const marksByLearner = new Map();
  for (const mark of marks || []) {
    const key = String(mark.learner_id);
    if (!marksByLearner.has(key)) marksByLearner.set(key, []);
    marksByLearner.get(key).push(mark);
  }

  const columnsByClass = new Map();
  const indexByClass = new Map();
  const columnsFor = classId => {
    const key = String(classId);
    if (!columnsByClass.has(key)) {
      columnsByClass.set(key, buildExamColumns(assessments, classId));
      indexByClass.set(key, buildAssessmentIndex(assessments, classId));
    }
    return {
      columns: columnsByClass.get(key),
      index: indexByClass.get(key)
    };
  };

  const rows = [];
  for (const learner of learners || []) {
    const learnerId = learner.learner_id == null ? learner.id : learner.learner_id;
    if (learnerId == null) continue;
    const learnerMarks = marksByLearner.get(String(learnerId)) || [];
    const classId = learner.class_id ??
      (learnerMarks[0] && learnerMarks[0].class_id) ?? null;
    const classRecord = classRecords.get(String(classId));
    const { columns, index } = columnsFor(classId);
    const marksBySubject = new Map();
    for (const mark of learnerMarks) {
      const key = String(mark.subject_id);
      if (!marksBySubject.has(key)) marksBySubject.set(key, []);
      marksBySubject.get(key).push(mark);
    }
    const subjects = [];
    for (const [subjectId, subjectMarks] of marksBySubject) {
      const entries = subjectEntries(
        subjectMarks, assessments, classId, subjectId, columns, index
      );
      const result = scoreSubject({
        entries,
        profile: profiles.get(String(classId)) || null
      });
      if (result.average !== null) {
        subjects.push({
          subject_id: subjectId,
          average: result.average,
          basis: result.basis
        });
      }
    }
    rows.push({
      learner_id: learnerId,
      class_id: classId,
      class_name: String(
        (classRecord && classRecord.name) || learner.class_name || ''
      ),
      subjects,
      overall_average: averageOf(subjects.map(item => item.average))
    });
  }

  const subjectPartitions = new Map();
  for (const row of rows) {
    for (const subject of row.subjects) {
      const key = `${row.class_id}|${subject.subject_id}`;
      if (!subjectPartitions.has(key)) subjectPartitions.set(key, []);
      subjectPartitions.get(key).push({ row, subject });
    }
  }
  for (const items of subjectPartitions.values()) {
    items.sort((a, b) =>
      b.subject.average - a.subject.average ||
      String(a.row.learner_id).localeCompare(String(b.row.learner_id))
    );
    let rank = 0;
    let previous = null;
    items.forEach((item, index) => {
      if (previous === null || Math.abs(item.subject.average - previous) > 1e-8) {
        rank = index + 1;
        previous = item.subject.average;
      }
      item.rank = rank;
    });
    for (const item of items) {
      item.row.subject_ranks = item.row.subject_ranks || {};
      item.row.subject_ranks[String(item.subject.subject_id)] = {
        rank: item.rank,
        total: items.length
      };
    }
  }

  const rankPartition = (keyOf, rankField, totalField) => {
    const partitions = new Map();
    for (const row of rows) {
      if (row.overall_average === null) continue;
      const key = keyOf(row);
      if (!partitions.has(key)) partitions.set(key, []);
      partitions.get(key).push(row);
    }
    for (const partition of partitions.values()) {
      partition.sort((a, b) => compareDescending(a, b, row => row.overall_average));
      // Tied averages share a position so printed ranks never contradict the
      // identical averages shown beside them.
      let rank = 0;
      let previous = null;
      partition.forEach((row, index) => {
        if (previous === null || Math.abs(row.overall_average - previous) > 1e-8) {
          rank = index + 1;
          previous = row.overall_average;
        }
        row[rankField] = rank;
        row[totalField] = partition.length;
      });
    }
  };
  rankPartition(row => String(row.class_id), 'stream_rank', 'stream_rank_total');
  rankPartition(row => row.class_name, 'class_rank', 'class_rank_total');

  return new Map(rows.map(row => [String(row.learner_id), row]));
}

module.exports = {
  averageOf,
  buildExamColumns,
  buildAssessmentIndex,
  subjectEntries,
  scoreSubject,
  computeRanks,
  isCatAssessment,
  assessmentKey
};
