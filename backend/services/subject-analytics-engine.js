'use strict';

function gradeFor(mark, bands) {
  const score = Number(mark);
  if (!Number.isFinite(score)) return null;
  return bands.find(band =>
    score >= Number(band.min_mark) && score <= Number(band.max_mark)
  )?.label || null;
}

function scopeScore(config, context) {
  const dimensions = [
    ['subject_id', context.subject_id, 100],
    ['assessment_id', context.assessment_id, 50],
    ['class_id', context.class_id, 20],
    ['level_id', context.level_id, 10],
    ['section_id', context.section_id, 5]
  ];
  let score = 0;
  for (const [key, value, weight] of dimensions) {
    if (config[key] && String(config[key]) !== String(value || '')) return -1;
    if (config[key]) score += weight;
  }
  return score;
}

function applicableConfig(configs, context) {
  return configs
    .map(config => ({config, score: scopeScore(config, context)}))
    .filter(row => row.score >= 0)
    .sort((a, b) => b.score - a.score ||
      String(a.config.grading_system_id || '').localeCompare(String(b.config.grading_system_id || ''))
    )[0]?.config || null;
}

function analyzeSubjectPerformance({classes, roster, assignments, marks, configs, trends, assessmentId}) {
  const classById = new Map(classes.map(row => [String(row.id), row]));
  const learnersByClass = new Map();
  const learnerByClassAndId = new Map();
  for (const learner of roster) {
    const key = String(learner.class_id);
    learnerByClassAndId.set(`${key}:${learner.id}`, learner);
    if (!learnersByClass.has(key)) learnersByClass.set(key, []);
    learnersByClass.get(key).push(learner);
  }

  const pairs = new Map();
  const ensurePair = (classId, subjectId, subjectName, subjectCode) => {
    const key = `${classId}:${subjectId}`;
    if (!pairs.has(key)) pairs.set(key, {
      class_id: String(classId),
      subject_id: String(subjectId),
      subject_name: subjectName,
      subject_code: subjectCode || '',
      learners: new Map()
    });
    return pairs.get(key);
  };

  for (const assignment of assignments) {
    if (!classById.has(String(assignment.class_id))) continue;
    ensurePair(assignment.class_id, assignment.subject_id, assignment.subject_name, assignment.subject_code);
  }

  const markGroups = new Map();
  for (const mark of marks) {
    if (!classById.has(String(mark.class_id))) continue;
    const pair = ensurePair(mark.class_id, mark.subject_id, mark.subject_name, mark.subject_code);
    const learner = learnerByClassAndId.get(`${mark.class_id}:${mark.learner_id}`);
    if (!learner) continue;
    const key = `${mark.class_id}:${mark.subject_id}:${mark.learner_id}`;
    if (!markGroups.has(key)) markGroups.set(key, {pair, learner, marks: []});
    const maximum = Number(mark.max_mark);
    const value = Number(mark.mark);
    if (Number.isFinite(value) && Number.isFinite(maximum) && maximum > 0) {
      markGroups.get(key).marks.push({
        assessment_id: String(mark.assessment_id),
        assessment_name: mark.assessment_name,
        assessment_type: mark.assessment_type,
        mark: value,
        max_mark: maximum,
        percentage: value * 100 / maximum
      });
    }
  }

  const learnerSubjectRows = [];
  for (const [key, pair] of pairs) {
    const classInfo = classById.get(pair.class_id);
    const expectedLearners = learnersByClass.get(pair.class_id) || [];
    for (const learner of expectedLearners) {
      const groupKey = `${pair.class_id}:${pair.subject_id}:${learner.id}`;
      const group = markGroups.get(groupKey);
      if (!group || !group.marks.length) continue;
      const average = group.marks.reduce((sum, item) => sum + item.percentage, 0) / group.marks.length;
      const context = {
        class_id: pair.class_id,
        level_id: classInfo.school_level_id,
        section_id: classInfo.section_id,
        subject_id: pair.subject_id,
        assessment_id: assessmentId || null
      };
      const config = applicableConfig(configs, context);
      const bands = config?.bands || [];
      const row = {
        learner_id: String(learner.id),
        learner_name: learner.learner_name,
        admission_no: learner.admission_no,
        class_id: pair.class_id,
        class_name: classInfo.name,
        stream: classInfo.stream || '',
        subject_id: pair.subject_id,
        subject_name: pair.subject_name,
        average,
        grade: gradeFor(average, bands),
        assessments: group.marks
      };
      learnerSubjectRows.push(row);
      pair.learners.set(String(learner.id), row);
    }
  }

  const subjects = new Map();
  for (const pair of pairs.values()) {
    const classInfo = classById.get(pair.class_id);
    const context = {
      class_id: pair.class_id,
      level_id: classInfo.school_level_id,
      section_id: classInfo.section_id,
      subject_id: pair.subject_id,
      assessment_id: assessmentId || null
    };
    const config = applicableConfig(configs, context);
    if (!subjects.has(pair.subject_id)) {
      subjects.set(pair.subject_id, {
        id: pair.subject_id,
        code: pair.subject_code,
        name: pair.subject_name,
        expected: 0,
        assessed: 0,
        values: [],
        grade_counts: {},
        bands: new Map(),
        class_values: new Map(),
        target_values: []
      });
    }
    const summary = subjects.get(pair.subject_id);
    for (const band of config?.bands || []) {
      if (!summary.bands.has(band.label)) summary.bands.set(band.label, band);
    }
    const expectedLearners = learnersByClass.get(pair.class_id) || [];
    summary.expected += expectedLearners.length;
    for (const learner of expectedLearners) {
      const row = pair.learners.get(String(learner.id));
      if (!row) continue;
      summary.assessed++;
      summary.values.push(row.average);
      if (row.grade) summary.grade_counts[row.grade] = (summary.grade_counts[row.grade] || 0) + 1;
      if (!summary.class_values.has(pair.class_id)) summary.class_values.set(pair.class_id, []);
      summary.class_values.get(pair.class_id).push(row.average);
    }
    const targetConfig = applicableConfig(configs.filter(item => item.target_mark != null), context);
    if (targetConfig && expectedLearners.length) {
      summary.target_values.push({value: Number(targetConfig.target_mark), weight: expectedLearners.length});
    }
  }

  const subjectRows = [...subjects.values()].map(subject => {
    const mean = subject.values.length
      ? subject.values.reduce((sum, value) => sum + value, 0) / subject.values.length
      : null;
    const targetWeight = subject.target_values.reduce((sum, item) => sum + item.weight, 0);
    const target = targetWeight
      ? subject.target_values.reduce((sum, item) => sum + item.value * item.weight, 0) / targetWeight
      : null;
    return {
      id: subject.id,
      code: subject.code,
      name: subject.name,
      average: mean,
      highest: subject.values.length ? subject.values.reduce((high, value) => Math.max(high, value), -Infinity) : null,
      lowest: subject.values.length ? subject.values.reduce((low, value) => Math.min(low, value), Infinity) : null,
      assessed: subject.assessed,
      expected: subject.expected,
      not_assessed: Math.max(0, subject.expected - subject.assessed),
      coverage: subject.expected ? subject.assessed * 100 / subject.expected : null,
      target,
      target_variance: mean == null || target == null ? null : mean - target,
      grade_counts: subject.grade_counts,
      grade_bands: [...subject.bands.values()],
      classes: [...subject.class_values.entries()].map(([classId, values]) => ({
        class_id: classId,
        class_name: classById.get(classId)?.name || '',
        stream: classById.get(classId)?.stream || '',
        assessed: values.length,
        average: values.reduce((sum, value) => sum + value, 0) / values.length
      })).sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity))
    };
  }).sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity));

  const assessedCount = new Set(learnerSubjectRows.map(row => row.learner_id)).size;
  const assessedPairs = learnerSubjectRows.length;
  const enrollmentFallbackCount = roster.filter(row => row.roster_source === 'MARKS_FALLBACK').length;
  const allValues = learnerSubjectRows.map(row => row.average);
  const trendGroups = new Map();
  for (const row of trends) {
    const key = `${row.academic_year_id}:${row.term_id}:${row.subject_id}`;
    if (!trendGroups.has(key)) trendGroups.set(key, {
      academic_year_id: row.academic_year_id,
      year_label: row.year_label,
      term_id: row.term_id,
      term_name: row.term_name,
      term_no: row.term_no ?? Number((/(\d+)/.exec(String(row.term_name || '')) || [])[1] || 0),
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      values: [],
      assessed: 0
    });
    const max = row.max_mark == null ? 100 : Number(row.max_mark);
    const mark = row.mark == null ? Number(row.average) : Number(row.mark);
    if (Number.isFinite(max) && max > 0 && Number.isFinite(mark)) {
      trendGroups.get(key).values.push(mark * 100 / max);
      trendGroups.get(key).assessed += Number(row.assessed) || 1;
    }
  }
  const trendRows = [...trendGroups.values()].map(row => ({
    academic_year_id: row.academic_year_id,
    year_label: row.year_label,
    term_id: row.term_id,
    term_name: row.term_name,
    term_no: row.term_no,
    subject_id: row.subject_id,
    subject_name: row.subject_name,
    average: row.values.length ? row.values.reduce((sum, value) => sum + value, 0) / row.values.length : null,
    assessed: row.assessed
  })).sort((a, b) =>
    String(a.year_label).localeCompare(String(b.year_label), undefined, {numeric: true}) ||
    Number(a.term_no || 0) - Number(b.term_no || 0)
  );

  const flags = [];
  for (const subject of subjectRows) {
    if (subject.assessed > 0 && subject.assessed < 5) {
      flags.push({type: 'SMALL_SAMPLE', subject_id: subject.id, subject_name: subject.name, message: `${subject.assessed} learner(s) assessed; interpret this average cautiously.`});
    }
    if (subject.not_assessed > 0) {
      flags.push({type: 'MISSING_MARKS', subject_id: subject.id, subject_name: subject.name, message: `${subject.not_assessed} of ${subject.expected} expected learner(s) have no recorded mark.`});
    }
    if (subject.target != null && subject.average != null && subject.average < subject.target) {
      flags.push({type: 'BELOW_TARGET', subject_id: subject.id, subject_name: subject.name, message: `Mean is ${Math.abs(subject.target_variance).toFixed(1)} points below the configured target.`});
    }
  }

  return {
    overall: {
      subjects: subjectRows.length,
      assessed_learners: assessedCount,
      mean: allValues.length ? allValues.reduce((sum, value) => sum + value, 0) / allValues.length : null,
      expected_subject_learners: subjectRows.reduce((sum, subject) => sum + subject.expected, 0),
      coverage: subjectRows.reduce((sum, subject) => sum + subject.expected, 0)
        ? assessedPairs * 100 / subjectRows.reduce((sum, subject) => sum + subject.expected, 0)
        : null
    },
    subjects: subjectRows,
    learners: learnerSubjectRows.sort((a, b) =>
      a.subject_name.localeCompare(b.subject_name) || a.learner_name.localeCompare(b.learner_name)
    ),
    enrollment_fallback_count: enrollmentFallbackCount,
    trends: trendRows,
    interventions: flags
  };
}

module.exports = {analyzeSubjectPerformance, gradeFor};
